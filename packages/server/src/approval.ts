import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import {
  configFixSchema,
  recordRun,
  redactSecrets,
  type IncidentRow,
  type ProposalRow
} from '@crontrol/shared';
import { validateSafeFix } from './sentinel.js';

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

export async function approveIncident(db: Database.Database, incidentId: number) {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ? AND status = 'proposed'").get(incidentId) as IncidentRow | undefined;
  if (!incident) throw new ApprovalError(404, 'Proposed incident not found.');
  const proposal = db.prepare("SELECT * FROM proposals WHERE incident_id = ? AND model = 'gpt-5.6' ORDER BY created_at DESC LIMIT 1").get(incidentId) as ProposalRow | undefined;
  if (!proposal) throw new ApprovalError(409, 'No GPT-5.6 proposal is available to approve.');
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(incident.job_id) as ApprovalJob | undefined;
  if (!job) throw new ApprovalError(404, 'Job not found.');
  if (proposal.fix_kind === 'command' && proposal.fix_body.trim() === job.command.trim()) {
    throw new ApprovalError(422, 'The proposed command is identical to the current command and cannot fix this incident. Dismiss it or wait for a revised diagnosis.');
  }
  validateSafeFix(proposal.fix_body);
  const originalCommand = job.command;

  let fixResult: ProcessResult | null = null;
  try {
    if (proposal.fix_kind === 'patch') {
      const check = await spawnCapture('git', ['apply', '--check', '-'], job.cwd, proposal.fix_body);
      if (check.exitCode !== 0) throw new Error(`Patch validation failed: ${check.output}`);
      fixResult = await spawnCapture('git', ['apply', '-'], job.cwd, proposal.fix_body);
      if (fixResult.exitCode !== 0) throw new Error(`Patch application failed: ${fixResult.output}`);
    } else if (proposal.fix_kind === 'config') {
      const config = configFixSchema.parse(JSON.parse(proposal.fix_body));
      const destination = safeConfigPath(job.cwd, config.path);
      writeFileSync(destination, config.content, 'utf8');
      fixResult = syntheticResult(`Wrote ${config.path}`);
    } else {
      db.prepare('UPDATE jobs SET command = ? WHERE id = ?').run(proposal.fix_body, job.id);
      job.command = proposal.fix_body;
      fixResult = syntheticResult(`Updated job command to: ${proposal.fix_body}`);
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    db.prepare('UPDATE proposals SET applied_at = ?, apply_result = ? WHERE id = ?')
      .run(new Date().toISOString(), JSON.stringify({ fix: { ok: false, output: message } }), proposal.id);
    throw new ApprovalError(422, message);
  }

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
  const now = new Date().toISOString();
  const applyResult = JSON.stringify({
    fix: { ok: true, output: fixResult.output },
    rerun: { runId, exitCode: rerun.exitCode, output: rerun.output }
  });
  const save = db.transaction(() => {
    db.prepare('UPDATE proposals SET applied_at = ?, apply_result = ? WHERE id = ?').run(now, applyResult, proposal.id);
    if (rerun.exitCode === 0) {
      db.prepare("UPDATE incidents SET status = 'applied', closed_at = ? WHERE id = ?").run(now, incidentId);
    } else {
      if (proposal.fix_kind === 'command') db.prepare('UPDATE jobs SET command = ? WHERE id = ?').run(originalCommand, job.id);
      db.prepare("UPDATE incidents SET status = 'open', run_id = ?, closed_at = NULL WHERE id = ?").run(runId, incidentId);
    }
  });
  save();
  return { incidentId, proposalId: proposal.id, runId, exitCode: rerun.exitCode, closed: rerun.exitCode === 0, applyResult: JSON.parse(applyResult) };
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
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
