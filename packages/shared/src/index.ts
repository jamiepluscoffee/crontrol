import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const runSourceSchema = z.enum(['wrap', 'api', 'demo']);

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
  `);
  return db;
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
  `).run(job.id, input.startedAt, input.endedAt, input.exitCode, input.durationMs, input.logTail,
    input.tokensIn ?? null, input.tokensOut ?? null, input.costUsd ?? null, input.source);
  return Number(result.lastInsertRowid);
}

export function listJobCards(db: Database.Database): JobCard[] {
  const rows = db.prepare(`
    SELECT j.*,
      (SELECT started_at FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_run_at,
      (SELECT exit_code FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_exit_code,
      (SELECT duration_ms FROM runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1) AS last_duration_ms,
      (SELECT COUNT(*) FROM runs WHERE job_id = j.id) AS run_count
    FROM jobs j WHERE j.archived = 0 ORDER BY j.name
  `).all() as Omit<JobCard, 'recent_durations'>[];
  const durations = db.prepare('SELECT duration_ms FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 12');
  return rows.map((row) => ({
    ...row,
    recent_durations: (durations.all(row.id) as { duration_ms: number }[]).map((run) => run.duration_ms).reverse()
  }));
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(key|token|password)\s*[=:]\s*[^\s&]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}". Use s, m, h, or d (for example: 24h).`);
  const factors = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  return Math.round(Number(match[1]) * factors[match[2] as keyof typeof factors]);
}
