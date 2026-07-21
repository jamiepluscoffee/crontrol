#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function main(arguments_ = process.argv.slice(2), environment = process.env) {
  const skipInstall = arguments_.includes('--skip-install');
  if (Number(process.versions.node.split('.')[0]) < 20) {
    fail('Crontrol requires Node.js 20 or newer. Install a current Node.js release, then ask Codex to continue.');
  }

  console.log('Crontrol guided setup: preparing the local supervisor.');
  if (!skipInstall) run('corepack', ['pnpm', 'install'], environment);

  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    copyFileSync(join(root, '.env.example'), envPath);
    console.log('Created the private local configuration file .env.');
  }
  chmodSync(envPath, 0o600);

  run('corepack', ['pnpm', 'build'], environment);

  if (!hasOpenAIKey(envPath, environment)) {
    console.log('\nLocal build is ready. Setup is paused at the only required credential step.');
    console.log('1. Create a project API key at https://platform.openai.com/api-keys');
    console.log('2. Put it after OPENAI_API_KEY= in .env on this computer. Do not paste it into Codex chat.');
    console.log('3. Ask Codex to continue, or rerun: corepack pnpm onboard');
    process.exitCode = 2;
    return;
  }

  run('corepack', ['pnpm', 'exec', 'ct', 'doctor'], environment);
  const discovery = capture('corepack', ['pnpm', 'exec', 'ct', 'discover', '--json'], environment);
  const parsed = JSON.parse(discovery);
  console.log(`\nRead-only discovery found ${parsed.jobs.length} scheduled ${parsed.jobs.length === 1 ? 'job' : 'jobs'}. Nothing was changed.`);
  for (const job of parsed.jobs) {
    console.log(`- ${job.label} · ${job.source} · ${job.schedule}${job.alreadyMonitored ? ' · already monitored' : ''}`);
  }
  for (const warning of parsed.warnings) console.log(`! ${warning}`);
  console.log('\nLocal preflight passed. Codex should now assess these jobs and ask which ones you want to monitor.');
}

export function hasOpenAIKey(path, environment = {}) {
  if (typeof environment.OPENAI_API_KEY === 'string' && environment.OPENAI_API_KEY.trim()) return true;
  if (!existsSync(path)) return false;
  const match = readFileSync(path, 'utf8').match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m);
  if (!match) return false;
  const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  return Boolean(value);
}

function run(command, args, environment) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: environment });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, environment) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: environment });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function fail(message) {
  console.error(`Setup could not continue: ${message}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
