import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { launchBrowser } from '../agent/lib/browser.ts';
import { createInteractionTools, interactionInput } from '../agent/lib/interactions.ts';

test('controlled fixture: permitted actions, state, isolation and cleanup', async () => {
  const browsers: Browser[] = [];
  const tools = createInteractionTools({ launch: async () => { const b = await launchBrowser(); browsers.push(b); return b; } });
  try {
    const first = await tools.run('alice', { action: 'start' });
    assert.ok('accessibility' in first);
    assert.equal(first.title, 'Rove controlled fixture');
    assert.match(first.screenshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.screenshotBytes, Buffer.from(first.screenshotBase64, 'base64').length);
    assert.ok(first.screenshotBytes > 100);
    const sessionId = first.sessionId;
    const typed = await tools.run('alice', { action: 'type', sessionId, role: 'textbox', name: 'Draft note', text: 'Retained draft' });
    assert.ok('accessibility' in typed && typed.accessibility.includes('Retained draft'));
    const clicked = await tools.run('alice', { action: 'click', sessionId, role: 'checkbox', name: 'Show details' });
    assert.ok('accessibility' in clicked && clicked.accessibility.includes('Show details" [checked]'));
    assert.ok(clicked.accessibility.includes('Retained draft'));
    const radio = await tools.run('alice', { action: 'click', sessionId, role: 'radio', name: 'Compact view' });
    assert.ok('accessibility' in radio && radio.accessibility.includes('Compact view" [checked]'));
    await tools.run('alice', { action: 'click', sessionId, role: 'button', name: 'Preview draft' });
    const second = await tools.run('bob', { action: 'start' });
    assert.ok('accessibility' in second && !second.accessibility.includes('Retained draft'));
    await assert.rejects(tools.run('bob', { action: 'snapshot', sessionId }), /Unknown/);
    await assert.rejects(tools.run('bob', { action: 'close', sessionId }), /Unknown/);
    await assert.rejects(tools.run('alice', { action: 'start' }), /capacity/);
    const pendingSnapshot = tools.run('alice', { action: 'snapshot', sessionId });
    await assert.rejects(tools.run('alice', { action: 'snapshot', sessionId }), /busy/);
    await pendingSnapshot;
    assert.ok('accessibility' in await tools.run('alice', { action: 'snapshot', sessionId }));
    await tools.run('alice', { action: 'close', sessionId });
    assert.equal(browsers[0].isConnected(), false);
    assert.equal(browsers[1].isConnected(), true);
    await assert.rejects(tools.run('alice', { action: 'snapshot', sessionId }), /Unknown/);
  } finally { await tools.closeAll(); }
  assert.ok(browsers.every(b => !b.isConnected()));
});

test('blocked targets fail closed and never make network requests', async () => {
  const browser = await launchBrowser();
  // Keep one real browser for these independent contexts, with close observed separately.
  let closed = 0;
  const tools = createInteractionTools({ launch: async () => new Proxy(browser, { get(b, key) {
    if (key === 'close') return async () => { closed++; await Promise.all(b.contexts().map(c => c.close())); };
    const value = Reflect.get(b, key); return typeof value === 'function' ? value.bind(b) : value;
  } }) });
  try {
    for (const [role, name] of [
      ['button', 'Submit GET'], ['button', 'Submit POST'], ['button', 'Buy now'], ['button', 'Sign in'],
      ['link', 'Download'], ['link', 'External page'], ['textbox', 'Account password'], ['textbox', 'Upload file'],
      ['button', 'Unavailable'], ['button', 'Hidden control'], ['textbox', 'Duplicate'], ['button', 'Missing'],
    ] as const) {
      const start = await tools.run('owner', { action: 'start' });
      const page = browser.contexts()[0].pages()[0];
      const responses: string[] = [];
      page.on('response', response => responses.push(response.url()));
      await assert.rejects(tools.run('owner', { action: 'click', sessionId: start.sessionId, role, name }));
      assert.equal(browser.contexts().length, 0);
      assert.deepEqual(responses, []);
    }
    assert.equal(closed, 12);
    // Positive network guard probe: bypass the action layer only inside the test.
    await tools.run('owner', { action: 'start' });
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    assert.equal(await page.title(), 'Rove controlled fixture');
    assert.equal(context.serviceWorkers().length, 0);
    await assert.rejects(page.goto('https://example.com/blocked'));
    await assert.rejects(page.goto('http://127.0.0.1:1/private'));
  } finally { await tools.closeAll(); await browser.close(); }
});

test('input surface rejects scripts, URLs, uploads, keypresses and unbounded text', () => {
  for (const input of [
    { action: 'start', url: 'https://example.com' }, { action: 'evaluate', script: 'alert(1)' },
    { action: 'upload', path: '/tmp/file' }, { action: 'download' }, { action: 'press', key: 'Enter' },
    { action: 'type', sessionId: '7b963bb2-6b01-49c7-b56f-2bf22f58b423', role: 'textbox', name: 'Draft note', text: 'x'.repeat(1001) },
    { action: 'navigate', sessionId: '7b963bb2-6b01-49c7-b56f-2bf22f58b423', url: 'x'.repeat(2049) },
    { action: 'select', sessionId: '7b963bb2-6b01-49c7-b56f-2bf22f58b423', role: 'combobox', name: 'Sort by', option: '' },
    { action: 'purchase', sessionId: 'not-a-uuid' },
  ]) assert.equal(interactionInput.safeParse(input).success, false);
});

