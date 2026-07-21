import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const runSourceSchema = z.enum(['wrap', 'api', 'demo']);
export const incidentKindSchema = z.enum(['failure', 'stale', 'flapping']);
export const incidentStatusSchema = z.enum(['open', 'proposed', 'applied', 'dismissed']);
export const jobStateSchema = z.enum(['healthy', 'late', 'stale', 'failed', 'flapping', 'never']);

export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const pingParamsSchema = z.object({ name: z.string().trim().min(1).max(120) });
export const pingQuerySchema = z.object({ state: z.enum(['start', 'success', 'fail']).optional() });
export const pingBodySchema = z.union([z.string(), z.record(z.string(), z.unknown()), z.null(), z.undefined()]);
export const dismissInputSchema = z.object({ reason: z.string().trim().min(1).max(1000) });

export const diagnosisSchema = z.object({
  root_cause: z.string().min(1),
  evidence: z.array(z.object({
    line: z.string().min(1),
    why_it_matters: z.string().min(1)
  })).min(1),
  fix: z.object({
    kind: z.enum(['patch', 'command', 'config']),
    body: z.string().min(1),
    explanation: z.string().min(1)
  }),
  risk: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1)
});

export const skepticReviewSchema = z.object({
  verified: z.boolean(),
  verdict: z.string().min(1),
  objection: z.string().nullable()
});

export const configFixSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const runInputSchema = z.object({
  name: z.string().trim().min(1),
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  description: z.string().trim().max(500).nullable().optional(),
  expectedIntervalS: z.number().int().positive().nullable().optional(),
  graceS: z.number().int().nonnegative().nullable().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  logTail: z.string(),
  tokensIn: z.number().int().nonnegative().nullable().optional(),
  tokensOut: z.number().int().nonnegative().nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  source: runSourceSchema
});

export type RunInput = z.infer<typeof runInputSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type IncidentKind = z.infer<typeof incidentKindSchema>;
export type Diagnosis = z.infer<typeof diagnosisSchema>;
export type SkepticReview = z.infer<typeof skepticReviewSchema>;

export interface ProposalRow {
  id: number;
  incident_id: number;
  created_at: string;
  model: string;
  root_cause: string;
  evidence_json: string;
  evidence: Diagnosis['evidence'];
  fix_kind: Diagnosis['fix']['kind'];
  fix_body: string;
  fix_explanation: string;
  risk: Diagnosis['risk'];
  confidence: number;
  review_verdict: string | null;
  review_verified: number | null;
  applied_at: string | null;
  apply_result: string | null;
  dismiss_reason: string | null;
}

export interface IncidentRow {
  id: number;
  job_id: number;
  run_id: number | null;
  opened_at: string;
  closed_at: string | null;
  kind: IncidentKind;
  status: z.infer<typeof incidentStatusSchema>;
}

export interface IncidentDetail extends IncidentRow {
  proposal: ProposalRow | null;
}

export interface JobCard {
  id: number;
  name: string;
  command: string;
  cwd: string;
  description: string | null;
  schedule_hint: string | null;
  expected_interval_s: number | null;
  grace_s: number | null;
  created_at: string;
  archived: number;
  last_run_at: string | null;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  run_count: number;
  recent_durations: number[];
  state: JobState;
  next_expected_at: string | null;
  open_incident_id: number | null;
  open_incident_kind: IncidentKind | null;
}

export interface JobDetail extends JobCard {
  runs: Array<{
    id: number;
    job_id: number;
    started_at: string;
    ended_at: string;
    exit_code: number;
    duration_ms: number;
    log_tail: string;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    source: z.infer<typeof runSourceSchema>;
  }>;
  incidents: IncidentDetail[];
}

export function databasePath(): string {
  return process.env.CRONTROL_DB ?? join(homedir(), '.crontrol', 'crontrol.db');
}

