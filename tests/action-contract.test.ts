import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  ACTION_LIMITS, LIVE_SIDE_EFFECT_ERROR, approvalForInteraction, authoredFixtureUrl, classifyBrowserAction, interactionInput,
} from '../agent/lib/action-contract.ts';

const sessionId = '7b963bb2-6b01-49c7-b56f-2bf22f58b423';

test('the action contract is closed and bounded', () => {
  assert.equal(interactionInput.options.length, 11);
  const schema = z.toJSONSchema(interactionInput) as { oneOf?: unknown[]; anyOf?: unknown[] };
  assert.equal(schema.oneOf?.length ?? schema.anyOf?.length, 11);
  assert.equal(ACTION_LIMITS.maxActions, 10);
  assert.equal(ACTION_LIMITS.operationMs, 10_000);
  assert.equal(authoredFixtureUrl('https://rove-fixture.invalid/preview'), 'https://rove-fixture.invalid/preview');
  assert.equal(authoredFixtureUrl('https://rove-fixture.invalid:443/preview'), 'https://rove-fixture.invalid/preview');
  assert.equal(authoredFixtureUrl('https://user:pass@rove-fixture.invalid/preview'), undefined);
  assert.equal(authoredFixtureUrl('https://rove-fixture.invalid/preview?next=1'), undefined);
  assert.equal(authoredFixtureUrl('https://rove-fixture.invalid/preview#frag'), undefined);
  assert.equal(authoredFixtureUrl('https://example.com/preview'), undefined);
});

test('fixture actions run without approval and side effects require approval', () => {
  const fixture = [
    { action: 'start' },
    { action: 'type', sessionId, role: 'textbox', name: 'Draft note', text: 'note' },
    { action: 'click', sessionId, role: 'checkbox', name: 'Show details' },
    { action: 'select', sessionId, role: 'combobox', name: 'Sort by', option: 'Name' },
    { action: 'navigate', sessionId, url: 'https://rove-fixture.invalid/preview' },
    { action: 'snapshot', sessionId },
    { action: 'close', sessionId },
  ];
  for (const input of fixture) {
    assert.equal(approvalForInteraction(input), 'not-applicable');
    assert.equal(classifyBrowserAction(interactionInput.parse(input)).disposition, 'fixture');
  }
  const sideEffects = [
    { action: 'navigate', sessionId, url: 'https://example.com/next' },
    { action: 'navigate', sessionId, url: 'javascript:alert(1)' },
    { action: 'submit', sessionId },
    { action: 'purchase', sessionId },
    { action: 'authenticate', sessionId },
    { action: 'transfer', sessionId, kind: 'upload' },
    { action: 'click', sessionId, role: 'button', name: 'Buy now' },
    { action: 'click', sessionId, role: 'button', name: 'Sign in' },
    { action: 'click', sessionId, role: 'button', name: 'Submit POST' },
    { action: 'click', sessionId, role: 'link', name: 'External page' },
    { action: 'type', sessionId, role: 'textbox', name: 'Account password', text: 'secret' },
  ];
  for (const input of sideEffects) assert.equal(approvalForInteraction(input), 'user-approval');
  assert.equal(approvalForInteraction({ action: 'click', sessionId, role: 'button', name: 'Missing' }).type, 'denied');
  assert.equal(approvalForInteraction({ action: 'evaluate', script: 'alert(1)' }).type, 'denied');
  assert.equal(LIVE_SIDE_EFFECT_ERROR, 'Live side effects are disabled.');
});
