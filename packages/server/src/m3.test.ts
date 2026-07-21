import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  listJobCards,
  recordRun,
  superviseDatabase,
  type Diagnosis,
  type SkepticReview
} from '@crontrol/shared';
import { approveIncident, dismissIncident } from './approval.js';
import { buildIncidentContext, Sentinel, serializeIncidentContext, type SentinelModel } from './sentinel.js';
import { runChaos } from './supervision.js';

const failingLine = '/bin/sh: ./agents/nightly-brief.sh: No such file or directory';

class FakeModel implements SentinelModel {
  async diagnose(): Promise<Diagnosis> {
    return {
      root_cause: 'The deployed script was renamed, but the stored job command still points to the old hyphenated path.',
      evidence: [{ line: failingLine, why_it_matters: 'The configured executable path does not exist.' }],
      fix: {
        kind: 'command',
        body: './agents/nightly_brief.sh',
        explanation: 'Point the job at the renamed script.'
      },
      risk: 'low',
      confidence: 0.98
    };
  }

  async review(): Promise<SkepticReview> {
    return { verified: true, verdict: 'The corrected path exists and is the smallest safe change.', objection: null };
  }
}

class NoOpModel extends FakeModel {
  override async diagnose(): Promise<Diagnosis> {
    const diagnosis = await super.diagnose();
    return { ...diagnosis, fix: { ...diagnosis.fix, body: './agents/nightly-brief.sh' } };
  }
}

class FailingFixModel extends FakeModel {
  override async diagnose(): Promise<Diagnosis> {
    const diagnosis = await super.diagnose();
    return { ...diagnosis, fix: { ...diagnosis.fix, body: './agents/still-missing.sh' } };
  }
}

