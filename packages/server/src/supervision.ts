import type Database from 'better-sqlite3';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { recordRun, redactSecrets, superviseDatabase } from '@crontrol/shared';

interface ChaosJob {
  id: number;
  name: string;
  command: string;
  cwd: string;
  description: string | null;
  expected_interval_s: number | null;
  grace_s: number | null;
}

export async function runChaos(db: Database.Database) {
  const job = db.prepare("SELECT * FROM jobs WHERE name = 'nightly-brief' AND archived = 0").get() as ChaosJob | undefined;
  if (!job) throw new Error('Demo jobs are missing. Run `ct demo` first.');

  const expectedPath = join(job.cwd, 'agents', 'nightly-brief.sh');
  const renamedPath = join(job.cwd, 'agents', 'nightly_brief.sh');
  if (existsSync(expectedPath)) renameSync(expectedPath, renamedPath);

  const started = new Date();
  const startedClock = performance.now();
  const chunks: Buffer[] = [];
  const child = spawn('/bin/sh', ['-c', job.command], { cwd: job.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (error) => { chunks.push(Buffer.from(error.message)); resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const ended = new Date();
  const rawLog = Buffer.concat(chunks).toString('utf8').trim()
    || `/bin/sh: ${job.command}: command not found\nThe demo script was renamed to ./agents/nightly_brief.sh`;
  const logTail = redactSecrets(`${rawLog}\nThe deployed script now exists at ./agents/nightly_brief.sh`).split(/\r?\n/).slice(-200).join('\n');
  const runId = recordRun(db, {
    name: job.name,
    command: job.command,
    cwd: job.cwd,
    description: job.description,
    expectedIntervalS: job.expected_interval_s,
    graceS: job.grace_s,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    exitCode: exitCode || 127,
    durationMs: Math.max(0, Math.round(performance.now() - startedClock)),
    logTail,
    source: 'demo'
  });
  const opened = superviseDatabase(db, ended);
  const incident = db.prepare("SELECT * FROM incidents WHERE job_id = ? AND status IN ('open', 'proposed') ORDER BY opened_at DESC LIMIT 1").get(job.id);
  return { jobId: job.id, runId, exitCode: exitCode || 127, incident, openedIncident: opened.length > 0 };
}
