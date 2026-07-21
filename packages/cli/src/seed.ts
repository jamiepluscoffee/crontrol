import { NIGHTLY_BRIEF_SCRIPT, openDatabase, recordRun } from '@crontrol/shared';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type CrontrolDatabase = ReturnType<typeof openDatabase>;

const jobs = [
  { name: 'nightly-brief', command: './agents/nightly-brief.sh', description: 'Summarizes product and market updates for the morning briefing.', every: 86400, base: 42000, log: 'Fetched 38 sources\nGenerated 12-item morning brief\nBrief saved successfully' },
  { name: 'catalog-scraper', command: 'node scripts/scrape-catalog.mjs', description: 'Refreshes competitor catalog prices and availability.', every: 21600, base: 88000, log: 'Crawled 246 product pages\nUpdated 19 prices\nCatalog sync complete' },
  { name: 'postgres-backup', command: './ops/backup-db.sh', description: 'Creates and verifies an encrypted database backup.', every: 86400, base: 126000, log: 'Snapshot created\nUploaded 2.4 GB archive\nChecksum verified' },
  { name: 'model-eval-batch', command: 'pnpm eval:nightly', description: 'Runs the regression evaluation suite against the current model.', every: 86400, base: 310000, log: 'Evaluated 1,200 cases\nPass rate: 96.8%\nResults uploaded' },
  { name: 'docs-link-checker', command: 'node scripts/check-links.mjs --retries 0', description: 'Checks documentation for broken external and internal links.', every: 43200, base: 65000, log: 'Checked 814 links\n0 broken links\nLink check passed' },
  { name: 'weekly-report-mailer', command: './agents/send-report.sh', description: 'Builds and emails the weekly operations report.', every: 604800, base: 74000, log: 'Rendered weekly report\nDelivered to 14 recipients\nMailer finished' }
] as const;

export function demoRoot(): string {
  return join(homedir(), '.crontrol', 'demo');
}

function prepareDemoScripts(reset: boolean): void {
  const agentsDir = join(demoRoot(), 'agents');
  const expectedPath = join(agentsDir, 'nightly-brief.sh');
  const renamedPath = join(agentsDir, 'nightly_brief.sh');
  mkdirSync(agentsDir, { recursive: true });
  if (reset && existsSync(renamedPath)) renameSync(renamedPath, expectedPath);
  if (existsSync(renamedPath) && !existsSync(expectedPath)) renameSync(renamedPath, expectedPath);
  writeFileSync(expectedPath, NIGHTLY_BRIEF_SCRIPT, { mode: 0o755 });
  const scriptsDir = join(demoRoot(), 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'check-links.mjs'), `const argument = process.argv.find((value) => value === '--retries' || value.startsWith('--retries='));
const retries = argument?.includes('=')
  ? Number(argument.split('=', 2)[1])
  : argument === '--retries' ? Number(process.argv[process.argv.indexOf(argument) + 1]) : 0;
if (!Number.isFinite(retries) || retries < 1) {
  console.error('ERROR request timed out for https://status.example.test');
  console.error('Retry policy exhausted: retries=0');
  console.error('Hint: rerun with --retries 3');
  process.exit(1);
}
console.log('Checked 814 links');
console.log('Recovered one transient timeout with retry 1/3');
console.log('0 broken links');
console.log('Link check passed');
`, 'utf8');
}

export function seedDemo(db: CrontrolDatabase, reset: boolean): void {
  prepareDemoScripts(reset);
  const seed = db.transaction(() => {
    if (reset) {
      db.exec('DELETE FROM proposals; DELETE FROM incidents; DELETE FROM runs; DELETE FROM jobs;');
    }
    const now = Date.now();
    jobs.forEach((job, jobIndex) => {
      const existing = db.prepare(`SELECT COUNT(*) AS count FROM runs r JOIN jobs j ON j.id = r.job_id WHERE j.name = ? AND r.source = 'demo'`).get(job.name) as { count: number };
      if (existing.count > 0) return;
      const count = Math.max(3, Math.ceil(18 * 86400 / job.every));
      for (let i = count - 1; i >= 0; i--) {
        const endedMs = now - i * job.every * 1000 - jobIndex * 137_000;
        const jitter = ((i * 7919 + jobIndex * 3571) % 18000) - 9000;
        const duration = Math.max(1200, job.base + jitter);
        const isFlapping = job.name === 'docs-link-checker' && i < 5 && i % 2 === 1;
        recordRun(db, {
          name: job.name,
          command: job.command,
          cwd: job.name === 'nightly-brief' || job.name === 'docs-link-checker' ? demoRoot() : process.cwd(),
          description: job.description,
          expectedIntervalS: job.every,
          graceS: Math.round(job.every * 0.5),
          startedAt: new Date(endedMs - duration).toISOString(),
          endedAt: new Date(endedMs).toISOString(),
          exitCode: isFlapping ? 1 : 0,
          durationMs: duration,
          logTail: isFlapping ? 'Checking docs links\nERROR request timed out for https://status.example.test\nRetry policy exhausted: retries=0\nHint: rerun with --retries 3\nLink check failed with 1 error' : job.log,
          tokensIn: job.name.includes('brief') || job.name.includes('eval') ? 18000 + i * 37 : null,
          tokensOut: job.name.includes('brief') || job.name.includes('eval') ? 3200 + i * 11 : null,
          costUsd: job.name.includes('brief') || job.name.includes('eval') ? 0.18 + (i % 5) * 0.01 : null,
          source: 'demo'
        });
      }
    });
  });
  seed();
}
