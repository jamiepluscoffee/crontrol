import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverSchedules, parseCrontab, parseLaunchAgent } from './discover.js';

test('discover parses ordinary and macro cron entries without treating environment lines as jobs', () => {
  const jobs = parseCrontab(`# morning work
SHELL=/bin/zsh
0 6 * * * cd /srv/brief && ./brief.sh
@hourly /usr/local/bin/ct run --name link-check --every 1h -- ./check-links.sh
`);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    source: 'crontab', label: 'crontab line 3', schedule: '0 6 * * *',
    command: 'cd /srv/brief && ./brief.sh', location: 'user crontab', alreadyMonitored: false
  });
  assert.equal(jobs[1].label, 'link-check');
  assert.equal(jobs[1].schedule, '@hourly');
  assert.equal(jobs[1].alreadyMonitored, true);
});

test('discover describes a macOS LaunchAgent without changing it', () => {
  const job = parseLaunchAgent({
    Label: 'com.example.backup',
    ProgramArguments: ['/Users/example/bin/backup.sh', '--destination', '/Volumes/Nightly Backups'],
    StartCalendarInterval: { Hour: 2, Minute: 30 }
  }, '/Users/example/Library/LaunchAgents/com.example.backup.plist');
  assert.ok(job);
  assert.equal(job.label, 'com.example.backup');
  assert.equal(job.schedule, 'hour 2, minute 30');
  assert.match(job.command, /'\/Volumes\/Nightly Backups'/);
  assert.equal(job.alreadyMonitored, false);
});

test('discover combines user crontab and LaunchAgents through injectable read-only readers', () => {
  const result = discoverSchedules({
    platform: 'darwin',
    home: '/Users/example',
    readCrontab: () => '*/5 * * * * ./refresh.sh',
    listLaunchAgents: () => ['com.example.mailer.plist', 'notes.txt'],
    readLaunchAgent: () => ({ Label: 'com.example.mailer', Program: '/Users/example/mailer.sh', StartInterval: 3600 })
  });
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.jobs.map((job) => job.source), ['crontab', 'launchd']);
});

test('discover redacts secret-looking values before human or JSON output', () => {
  const [job] = parseCrontab('0 * * * * ./sync.sh --token=super-secret-value');
  assert.ok(job);
  assert.doesNotMatch(job.command, /super-secret-value/);
  assert.match(job.command, /\[REDACTED\]/);
});