export function openDatabase(path = databasePath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      description TEXT,
      schedule_hint TEXT,
      expected_interval_s INTEGER,
      grace_s INTEGER,
      created_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      log_tail TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      source TEXT NOT NULL CHECK (source IN ('wrap', 'api', 'demo'))
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('failure', 'stale', 'flapping')),
      status TEXT NOT NULL CHECK (status IN ('open', 'proposed', 'applied', 'dismissed'))
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      model TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      fix_kind TEXT NOT NULL CHECK (fix_kind IN ('patch', 'command', 'config')),
      fix_body TEXT NOT NULL,
      risk TEXT NOT NULL,
      confidence REAL NOT NULL,
      applied_at TEXT,
      apply_result TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_job_started_idx ON runs(job_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_active_per_job_idx
      ON incidents(job_id) WHERE status IN ('open', 'proposed');
  `);
  ensureColumn(db, 'proposals', 'fix_explanation', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'proposals', 'review_verdict', 'TEXT');
  ensureColumn(db, 'proposals', 'review_verified', 'INTEGER');
  ensureColumn(db, 'proposals', 'dismiss_reason', 'TEXT');
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function recordRun(db: Database.Database, raw: RunInput): number {
  const input = runInputSchema.parse(raw);
  const now = input.startedAt;
  const scheduleHint = input.expectedIntervalS ? `every ${input.expectedIntervalS}s` : null;
  db.prepare(`
    INSERT INTO jobs (name, command, cwd, description, schedule_hint, expected_interval_s, grace_s, created_at, archived)
    VALUES (@name, @command, @cwd, @description, @scheduleHint, @expectedIntervalS, @graceS, @now, 0)
    ON CONFLICT(name) DO UPDATE SET
      command = excluded.command,
      cwd = excluded.cwd,
      description = COALESCE(excluded.description, jobs.description),
      schedule_hint = COALESCE(excluded.schedule_hint, jobs.schedule_hint),
      expected_interval_s = COALESCE(excluded.expected_interval_s, jobs.expected_interval_s),
      grace_s = COALESCE(excluded.grace_s, jobs.grace_s),
      archived = 0
  `).run({
    name: input.name,
    command: input.command,
    cwd: input.cwd,
    description: input.description ?? null,
    scheduleHint,
    expectedIntervalS: input.expectedIntervalS ?? null,
    graceS: input.graceS ?? null,
    now
  });
  const job = db.prepare('SELECT id FROM jobs WHERE name = ?').get(input.name) as { id: number };
  const result = db.prepare(`
    INSERT INTO runs (job_id, started_at, ended_at, exit_code, duration_ms, log_tail, tokens_in, tokens_out, cost_usd, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.id, input.startedAt, input.endedAt, input.exitCode, input.durationMs, redactSecrets(input.logTail),
    input.tokensIn ?? null, input.tokensOut ?? null, input.costUsd ?? null, input.source);
  return Number(result.lastInsertRowid);
}

export function listJobCards(db: Database.Database, nowMs = Date.now()): JobCard[] {
  const rows = db.prepare(`
    SELECT j.*,
      (SELECT id FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_run_id,
      (SELECT started_at FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_run_at,
      (SELECT exit_code FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_exit_code,
      (SELECT duration_ms FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_duration_ms,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id) AS run_count,
      (SELECT closed_at FROM incidents WHERE job_id = j.id AND status IN ('applied', 'dismissed') AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1) AS last_resolution_at,
      (SELECT id FROM incidents WHERE job_id = j.id AND status IN ('open', 'proposed') ORDER BY opened_at DESC LIMIT 1) AS open_incident_id,
      (SELECT kind FROM incidents WHERE job_id = j.id AND status IN ('open', 'proposed') ORDER BY opened_at DESC LIMIT 1) AS open_incident_kind
    FROM jobs j WHERE j.archived = 0 ORDER BY j.name
  `).all() as Array<Omit<JobCard, 'recent_durations' | 'state' | 'next_expected_at'> & { last_run_id: number | null; last_resolution_at: string | null }>;
  const durations = db.prepare('SELECT duration_ms FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 12');
  const exits = db.prepare(`
    SELECT exit_code FROM runs
    WHERE job_id = ? AND (? IS NULL OR started_at > ?)
    ORDER BY started_at DESC LIMIT 5
  `);
  return rows.map((row) => {
    const recentExits = (exits.all(row.id, row.last_resolution_at, row.last_resolution_at) as { exit_code: number }[]).map((run) => run.exit_code);
    const nextExpectedMs = row.last_run_at && row.expected_interval_s
      ? new Date(row.last_run_at).getTime() + row.expected_interval_s * 1000
      : null;
    const state = calculateJobState(row.last_run_at, row.last_exit_code, row.expected_interval_s, row.grace_s, recentExits, nowMs);
    const { last_run_id: _lastRunId, last_resolution_at: _lastResolutionAt, ...card } = row;
    return {
      ...card,
      state,
      next_expected_at: nextExpectedMs === null ? null : new Date(nextExpectedMs).toISOString(),
      recent_durations: (durations.all(row.id) as { duration_ms: number }[]).map((run) => run.duration_ms).reverse()
    };
  });
}