test('action bound, idle expiry, total lifetime and cancellation clean up', async () => {
  for (const scenario of ['actions', 'idle', 'lifetime', 'cancel'] as const) {
    let browser!: Browser;
    const tools = createInteractionTools({ maxActions: 1, idleMs: scenario === 'idle' ? 50 : 10_000,
      lifetimeMs: scenario === 'lifetime' ? 1800 : 60_000,
      launch: async () => (browser = await launchBrowser()) });
    try {
      const start = await tools.run('owner', { action: 'start' });
      if (scenario === 'actions') {
        const result = await tools.run('owner', { action: 'click', sessionId: start.sessionId, role: 'checkbox', name: 'Show details' });
        assert.equal(result.closed, true);
        assert.ok('remainingActions' in result && result.remainingActions === 0);
      } else if (scenario === 'cancel') {
        const controller = new AbortController();
        const pending = tools.run('owner', { action: 'snapshot', sessionId: start.sessionId }, controller.signal);
        controller.abort();
        await assert.rejects(pending, /cancelled/);
      } else {
        await new Promise(resolve => setTimeout(resolve, scenario === 'idle' ? 250 : 1900));
      }
      assert.equal(browser.isConnected(), false);
      await assert.rejects(tools.run('owner', { action: 'snapshot', sessionId: start.sessionId }), /Unknown|expired/);
    } finally { await tools.closeAll(); }
  }
});

test('startup deadline, capacity and late browser cleanup', async () => {
  let finish!: (browser: Browser) => void;
  let closed = 0;
  const pending = new Promise<Browser>(resolve => { finish = resolve; });
  const tools = createInteractionTools({ launch: () => pending, operationMs: 30, maxSessions: 1 });
  const start = tools.run('owner', { action: 'start' });
  await assert.rejects(tools.run('other', { action: 'start' }), /capacity/);
  await assert.rejects(start, /timed out/);
  finish({ close: async () => { closed++; } } as unknown as Browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closed, 1);
  await tools.closeAll();
  const failure = createInteractionTools({ launch: async () => ({
    newContext: async () => { throw new Error('context failed'); }, close: async () => { closed++; },
  } as unknown as Browser) });
  await assert.rejects(failure.run('owner', { action: 'start' }), /context failed/);
  assert.equal(closed, 2);
});

test('an action deadline closes the session even when Playwright work stalls', async () => {
  let stalled = false;
  let closed = false;
  const locator = {
    ariaSnapshot: async () => 'fixture', count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true,
    fill: () => { stalled = true; return new Promise(() => {}); },
  };
  const page = { on() {}, goto: async () => {}, title: async () => 'fixture',
    url: () => 'https://rove-fixture.invalid/', locator: () => locator, getByRole: () => locator,
    screenshot: async () => Buffer.from('png') };
  const context = { setDefaultTimeout() {}, routeWebSocket: async () => {}, newPage: async () => page,
    on() {}, route: async () => {} };
  const tools = createInteractionTools({ operationMs: 30, launch: async () => ({
    newContext: async () => context, close: async () => { closed = true; },
  } as unknown as Browser) });
  const start = await tools.run('owner', { action: 'start' });
  await assert.rejects(tools.run('owner', { action: 'type', sessionId: start.sessionId,
    role: 'textbox', name: 'Draft note', text: 'draft' }), /timed out/);
  assert.equal(stalled, true);
  assert.equal(closed, true);
  await assert.rejects(tools.run('owner', { action: 'snapshot', sessionId: start.sessionId }), /Unknown/);
});

test('fixture select and preview navigation capture evidence and refuse live targets', async () => {
  const browser = await launchBrowser();
  const tools = createInteractionTools({ launch: async () => new Proxy(browser, { get(target, key) {
    if (key === 'close') return async () => { await Promise.all(target.contexts().map(context => context.close())); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) });
  try {
    const start = await tools.run('owner', { action: 'start' });
    const page = browser.contexts()[0].pages()[0];
    const urls: string[] = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) urls.push(frame.url()); });
    const selected = await tools.run('owner', { action: 'select', sessionId: start.sessionId, role: 'combobox', name: 'Sort by', option: 'Name' });
    assert.equal('selection' in selected ? selected.selection : undefined, 'Name');
    assert.match(selected.screenshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(selected.screenshotBytes, Buffer.from(selected.screenshotBase64, 'base64').length);
    const preview = await tools.run('owner', { action: 'navigate', sessionId: start.sessionId, url: 'https://rove-fixture.invalid/preview' });
    assert.equal(preview.title, 'Rove fixture preview');
    assert.equal(preview.url, 'https://rove-fixture.invalid/preview');
    assert.equal(preview.effect, 'local-navigation');
    assert.ok(preview.evidenceId);
    await assert.rejects(tools.run('owner', { action: 'purchase', sessionId: start.sessionId }), /Live side effects/);
    assert.ok(urls.every(url => url.startsWith('https://rove-fixture.invalid/')));
    assert.equal(urls.includes('https://example.com/next'), false);
    const again = await tools.run('owner', { action: 'start' });
    const nextPage = browser.contexts()[0].pages()[0];
    const nextUrls: string[] = [];
    nextPage.on('framenavigated', frame => { if (frame === nextPage.mainFrame()) nextUrls.push(frame.url()); });
    await assert.rejects(tools.run('owner', { action: 'navigate', sessionId: again.sessionId, url: 'https://example.com/next' }), /Live side effects/);
    assert.deepEqual(nextUrls, []);
  } finally { await tools.closeAll(); await browser.close(); }
});
