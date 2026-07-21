import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hasOpenAIKey } from './onboard.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

test('onboarding detects configured keys without exposing their value', () => {
  const root = mkdtempSync(join(tmpdir(), 'crontrol-onboard-'));
  try {
    const env = join(root, '.env');
    writeFileSync(env, 'OPENAI_API_KEY="sk-example-private"\n');
    assert.equal(hasOpenAIKey(env), true);
    writeFileSync(env, 'OPENAI_API_KEY=\n');
    assert.equal(hasOpenAIKey(env), false);
    assert.equal(hasOpenAIKey(env, { OPENAI_API_KEY: 'from-process' }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('guided onboarding ships one prompt, safety boundaries, and no maintainer Sites project', () => {
  const starter = readFileSync(join(repository, 'START-HERE.md'), 'utf8');
  const instructions = readFileSync(join(repository, 'AGENTS.md'), 'utf8');
  const hosting = JSON.parse(readFileSync(join(repository, 'packages/status/.openai/hosting.json'), 'utf8'));
  assert.match(starter, /Set up Crontrol for me from start to finish/);
  assert.match(instructions, /Never ask the user to paste an API key/);
  assert.match(instructions, /obtaining explicit approval/);
  assert.equal(hosting.project_id, undefined);
  assert.equal(hosting.d1, 'DB');
});
