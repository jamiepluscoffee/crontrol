import type Database from 'better-sqlite3';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  diagnosisSchema,
  redactSecrets,
  skepticReviewSchema,
  type Diagnosis,
  type IncidentRow,
  type SkepticReview
} from '@crontrol/shared';
import { childProcessEnvironment } from './environment.js';

export interface IncidentContext {
  incident: IncidentRow;
  job: {
    id: number;
    name: string;
    command: string;
    cwd: string;
    description: string | null;
    expected_interval_s: number | null;
    grace_s: number | null;
  };
  failing_run: RunEvidence | null;
  last_successful_run: RunEvidence | null;
  command_diff: string | null;
  related_files: Array<{ path: string; content: string }>;
  recent_runs: Array<{ exit_code: number; duration_ms: number; started_at: string }>;
}

interface RunEvidence {
  id: number;
  started_at: string;
  ended_at: string;
  exit_code: number;
  duration_ms: number;
  log_tail: string;
}

export interface SentinelModel {
  diagnose(contextJson: string): Promise<Diagnosis>;
  review(contextJson: string, diagnosis: Diagnosis): Promise<SkepticReview>;
}

export class OpenAISentinelModel implements SentinelModel {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 14_000, maxRetries: 0 });
  }

  async diagnose(contextJson: string): Promise<Diagnosis> {
    const response = await this.client.responses.parse({
      model: 'gpt-5.6',
      store: false,
      reasoning: { effort: 'low' },
      instructions: DIAGNOSIS_PROMPT,
      input: contextJson,
      text: { format: zodTextFormat(diagnosisSchema, 'crontrol_diagnosis') }
    });
    if (!response.output_parsed) throw new Error('GPT-5.6 returned no structured diagnosis.');
    return diagnosisSchema.parse(response.output_parsed);
  }

  async review(contextJson: string, diagnosis: Diagnosis): Promise<SkepticReview> {
    const response = await this.client.responses.parse({
      model: 'gpt-5.6',
      store: false,
      reasoning: { effort: 'low' },
      instructions: REVIEW_PROMPT,
      input: JSON.stringify({ context: JSON.parse(contextJson), proposed_diagnosis: diagnosis }),
      text: { format: zodTextFormat(skepticReviewSchema, 'crontrol_skeptic_review') }
    });
    if (!response.output_parsed) throw new Error('GPT-5.6 returned no structured review.');
    return skepticReviewSchema.parse(response.output_parsed);
  }
}

