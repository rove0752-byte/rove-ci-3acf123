import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDecision, createSerializedBrowserGate, decideBrowserAccess, recordBrowserFetch, type BrowserStore, type GateState } from '../agent/lib/browser-guard.ts';

function memoryGate(shared = false) {
  const sessions = new Map<string, GateState>();
  let sharedState: GateState = { host: null, count: 0, claims: [] };
  const store: BrowserStore = {
    get(sessionId) {
      if (shared) return sharedState;
      return sessions.get(sessionId) ?? { host: null, count: 0, claims: [] };
    },
    update(sessionId, fn) {
      if (shared) { sharedState = fn(sharedState); return; }
      sessions.set(sessionId, fn(sessions.get(sessionId) ?? { host: null, count: 0, claims: [] }));
    },
  };
  return createSerializedBrowserGate(store);
}

test('allows the first three documents on one host', () => {
  const first = decideBrowserAccess({ host: null, count: 0 }, 'https://Example.com/a');
  assert.deepEqual(first, { type: 'allow', host: 'example.com', count: 1 });
  assert.equal(approvalDecision({ host: null, count: 0 }, 'https://Example.com/a'), 'not-applicable');
  const second = decideBrowserAccess({ host: 'example.com', count: 1 }, 'https://example.com/b');
  assert.deepEqual(second, { type: 'allow', host: 'example.com', count: 2 });
  assert.deepEqual(recordBrowserFetch({ host: 'example.com', count: 2 }, 'https://example.com/c'), { host: 'example.com', count: 3 });
});

test('asks for approval before leaving the first host and keeps that host', () => {
  const state = { host: 'example.com', count: 1 };
  assert.deepEqual(decideBrowserAccess(state, 'https://other.example/x'), { type: 'approve' });
  assert.equal(approvalDecision(state, 'https://other.example/x'), 'user-approval');
  assert.deepEqual(recordBrowserFetch(state, 'https://other.example/x'), { host: 'example.com', count: 2 });
});

test('denies the fourth page on the same host and on a new host', () => {
  const state = { host: 'example.com', count: 3 };
  const same = decideBrowserAccess(state, 'https://example.com/more');
  const other = decideBrowserAccess(state, 'https://other.example/');
  assert.equal(same.type, 'deny');
  assert.equal(other.type, 'deny');
  assert.equal(approvalDecision(state, 'https://other.example/').type, 'denied');
  assert.throws(() => recordBrowserFetch(state, 'https://example.com/more'), /Page limit/);
  assert.throws(() => recordBrowserFetch(state, 'https://other.example/'), /Page limit/);
});

test('denies an unusable document URL', () => {
  assert.equal(decideBrowserAccess({ host: null, count: 0 }, 'not a url').type, 'deny');
  assert.equal(decideBrowserAccess({ host: null, count: 0 }, 'file:///etc/passwd').type, 'deny');
  assert.equal(approvalDecision({ host: null, count: 0 }, undefined).type, 'denied');
});

test('concurrent first fetches record one host and send the other to approval', async () => {
  const gate = memoryGate();
  const [first, second] = await Promise.all([
    gate.decide('https://one.example/a', 'call-a', 'session'),
    gate.decide('https://two.example/b', 'call-b', 'session'),
  ]);
  const decisions = [first, second];
  assert.equal(decisions.filter(item => item === 'not-applicable').length, 1);
  assert.equal(decisions.filter(item => item === 'user-approval').length, 1);
  const allowedUrl = first === 'not-applicable' ? 'https://one.example/a' : 'https://two.example/b';
  const approvedUrl = first === 'user-approval' ? 'https://one.example/a' : 'https://two.example/b';
  const approvedCall = first === 'user-approval' ? 'call-a' : 'call-b';
  assert.equal(gate.read('session').host, new URL(allowedUrl).hostname);
  assert.equal(gate.read('session').count, 1);
  await gate.reserve(approvedUrl, approvedCall, 'session');
  assert.equal(gate.read('session').host, new URL(allowedUrl).hostname);
  assert.equal(gate.read('session').count, 2);
  await gate.reserve(approvedUrl, approvedCall, 'session');
  assert.equal(gate.read('session').count, 2);
});

test('concurrent same-host fetches keep the three-page cap', async () => {
  const gate = memoryGate();
  const results = await Promise.all([0, 1, 2, 3].map(index =>
    gate.decide(`https://example.com/${index}`, `call-${index}`, 'session')));
  assert.equal(results.filter(item => item === 'not-applicable').length, 3);
  assert.equal(results.filter(item => typeof item === 'object' && item.type === 'denied').length, 1);
  assert.equal(gate.read('session').host, 'example.com');
  assert.equal(gate.read('session').count, 3);
});

test('concurrent reserves do not lose page-count updates', async () => {
  const gate = memoryGate();
  await Promise.all([0, 1, 2].map(index => gate.reserve(`https://example.com/${index}`, `call-${index}`, 'session')));
  assert.equal(gate.read('session').count, 3);
  await assert.rejects(gate.reserve('https://example.com/more', 'call-x', 'session'), /Page limit/);
});

test('an allowed fetch is counted once when it is reserved', async () => {
  const gate = memoryGate();
  assert.equal(await gate.decide('https://example.com/a', 'call-1', 'session'), 'not-applicable');
  assert.equal(gate.read('session').count, 1);
  await gate.reserve('https://example.com/a', 'call-1', 'session');
  assert.equal(gate.read('session').count, 1);
  assert.equal(await gate.decide('https://example.com/a', 'call-1', 'session'), 'not-applicable');
  assert.equal(gate.read('session').count, 1);
  await assert.rejects(gate.reserve('https://other.example/a', 'call-1', 'session'), /approved URL/);
  assert.equal(gate.read('session').count, 1);
  await gate.reserve('https://example.com/a', 'call-1', 'session');
  assert.equal(gate.read('session').count, 1);
});

test('the same call id in two sessions does not reuse one claim', async () => {
  const gate = memoryGate(true);
  const [first, second] = await Promise.all([
    gate.decide('https://one.example/', 'same-call', 'alpha'),
    gate.decide('https://two.example/', 'same-call', 'beta'),
  ]);
  const decisions = [first, second];
  assert.equal(decisions.filter(item => item === 'not-applicable').length, 1);
  assert.equal(decisions.filter(item => item === 'user-approval').length, 1);
  assert.equal(gate.read('alpha').count, 1);
});