test('M3 stores a two-pass proposal, applies it, reruns green, and closes the incident', async () => {
  const fixture = createFixture();
  try {
    const sentinel = new Sentinel(fixture.db, () => {}, new FakeModel());
    await sentinel.diagnoseIncident(fixture.incidentId);
    const proposed = fixture.db.prepare('SELECT status FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string };
    const proposal = fixture.db.prepare('SELECT model, review_verified FROM proposals WHERE incident_id = ?').get(fixture.incidentId) as { model: string; review_verified: number };
    assert.equal(proposed.status, 'proposed');
    assert.deepEqual(proposal, { model: 'gpt-5.6', review_verified: 1 });

    const result = await approveIncident(fixture.db, fixture.incidentId);
    assert.equal(result.exitCode, 0);
    assert.equal(result.closed, true);
    const incident = fixture.db.prepare('SELECT status, closed_at FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string; closed_at: string | null };
    const job = fixture.db.prepare("SELECT command FROM jobs WHERE name = 'nightly-brief'").get() as { command: string };
    const rerun = fixture.db.prepare('SELECT exit_code, log_tail FROM runs WHERE id = ?').get(result.runId) as { exit_code: number; log_tail: string };
    assert.equal(incident.status, 'applied');
    assert.ok(incident.closed_at);
    assert.equal(job.command, './agents/nightly_brief.sh');
    assert.equal(rerun.exit_code, 0);
    assert.match(rerun.log_tail, /Brief saved successfully/);

    const chaos = await runChaos(fixture.db);
    assert.equal(chaos.exitCode, 127);
    const rearmed = fixture.db.prepare("SELECT command FROM jobs WHERE name = 'nightly-brief'").get() as { command: string };
    assert.equal(rearmed.command, './agents/nightly-brief.sh');
  } finally { fixture.close(); }
});

test('M3 dismissal stores the reason and closes without applying', async () => {
  const fixture = createFixture();
  try {
    const sentinel = new Sentinel(fixture.db, () => {}, new FakeModel());
    await sentinel.diagnoseIncident(fixture.incidentId);
    const result = dismissIncident(fixture.db, fixture.incidentId, 'The timeout is expected during maintenance.');
    assert.equal(result.status, 'dismissed');
    const incident = fixture.db.prepare('SELECT status, closed_at FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string; closed_at: string | null };
    const proposal = fixture.db.prepare('SELECT dismiss_reason FROM proposals WHERE incident_id = ?').get(fixture.incidentId) as { dismiss_reason: string };
    assert.equal(incident.status, 'dismissed');
    assert.ok(incident.closed_at);
    assert.equal(proposal.dismiss_reason, 'The timeout is expected during maintenance.');
  } finally { fixture.close(); }
});

test('M3 missing-key mode keeps monitoring usable and explains how to enable diagnosis', async () => {
  const fixture = createFixture();
  try {
    const sentinel = new Sentinel(fixture.db, () => {}, null);
    await sentinel.diagnoseIncident(fixture.incidentId);
    const proposal = fixture.db.prepare('SELECT model, root_cause FROM proposals WHERE incident_id = ?').get(fixture.incidentId) as { model: string; root_cause: string };
    const incident = fixture.db.prepare('SELECT status FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string };
    assert.equal(proposal.model, 'unavailable');
    assert.match(proposal.root_cause, /OPENAI_API_KEY/);
    assert.equal(incident.status, 'open');
  } finally { fixture.close(); }
});

test('M3 removes secret-looking strings before constructing an LLM request', () => {
  const fixture = createFixture('failure token=hunter2 sk-testsecret123 Bearer hidden-value');
  try {
    const context = buildIncidentContext(fixture.db, fixture.incidentId);
    assert.ok(context);
    const stored = fixture.db.prepare('SELECT log_tail FROM runs WHERE id = ?').get(context.failing_run?.id) as { log_tail: string };
    assert.doesNotMatch(stored.log_tail, /hunter2|sk-testsecret123|hidden-value/);
    const serialized = serializeIncidentContext(context);
    assert.doesNotMatch(serialized, /hunter2|sk-testsecret123|hidden-value/);
    assert.match(serialized, /\[REDACTED\]/);
  } finally { fixture.close(); }
});

test('M3 rejects a no-op command proposal instead of rerunning the same failure', async () => {
  const fixture = createFixture();
  try {
    const sentinel = new Sentinel(fixture.db, () => {}, new NoOpModel());
    await sentinel.diagnoseIncident(fixture.incidentId);
    await assert.rejects(() => approveIncident(fixture.db, fixture.incidentId), /identical to the current command/);
    const runCount = fixture.db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
    assert.equal(runCount.count, 2);
  } finally { fixture.close(); }
});

test('M3 rolls back a failed command fix and permits diagnosis from the rerun evidence', async () => {
  const fixture = createFixture();
  try {
    const sentinel = new Sentinel(fixture.db, () => {}, new FailingFixModel());
    await sentinel.diagnoseIncident(fixture.incidentId);
    const result = await approveIncident(fixture.db, fixture.incidentId);
    assert.equal(result.closed, false);
    assert.equal(result.exitCode, 127);
    const incident = fixture.db.prepare('SELECT status, run_id FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string; run_id: number };
    const job = fixture.db.prepare("SELECT command FROM jobs WHERE name = 'nightly-brief'").get() as { command: string };
    assert.equal(incident.status, 'open');
    assert.equal(incident.run_id, result.runId);
    assert.equal(job.command, './agents/nightly-brief.sh');

    const failedRerun = fixture.db.prepare('SELECT log_tail FROM runs WHERE id = ?').get(result.runId) as { log_tail: string };
    const newEvidenceLine = failedRerun.log_tail.split(/\r?\n/).find(Boolean);
    assert.ok(newEvidenceLine);
    const revisedModel: SentinelModel = {
      async diagnose() {
        const diagnosis = await new FakeModel().diagnose();
        return {
          ...diagnosis,
          evidence: [{ line: newEvidenceLine, why_it_matters: 'The approved replacement command also points to a missing file.' }]
        };
      },
      async review() { return new FakeModel().review(); }
    };
    await new Sentinel(fixture.db, () => {}, revisedModel).diagnoseIncident(fixture.incidentId);
    const revised = fixture.db.prepare('SELECT status FROM incidents WHERE id = ?').get(fixture.incidentId) as { status: string };
    assert.equal(revised.status, 'proposed');
  } finally { fixture.close(); }
});

test('M3 does not reopen a resolved flapping incident from pre-fix failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'crontrol-flapping-test-'));
  const db = openDatabase(join(root, 'crontrol.db'));
  try {
    const base = Date.now() - 10_000;
    for (let index = 0; index < 5; index += 1) {
      const startedAt = new Date(base + index * 1_000);
      recordRun(db, {
        name: 'flapping-job', command: './job.sh', cwd: root,
        startedAt: startedAt.toISOString(), endedAt: new Date(startedAt.getTime() + 10).toISOString(),
        exitCode: index % 2, durationMs: 10, logTail: index % 2 ? 'transient failure' : 'pass', source: 'demo'
      });
    }
    const [incident] = superviseDatabase(db, new Date(base + 5_000));
    assert.ok(incident);
    assert.equal(incident.kind, 'flapping');

    const rerunAt = new Date(base + 6_000);
    recordRun(db, {
      name: 'flapping-job', command: './job.sh --retry', cwd: root,
      startedAt: rerunAt.toISOString(), endedAt: new Date(rerunAt.getTime() + 10).toISOString(),
      exitCode: 0, durationMs: 10, logTail: 'pass after retry', source: 'api'
    });
    const closedAt = new Date(base + 7_000);
    db.prepare("UPDATE incidents SET status = 'applied', closed_at = ? WHERE id = ?").run(closedAt.toISOString(), incident.id);

    assert.deepEqual(superviseDatabase(db, new Date(base + 8_000)), []);
    const card = listJobCards(db, base + 8_000).find((job) => job.name === 'flapping-job');
    assert.equal(card?.state, 'healthy');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(failingLog = `${failingLine}\nThe deployed script now exists at ./agents/nightly_brief.sh`) {
  const root = mkdtempSync(join(tmpdir(), 'crontrol-m3-test-'));
  const agents = join(root, 'agents');
  mkdirSync(agents);
  writeFileSync(join(agents, 'nightly_brief.sh'), '#!/bin/sh\necho "Brief saved successfully"\n', { mode: 0o755 });
  const db = openDatabase(join(root, 'crontrol.db'));
  const now = Date.now();
  recordRun(db, {
    name: 'nightly-brief', command: './agents/nightly-brief.sh', cwd: root,
    description: 'Build the nightly briefing.', expectedIntervalS: 86400, graceS: 43200,
    startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 59_900).toISOString(),
    exitCode: 0, durationMs: 100, logTail: 'Brief saved successfully', source: 'demo'
  });
  const failedRunId = recordRun(db, {
    name: 'nightly-brief', command: './agents/nightly-brief.sh', cwd: root,
    description: 'Build the nightly briefing.', expectedIntervalS: 86400, graceS: 43200,
    startedAt: new Date(now).toISOString(), endedAt: new Date(now + 10).toISOString(),
    exitCode: 127, durationMs: 10, logTail: failingLog, source: 'demo'
  });
  const [opened] = superviseDatabase(db, new Date(now + 10));
  assert.ok(opened);
  assert.equal(opened.run_id, failedRunId);
  return {
    db,
    incidentId: opened.id,
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); }
  };
}
