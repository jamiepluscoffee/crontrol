import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import {
  configFixSchema,
  recordRun,
  redactSecrets,
  type IncidentRow,
  type ProposalRow
} from '@crontrol/shared';
import { validateSafeFix } from './sentinel.js';
import { childProcessEnvironment } from './environment.js';

interface ApprovalJob {
  id: number;
  name: string;
  command: string;
  cwd: string;
  description: string | null;
  expected_interval_s: number | null;
  grace_s: number | null;
}

interface ProcessResult {
  exitCode: number;
  output: string;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

export async function approveIncident(db: Database.Database, incidentId: number, appliedBy: 'human' | 'auto' = 'human') {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ? AND status = 'proposed'").get(incidentId) as IncidentRow | undefined;
  if (!incident) throw new ApprovalError(404, 'Proposed incident not found.');
  const proposal = db.prepare("SELECT * FROM proposals WHERE incident_id = ? AND model = 'gpt-5.6' ORDER BY created_at DESC LIMIT 1").get(incidentId) as ProposalRow | undefined;
  if (!proposal) throw new ApprovalError(409, 'No GPT-5.6 proposal is available to approve.');
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(incident.job_id) as ApprovalJob | undefined;
  if (!job) throw new ApprovalError(404, 'Job not found.');
  if (job.command.startsWith('remote:')) throw new ApprovalError(409, 'Remote ping jobs are diagnosis-only; apply this fix on the system that owns the job.');
  if (proposal.fix_kind === 'command') throw new ApprovalError(409, 'Command fixes require manual application because Crontrol does not own the scheduler definition.');
  validateSafeFix(proposal.fix_body);

  let fixResult: ProcessResult | null = null;
  let rollback: (() => Promise<ProcessResult>) | null = null;
  try {
    if (proposal.fix_kind === 'patch') {
      const check = await spawnCapture('git', ['apply', '--check', '-'], job.cwd, proposal.fix_body);
      if (check.exitCode !== 0) throw new Error(`Patch validation failed: ${check.output}`);
      fixResult = await spawnCapture('git', ['apply', '-'], job.cwd, proposal.fix_body);
      if (fixResult.exitCode !== 0) throw new Error(`Patch application failed: ${fixResult.output}`);
      rollback = () => spawnCapture('git', ['apply', '--reverse', '-'], job.cwd, proposal.fix_body);
    } else if (proposal.fix_kind === 'config') {
      const config = configFixSchema.parse(JSON.parse(proposal.fix_body));
      const destination = safeConfigPath(job.cwd, config.path);
      const existed = existsSync(destination);
      const previous = existed ? readFileSync(destination) : null;
      writeFileSync(destination, config.content, 'utf8');
      fixResult = syntheticResult(`Wrote ${config.path}`);
      rollback = async () => {
        if (previous) writeFileSync(destination, previous); else if (!existed && existsSync(destination)) unlinkSync(destination);
        return syntheticResult(`Restored ${config.path}`);
      };
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    db.prepare('UPDATE proposals SET applied_at = ?, apply_result = ? WHERE id = ?')
      .run(new Date().toISOString(), JSON.stringify({ appliedBy, fix: { ok: false, output: message } }), proposal.id);
    throw new ApprovalError(422, message);
  }
  if (!fixResult) throw new ApprovalError(422, 'No durable fix was applied.');

  const rerun = await spawnCapture('/bin/sh', ['-c', job.command], job.cwd);
  const runId = recordRun(db, {
    name: job.name,
    command: job.command,
    cwd: job.cwd,
    description: job.description,
    expectedIntervalS: job.expected_interval_s,
    graceS: job.grace_s,
    startedAt: rerun.startedAt,
    endedAt: rerun.endedAt,
    exitCode: rerun.exitCode,
    durationMs: rerun.durationMs,
    logTail: rerun.output,
    source: 'api'
  });
  const rollbackResult = appliedBy === 'auto' && rerun.exitCode !== 0 && rollback ? await rollback() : null;
  const now = new Date().toISOString();
  const applyResult = JSON.stringify({
    appliedBy,
    fix: { ok: true, output: fixResult.output },
    rerun: { runId, exitCode: rerun.exitCode, output: rerun.output },
    ...(rollbackResult ? { rollback: { ok: rollbackResult.exitCode === 0, output: rollbackResult.output } } : {})
  });
  const save = db.transaction(() => {
    db.prepare('UPDATE proposals SET applied_at = ?, apply_result = ? WHERE id = ?').run(now, applyResult, proposal.id);
    if (rerun.exitCode === 0) {
      db.prepare("UPDATE incidents SET status = 'applied', closed_at = ? WHERE id = ?").run(now, incidentId);
    } else {
      db.prepare("UPDATE incidents SET status = 'open', run_id = ?, closed_at = NULL WHERE id = ?").run(runId, incidentId);
    }
  });
  save();
  return { incidentId, proposalId: proposal.id, runId, exitCode: rerun.exitCode, closed: rerun.exitCode === 0, applyResult: JSON.parse(applyResult) };
}

export function autoFixEligibility(db: Database.Database, incidentId: number): { eligible: boolean; reason: string } {
  const candidate = db.prepare(`
    SELECT i.status, i.kind, j.command, p.model, p.fix_kind, p.risk, p.confidence,
      p.review_verified, p.applied_at, p.dismiss_reason
    FROM incidents i
    JOIN jobs j ON j.id = i.job_id
    LEFT JOIN proposals p ON p.id = (
      SELECT id FROM proposals WHERE incident_id = i.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE i.id = ?
  `).get(incidentId) as {
    status: string; kind: string; command: string; model: string | null; fix_kind: string | null;
    risk: string | null; confidence: number | null; review_verified: number | null;
    applied_at: string | null; dismiss_reason: string | null;
  } | undefined;
  if (!candidate) return { eligible: false, reason: 'Incident not found.' };
  if (candidate.status !== 'proposed') return { eligible: false, reason: 'The incident is not awaiting a proposal decision.' };
  if (candidate.kind !== 'failure') return { eligible: false, reason: 'Only concrete failed runs are eligible for auto fix.' };
  if (candidate.model !== 'gpt-5.6') return { eligible: false, reason: 'A complete GPT-5.6 proposal is required.' };
  if (candidate.command.startsWith('remote:')) return { eligible: false, reason: 'Remote jobs remain diagnosis-only.' };
  if (candidate.fix_kind !== 'patch' && candidate.fix_kind !== 'config') return { eligible: false, reason: 'Command changes always require manual application.' };
  if (candidate.risk !== 'low') return { eligible: false, reason: 'Only low-risk proposals are eligible.' };
  if ((candidate.confidence ?? 0) < 0.95) return { eligible: false, reason: 'At least 95% confidence is required.' };
  if (candidate.review_verified !== 1) return { eligible: false, reason: 'The skeptic pass must verify the proposal.' };
  if (candidate.applied_at || candidate.dismiss_reason) return { eligible: false, reason: 'The proposal has already been handled.' };
  return { eligible: true, reason: 'Low-risk, high-confidence durable fix verified by the skeptic pass.' };
}

export function dismissIncident(db: Database.Database, incidentId: number, reason: string) {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ? AND status IN ('open', 'proposed')").get(incidentId) as IncidentRow | undefined;
  if (!incident) throw new ApprovalError(404, 'Open incident not found.');
  const now = new Date().toISOString();
  const dismiss = db.transaction(() => {
    db.prepare("UPDATE incidents SET status = 'dismissed', closed_at = ? WHERE id = ?").run(now, incidentId);
    db.prepare(`
      UPDATE proposals SET dismiss_reason = ?, apply_result = ?
      WHERE id = (SELECT id FROM proposals WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1)
    `).run(reason, JSON.stringify({ dismissed: true, reason }), incidentId);
  });
  dismiss();
  return { incidentId, status: 'dismissed' as const, reason, closedAt: now };
}

export class ApprovalError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

async function spawnCapture(command: string, args: string[], cwd: string, input?: string): Promise<ProcessResult> {
  const startedAt = new Date();
  const startedClock = performance.now();
  const chunks: Buffer[] = [];
  const child = spawn(command, args, { cwd, env: childProcessEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  if (input === undefined) child.stdin?.end(); else child.stdin?.end(input);
  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('error', (error) => { chunks.push(Buffer.from(error.message)); resolveExit(127); });
    child.on('close', (code) => resolveExit(code ?? 1));
  });
  const endedAt = new Date();
  return {
    exitCode,
    output: redactSecrets(Buffer.concat(chunks).toString('utf8').trim()).split(/\r?\n/).slice(-200).join('\n'),
    durationMs: Math.max(0, Math.round(performance.now() - startedClock)),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString()
  };
}

function safeConfigPath(cwd: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Config fix path must be relative to the job cwd.');
  const root = realpathSync(resolve(cwd));
  const destination = resolve(root, path);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error('Config fix path escapes the job cwd.');
  const resolvedTarget = existsSync(destination) ? realpathSync(destination) : realpathSync(dirname(destination));
  if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
    throw new Error('Config fix path resolves outside the job cwd.');
  }
  return destination;
}

function syntheticResult(output: string): ProcessResult {
  const now = new Date().toISOString();
  return { exitCode: 0, output, durationMs: 0, startedAt: now, endedAt: now };
}
