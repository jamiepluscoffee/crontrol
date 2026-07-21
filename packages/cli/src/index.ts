#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { openDatabase, parseDuration, recordRun, redactSecrets } from '@crontrol/shared';
import { seedDemo } from './seed.js';
import { startServer } from '@crontrol/server';

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
    const db = openDatabase();
    try {
      recordRun(db, {
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
      });
    } finally { db.close(); }
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

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
