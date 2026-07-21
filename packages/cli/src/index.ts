#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import OpenAI from 'openai';
import { openDatabase, parseDuration, recordRun, redactSecrets, type RunInput } from '@crontrol/shared';
import { seedDemo } from './seed.js';
import { discoverSchedules } from './discover.js';
import { publicationConfiguration, publishStatus, runChaos, savePublicationConfiguration, startServer } from '@crontrol/server';

const program = new Command().name('ct').description('A local run ledger for unattended agents').version('0.1.0');

program.command('run')
  .description('Run a command and record its result')
  .requiredOption('--name <name>', 'stable job name')
  .option('--every <duration>', 'expected interval, such as 24h')
  .option('--desc <description>', 'what the job is supposed to do')
  .option('--grace <duration>', 'grace window, such as 30m')
  .argument('<command...>', 'command and arguments (place after --)')
  .allowUnknownOption(true)
  .action(async (command: string[], options: { name: string; every?: string; desc?: string; grace?: string }) => {
    const started = new Date();
    const startedClock = performance.now();
    const lines: string[] = [];
    const remainders = { stdout: '', stderr: '' };
    const capture = (chunk: Buffer, stream: NodeJS.WriteStream, kind: keyof typeof remainders) => {
      stream.write(chunk);
      const pieces = (remainders[kind] + chunk.toString('utf8')).split(/\r?\n/);
      remainders[kind] = pieces.pop() ?? '';
      lines.push(...pieces);
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    };
    const child = spawn(command[0], command.slice(1), { cwd: process.cwd(), env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, process.stdout, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, process.stderr, 'stderr'));
    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', (error) => { lines.push(error.message); resolve(127); });
      child.on('close', (code) => resolve(code ?? 1));
    });
    if (remainders.stdout) lines.push(remainders.stdout);
    if (remainders.stderr) lines.push(remainders.stderr);
    const ended = new Date();
    const input: RunInput = {
        name: options.name,
        command: command.map(shellQuote).join(' '),
        cwd: process.cwd(),
        description: options.desc,
        expectedIntervalS: options.every ? parseDuration(options.every) : null,
        graceS: options.grace ? parseDuration(options.grace) : null,
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        exitCode,
        durationMs: Math.max(0, Math.round(performance.now() - startedClock)),
        logTail: redactSecrets(lines.slice(-200).join('\n')),
        source: 'wrap'
      };
    if (!await submitRun(input)) {
      const db = openDatabase();
      try { recordRun(db, input); } finally { db.close(); }
    }
    process.exitCode = exitCode;
  });

program.command('demo')
  .description('Seed six realistic jobs and their run history')
  .option('--reset', 'wipe the ledger before seeding')
  .action((options: { reset?: boolean }) => {
    const db = openDatabase();
    try { seedDemo(db, Boolean(options.reset)); } finally { db.close(); }
    console.log('Seeded six demo jobs. Run `ct up` to view them.');
  });

program.command('up')
  .description('Start the local dashboard')
  .option('--port <port>', 'port to listen on', '4100')
  .action(async (options: { port: string }) => {
    const port = Number(options.port);
    await startServer(port);
    console.log(`Crontrol is running at http://localhost:${port}`);
  });

program.command('doctor')
  .description('Check OpenAI credentials and GPT-5.6 Sol access')
  .action(async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('✗ OPENAI_API_KEY is not set. Add it to a gitignored .env file or export it before running Crontrol.');
      process.exitCode = 1;
      return;
    }
    console.log('✓ OPENAI_API_KEY is present (value hidden)');
    try {
      const client = new OpenAI({ apiKey, timeout: 10_000, maxRetries: 0 });
      const model = await client.models.retrieve('gpt-5.6-sol');
      if (model.id !== 'gpt-5.6-sol') throw new Error(`Unexpected model response: ${model.id}`);
      console.log('✓ gpt-5.6-sol is accessible');
      console.log('Crontrol AI diagnosis is ready.');
      const publishing = publicationConfiguration();
      console.log(publishing.configured
        ? '✓ Private status publishing is configured'
        : 'ℹ Private status publishing is not configured (optional)');
    } catch (error) {
      console.error(`✗ Could not access gpt-5.6-sol: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    }
  });

program.command('discover')
  .description("Find the current user's scheduled jobs without changing them")
  .option('--json', 'print machine-readable output for guided onboarding')
  .action((options: { json?: boolean }) => {
    const result = discoverSchedules();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const warning of result.warnings) console.error(`! ${warning}`);
    if (result.jobs.length === 0) {
      console.log('No scheduled jobs found in the current user crontab or supported user schedulers.');
      console.log('Nothing was changed.');
      return;
    }
    const monitored = result.jobs.filter((job) => job.alreadyMonitored).length;
    console.log(`Found ${result.jobs.length} scheduled ${result.jobs.length === 1 ? 'job' : 'jobs'} (read-only; nothing changed).`);
    for (const [index, job] of result.jobs.entries()) {
      console.log(`\n${index + 1}. ${job.label}`);
      console.log(`   Source: ${job.source} · ${job.schedule}`);
      console.log(`   Command: ${job.command}`);
      console.log(`   Location: ${job.location}`);
      if (job.alreadyMonitored) console.log('   Crontrol: already monitored');
    }
    const unmonitored = result.jobs.length - monitored;
    console.log(`\n${monitored} already monitored · ${unmonitored} not monitored`);
    if (unmonitored > 0) console.log('Ask Codex to assess the jobs you choose before wrapping them. It should show every schedule change for approval first.');
  });

program.command('publish')
  .description('Publish a sanitized snapshot to your private status site')
  .option('--configure', 'securely save publishing values from the current environment')
  .action(async (options: { configure?: boolean }) => {
    if (options.configure) console.log(`Saved private status configuration to ${savePublicationConfiguration()}`);
    const db = openDatabase();
    try {
      const result = await publishStatus(db);
      console.log(`Published ${result.jobs} jobs to the private status site.`);
      console.log(result.siteUrl);
    } finally { db.close(); }
  });

program.command('chaos')
  .description('Break the seeded nightly briefing job and open an incident')
  .option('--url <url>', 'running Crontrol server URL', process.env.CRONTROL_URL ?? 'http://127.0.0.1:4100')
  .action(async (options: { url: string }) => {
    let result: Awaited<ReturnType<typeof runChaos>>;
    try {
      const baseUrl = options.url.replace(/\/$/, '');
      const token = await fetchSessionToken(baseUrl);
      const response = await fetch(`${baseUrl}/api/chaos`, { method: 'POST', headers: { 'x-crontrol-token': token }, signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      result = await response.json() as Awaited<ReturnType<typeof runChaos>>;
    } catch {
      const db = openDatabase();
      try { result = await runChaos(db); } finally { db.close(); }
    }
    console.log(`Chaos triggered: nightly-brief failed with exit ${result.exitCode}; incident is open.`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function submitRun(input: RunInput): Promise<boolean> {
  const baseUrl = (process.env.CRONTROL_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
  try {
    const token = await fetchSessionToken(baseUrl);
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crontrol-token': token },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(750)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchSessionToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(750) });
  if (!response.ok) throw new Error(`Could not establish a Crontrol session (${response.status}).`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error('Crontrol returned no session token.');
  return body.token;
}
