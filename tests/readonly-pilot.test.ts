import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PUBLIC_BROWSER_PILOT_ENABLED } from '../agent/lib/container-egress.ts';
import { LIVE_PILOT_ENABLED, PILOT_CANDIDATE, prepareReadonlyPilot } from '../scripts/readonly-pilot.ts';

test('the read-only pilot rehearsal stays NO-GO for one public page', () => {
  assert.equal(PUBLIC_BROWSER_PILOT_ENABLED, false);
  assert.equal(LIVE_PILOT_ENABLED, false);
  const plan = prepareReadonlyPilot(PILOT_CANDIDATE);
  assert.equal(plan.decision, 'NO-GO');
  assert.equal(plan.execute, false);
  assert.equal(plan.url, 'https://example.com/');
  assert.equal(plan.isolation, 'dedicated-container');
  assert.equal(plan.timeouts.totalMs, 30_000);
  assert.equal(plan.timeouts.navigationMs, 20_000);
  assert.equal(plan.timeouts.maxDocumentBytes, 1_048_576);
  assert.equal(plan.failure.partial, false);
  assert.deepEqual(plan.logging.fields, ['time', 'event', 'host', 'outcome', 'error']);
  assert.equal(plan.evidence.files.includes('result.json'), true);
  assert.equal(plan.prohibited.includes('purchase'), true);
  assert.equal(plan.prohibited.includes('authentication'), true);
  const source = readFileSync(new URL('../scripts/readonly-pilot.ts', import.meta.url), 'utf8');
  assert.equal(/node:(?:net|dns)|playwright|fetch\(/.test(source), false);
});

test('the rehearsal rejects every other target and refuses execution', () => {
  for (const raw of [
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'https://example.com/other',
    'https://example.com/#fragment',
    'https://127.0.0.1/',
    'https://example.com/ https://example.org/',
    'https://www.example.com/',
  ]) assert.throws(() => prepareReadonlyPilot(raw));
  const executed = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/readonly-pilot.ts', '--execute'], { encoding: 'utf8' });
  assert.equal(executed.status, 2);
  assert.match(executed.stderr, /Live public-website pilot is disabled/);
  const prepared = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/readonly-pilot.ts'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0);
  assert.match(prepared.stdout, /"decision": "NO-GO"/);
  assert.match(prepared.stdout, /readonly pilot prepare passed/);
});