export function calculateJobState(
  lastRunAt: string | null,
  lastExitCode: number | null,
  expectedIntervalS: number | null,
  graceS: number | null,
  recentExitCodes: number[],
  nowMs = Date.now()
): JobState {
  if (!lastRunAt || lastExitCode === null) return 'never';
  const outcomes = recentExitCodes.slice(0, 5).map((code) => code === 0);
  const transitions = outcomes.slice(1).reduce((count, outcome, index) => count + Number(outcome !== outcomes[index]), 0);
  if (outcomes.length === 5 && transitions >= 3) return 'flapping';
  if (lastExitCode !== 0) return 'failed';
  if (expectedIntervalS) {
    const overdueMs = nowMs - (new Date(lastRunAt).getTime() + expectedIntervalS * 1000);
    if (overdueMs > 0) {
      const effectiveGraceS = graceS ?? Math.round(expectedIntervalS * 0.5);
      return overdueMs > effectiveGraceS * 1000 ? 'stale' : 'late';
    }
  }
  return 'healthy';
}

export function superviseDatabase(db: Database.Database, now = new Date()): IncidentRow[] {
  const opened: IncidentRow[] = [];
  const transaction = db.transaction(() => {
    for (const job of listJobCards(db, now.getTime())) {
      const kind: IncidentKind | null = job.state === 'failed' ? 'failure'
        : job.state === 'stale' ? 'stale'
          : job.state === 'flapping' ? 'flapping'
            : null;
      if (!kind || job.open_incident_id) continue;
      const lastRun = kind === 'flapping'
        ? db.prepare('SELECT id FROM runs WHERE job_id = ? AND exit_code != 0 ORDER BY started_at DESC LIMIT 1').get(job.id) as { id: number } | undefined
        : db.prepare('SELECT id FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1').get(job.id) as { id: number } | undefined;
      const result = db.prepare(`
        INSERT INTO incidents (job_id, run_id, opened_at, closed_at, kind, status)
        VALUES (?, ?, ?, NULL, ?, 'open')
      `).run(job.id, lastRun?.id ?? null, now.toISOString(), kind);
      opened.push(db.prepare('SELECT * FROM incidents WHERE id = ?').get(result.lastInsertRowid) as IncidentRow);
    }
  });
  transaction();
  return opened;
}

export function getJobDetail(db: Database.Database, id: number): JobDetail | null {
  const card = listJobCards(db).find((job) => job.id === id);
  if (!card) return null;
  const runs = db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 100').all(id) as JobDetail['runs'];
  const incidentRows = db.prepare('SELECT * FROM incidents WHERE job_id = ? ORDER BY opened_at DESC').all(id) as IncidentRow[];
  const proposalQuery = db.prepare('SELECT * FROM proposals WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1');
  const incidents = incidentRows.map((incident): IncidentDetail => {
    const raw = proposalQuery.get(incident.id) as Omit<ProposalRow, 'evidence'> | undefined;
    let evidence: Diagnosis['evidence'] = [];
    if (raw) {
      try { evidence = diagnosisSchema.shape.evidence.parse(JSON.parse(raw.evidence_json)); } catch { evidence = []; }
    }
    return { ...incident, proposal: raw ? { ...raw, evidence } : null };
  });
  return { ...card, runs, incidents };
}

export function upsertRemoteJob(db: Database.Database, name: string, now = new Date()): number {
  db.prepare(`
    INSERT INTO jobs (name, command, cwd, description, schedule_hint, expected_interval_s, grace_s, created_at, archived)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0)
    ON CONFLICT(name) DO UPDATE SET archived = 0
  `).run(name, `remote:${name}`, process.cwd(), 'Remote job reported through the ping API.', now.toISOString());
  return (db.prepare('SELECT id FROM jobs WHERE name = ?').get(name) as { id: number }).id;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(api[_-]?key|secret|key|token|password)\s*[=:]\s*[^\s&"']+/gi, '$1=[REDACTED]')
    .replace(/(--(?:api[_-]?key|secret|key|token|password))\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}". Use s, m, h, or d (for example: 24h).`);
  const factors = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  return Math.round(Number(match[1]) * factors[match[2] as keyof typeof factors]);
}