export class Sentinel {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly db: Database.Database,
    private readonly onChange: () => void,
    private readonly model: SentinelModel | null = process.env.OPENAI_API_KEY ? new OpenAISentinelModel(process.env.OPENAI_API_KEY) : null
  ) {}

  schedule(incidentId: number): void {
    if (this.inFlight.has(incidentId)) return;
    this.inFlight.add(incidentId);
    void this.diagnoseIncident(incidentId)
      .catch((error: unknown) => this.storeUnavailable(incidentId, 'error', `Diagnosis could not complete: ${redactSecrets(error instanceof Error ? error.message : String(error))}`))
      .finally(() => {
        this.inFlight.delete(incidentId);
        this.onChange();
      });
  }

  schedulePending(): void {
    const incidents = this.db.prepare("SELECT id FROM incidents WHERE status IN ('open', 'proposed')").all() as { id: number }[];
    for (const incident of incidents) this.schedule(incident.id);
  }

  async diagnoseIncident(incidentId: number): Promise<void> {
    const existing = this.db.prepare('SELECT model, applied_at FROM proposals WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1').get(incidentId) as { model: string; applied_at: string | null } | undefined;
    if (existing?.model === 'gpt-5.6' && !existing.applied_at) return;
    if (!this.model) {
      this.storeUnavailable(incidentId, 'unavailable', 'Add OPENAI_API_KEY to the environment and restart `ct up` to enable GPT-5.6 diagnosis. Monitoring remains fully functional.');
      return;
    }

    const context = buildIncidentContext(this.db, incidentId);
    if (!context) return;
    const contextJson = serializeIncidentContext(context);
    let diagnosis = diagnosisSchema.parse(await this.model.diagnose(contextJson));
    if (diagnosis.fix.kind === 'patch') {
      diagnosis = { ...diagnosis, fix: { ...diagnosis.fix, body: normalizeUnifiedDiff(diagnosis.fix.body) } };
      validatePatch(context.job.cwd, diagnosis.fix.body);
    }
    validateDiagnosisEvidence(context, diagnosis);
    validateSafeFix(diagnosis.fix.body);
    const review = skepticReviewSchema.parse(await this.model.review(contextJson, diagnosis));

    const save = this.db.transaction(() => {
      this.db.prepare('DELETE FROM proposals WHERE incident_id = ?').run(incidentId);
      this.db.prepare(`
        INSERT INTO proposals (
          incident_id, created_at, model, root_cause, evidence_json, fix_kind, fix_body,
          fix_explanation, risk, confidence, review_verdict, review_verified,
          applied_at, apply_result, dismiss_reason
        ) VALUES (?, ?, 'gpt-5.6', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        incidentId,
        new Date().toISOString(),
        diagnosis.root_cause,
        JSON.stringify(diagnosis.evidence),
        diagnosis.fix.kind,
        diagnosis.fix.body,
        diagnosis.fix.explanation,
        diagnosis.risk,
        diagnosis.confidence,
        review.objection ? `${review.verdict} Objection: ${review.objection}` : review.verdict,
        review.verified ? 1 : 0
      );
      this.db.prepare("UPDATE incidents SET status = 'proposed' WHERE id = ? AND status = 'open'").run(incidentId);
    });
    save();
  }

  private storeUnavailable(incidentId: number, model: 'unavailable' | 'error', message: string): void {
    const incident = this.db.prepare('SELECT id FROM incidents WHERE id = ?').get(incidentId);
    if (!incident) return;
    this.db.prepare('DELETE FROM proposals WHERE incident_id = ?').run(incidentId);
    this.db.prepare(`
      INSERT INTO proposals (
        incident_id, created_at, model, root_cause, evidence_json, fix_kind, fix_body,
        fix_explanation, risk, confidence, review_verdict, review_verified,
        applied_at, apply_result, dismiss_reason
      ) VALUES (?, ?, ?, ?, '[]', 'config', 'export OPENAI_API_KEY=your-key',
        'Configure the API key before starting the server.', 'low', 0, NULL, NULL, NULL, NULL, NULL)
    `).run(incidentId, new Date().toISOString(), model, message);
  }
}

export function buildIncidentContext(db: Database.Database, incidentId: number): IncidentContext | null {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId) as IncidentRow | undefined;
  if (!incident) return null;
  const job = db.prepare(`
    SELECT id, name, command, cwd, description, expected_interval_s, grace_s
    FROM jobs WHERE id = ?
  `).get(incident.job_id) as IncidentContext['job'] | undefined;
  if (!job) return null;
  const failingRun = incident.run_id
    ? db.prepare('SELECT id, started_at, ended_at, exit_code, duration_ms, log_tail FROM runs WHERE id = ?').get(incident.run_id) as RunEvidence | undefined
    : undefined;
  const lastSuccess = db.prepare(`
    SELECT id, started_at, ended_at, exit_code, duration_ms, log_tail
    FROM runs WHERE job_id = ? AND exit_code = 0 AND id != COALESCE(?, -1)
    ORDER BY started_at DESC LIMIT 1
  `).get(job.id, incident.run_id) as RunEvidence | undefined;
  const recentRuns = db.prepare(`
    SELECT exit_code, duration_ms, started_at FROM runs
    WHERE job_id = ? ORDER BY started_at DESC LIMIT 10
  `).all(job.id) as IncidentContext['recent_runs'];
  return {
    incident,
    job,
    failing_run: failingRun ?? null,
    last_successful_run: lastSuccess ?? null,
    command_diff: null,
    related_files: collectRelatedFiles(job.cwd, job.command),
    recent_runs: recentRuns
  };
}

function collectRelatedFiles(cwd: string, command: string): Array<{ path: string; content: string }> {
  const root = realpathSync(resolve(cwd));
  const candidates = [...command.matchAll(/(?:^|\s)(\.{0,2}\/[A-Za-z0-9_./-]+)/gu)].map((match) => match[1]);
  const files: Array<{ path: string; content: string }> = [];
  for (const candidate of [...new Set(candidates)]) {
    const absolute = resolve(root, candidate);
    if (!existsSync(absolute)) continue;
    const real = realpathSync(absolute);
    if (real !== root && !real.startsWith(`${root}${sep}`)) continue;
    if (!statSync(real).isFile() || statSync(real).size > 32_000) continue;
    files.push({ path: relative(root, real), content: readFileSync(real, 'utf8') });
  }
  return files;
}

export function serializeIncidentContext(context: IncidentContext): string {
  return redactSecrets(JSON.stringify(context));
}

function validateDiagnosisEvidence(context: IncidentContext, diagnosis: Diagnosis): void {
  const logs = [context.failing_run?.log_tail, context.last_successful_run?.log_tail].filter(Boolean).join('\n');
  if (!diagnosis.evidence.some((item) => logs.includes(item.line))) {
    throw new Error('GPT-5.6 proposal did not cite an actual supplied log line.');
  }
}

export function validateSafeFix(body: string): void {
  const destructive = [
    /(^|[;&|]\s*)rm\s/iu,
    /\bsudo\b/iu,
    /\b(drop|truncate)\s+(database|table)\b/iu,
    /git\s+push[^\n]*--force/iu,
    />\s*\/etc\//iu
  ];
  if (destructive.some((pattern) => pattern.test(body))) throw new Error('Unsafe or destructive proposed fix was rejected.');
}

export function normalizeUnifiedDiff(patch: string): string {
  const lines = patch.replace(/\r\n/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(lines[index]);
    if (!match) continue;
    let oldCount = 0;
    let newCount = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
      if (line.startsWith('\\ No newline')) continue;
      if (line.startsWith(' ') || line.startsWith('-')) oldCount += 1;
      if (line.startsWith(' ') || line.startsWith('+')) newCount += 1;
    }
    lines[index] = `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`;
  }
  return lines.join('\n');
}

function validatePatch(cwd: string, patch: string): void {
  const result = spawnSync('git', ['apply', '--check', '-'], {
    cwd,
    env: childProcessEnvironment(),
    input: patch,
    encoding: 'utf8',
    maxBuffer: 256_000
  });
  if (result.status !== 0) throw new Error(`GPT-5.6 proposed a patch that does not apply cleanly: ${redactSecrets(result.stderr || result.stdout)}`);
}

const DIAGNOSIS_PROMPT = `You are Crontrol's incident sentinel. Diagnose only from the supplied JSON evidence.
Return the required structured object. The root cause must name the mechanism in one plain-language paragraph.
Every evidence item must quote an exact complete line from one of the supplied log_tail fields.
If evidence is insufficient, say that clearly and propose the single most informative non-destructive diagnostic command.
Never propose rm, DROP, force-push, sudo, destructive redirection, or any command that deletes data.
Prefer the smallest fix that makes the job pass again.
For fix.kind "command", fix.body must be the complete corrected job command that should replace the current job command.
Never return a command fix identical to the current job.command; an unchanged command is not a fix.
For fix.kind "patch", fix.body must be a unified diff suitable for git apply.
Build patches only from related_files supplied in the context. Patch paths must be relative to job.cwd and use a/ and b/ prefixes.
For fix.kind "config", fix.body must be JSON with exactly {"path":"relative/path","content":"complete replacement content"}.`;

const REVIEW_PROMPT = `Act as a skeptical second-pass reviewer. Using only the supplied incident evidence and proposed diagnosis, decide whether the fix would work and what it could break.
Set verified true only when the cited evidence supports the mechanism and the exact fix is safe and likely to make the job pass.
Put any concrete concern in objection; otherwise objection must be null. Never invent missing evidence.`;
