import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PUBLIC_BROWSER_PILOT_ENABLED } from '../agent/lib/container-egress.ts';
import { decideBrowserAccess } from '../agent/lib/browser-guard.ts';
import { LIVE_PILOT_ENABLED } from '../scripts/readonly-pilot.ts';
import { STRUCTURED_PILOT_CANDIDATE, STRUCTURED_PILOT_ENABLED, prepareStructuredPilot } from '../scripts/structured-pilot.ts';

test('the structured pilot stays NO-GO and approves no host', () => {
  assert.equal(PUBLIC_BROWSER_PILOT_ENABLED, false);
  assert.equal(LIVE_PILOT_ENABLED, false);
  assert.equal(STRUCTURED_PILOT_ENABLED, false);
  const plan = prepareStructuredPilot('https://docs.example/guide');
  assert.equal(plan.decision, 'NO-GO');
  assert.equal(plan.execute, false);
  assert.equal(plan.approvedHost, null);
  assert.equal(plan.requestedUrl, 'https://docs.example/guide');
  assert.equal(plan.publicBrowserPilot, false);
  assert.equal(plan.structuredPilot, false);
  assert.deepEqual(plan.extracts, ['title', 'headings', 'links', 'metadata']);
  assert.equal(plan.timeouts.totalMs, 30_000);
  assert.equal(plan.timeouts.navigationMs, 20_000);
  assert.equal(plan.timeouts.maxDocumentBytes, 1_048_576);
  assert.equal(plan.failure.partial, false);
  assert.equal(plan.evidence.files.includes('catalog.json'), true);
  assert.equal(plan.evidence.files.includes('reliability.json'), true);
  assert.equal(plan.prohibited.includes('purchase'), true);
  assert.equal(plan.prohibited.includes('paid-api'), true);
  assert.equal(decideBrowserAccess({ host: 'example.com', count: 1 }, 'https://docs.example/guide').type, 'approve');
  const source = readFileSync(new URL('../scripts/structured-pilot.ts', import.meta.url), 'utf8');
  assert.equal(/node:(?:net|dns)|playwright|fetch\(/.test(source), false);
});

test('the structured pilot rejects unsafe targets and refuses execution', () => {
  for (const raw of [
    'http://docs.example/',
    'https://user:pass@docs.example/',
    'https://docs.example:8443/',
    'https://docs.example/page#fragment',
    'https://docs.example/a https://other.example/',
  ]) assert.throws(() => prepareStructuredPilot(raw));
  const executed = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/structured-pilot.ts', '--execute'], { encoding: 'utf8' });
  assert.equal(executed.status, 2);
  assert.match(executed.stderr, /Structured public pilot is disabled/);
  const prepared = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/structured-pilot.ts', '--url', 'https://example.com/'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0);
  assert.match(prepared.stdout, /"decision": "NO-GO"/);
  assert.match(prepared.stdout, /"approvedHost": null/);
  assert.match(prepared.stdout, /structured pilot prepare passed/);
  const candidate = prepareStructuredPilot(STRUCTURED_PILOT_CANDIDATE);
  assert.equal(candidate.decision, 'NO-GO');
  assert.equal(candidate.execute, false);
  assert.equal(candidate.approvedHost, null);
  assert.equal(candidate.documentGet, false);
  assert.equal(candidate.requestedUrl, 'https://docs.python.org/3/');
  assert.equal(candidate.pin.applies, true);
  assert.equal(candidate.pin.host, 'docs.python.org');
  assert.equal(candidate.pin.port, 443);
  assert.equal(candidate.pin.transport, 'tcp');
  assert.match(candidate.approvalsRequired[0], /one read-only GET of https:\/\/docs\.python\.org\/3\//);
  assert.equal(prepareStructuredPilot('https://docs.python.org/3').pin.applies, false);
  assert.equal(prepareStructuredPilot('https://docs.python.org/3/index.html').pin.applies, false);
  assert.equal(prepareStructuredPilot('https://example.com/').pin.applies, false);
  const executedCandidate = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/structured-pilot.ts', '--execute', '--url', STRUCTURED_PILOT_CANDIDATE], { encoding: 'utf8' });
  assert.equal(executedCandidate.status, 2);
  assert.match(executedCandidate.stderr, /Structured public pilot is disabled/);
  assert.equal(executedCandidate.stdout.includes('structured pilot prepare passed'), false);
});
