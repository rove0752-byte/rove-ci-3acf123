import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Browser } from 'playwright';
import { createBrowserTools, launchBrowser, omitScreenshot, resolvePinned, selectPinnedAddresses } from '../agent/lib/browser.ts';

const fixture = `<!doctype html><html><head><title>Safe fixture</title><meta name="description" content="Fixture description"></head><body>
<h1>Fixture heading</h1>
<table><tr><th>Column</th></tr><tr><td>Cell</td></tr></table>
<script type="application/ld+json">{"@type":"Thing","name":"Fixture"}</script>
<script type="application/ld+json">not json</script>
<label for="name">Your name</label><input id="name">
<button aria-label="Accessible action">Visual label</button><button disabled>Unavailable</button>
<a href="/next">Next page</a><input type="checkbox" aria-label="Consent">
<div role="button" aria-label="Custom control">Control</div><button hidden>Hidden control</button>
<form action="/submit" method="get"><button>Submit GET</button></form>
<form action="/submit" method="post"><input type="file"><button>Submit POST</button></form>
<a href="/download" download>Download</a><iframe src="/frame"></iframe>
<script src="/script"></script><script>fetch('/submit',{method:'POST'});document.title='Executed';</script>
</body>`;

test('real browser: startup, discovery, inspect protections, redirects, timeouts and cleanup', async t => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/slow') return;
    if (request.url === '/redirect') { response.writeHead(302, { location: '/' }); response.end(); return; }
    if (request.url === '/escape') { response.writeHead(302, { location: 'http://127.0.0.1:1/private' }); response.end(); return; }
    if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return; }
    if (request.url === '/download') { response.writeHead(200, { 'content-disposition': 'attachment; filename=test.txt' }); response.end('blocked'); return; }
    if (request.url === '/error') { response.writeHead(500); response.end(); return; }
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/many' ? '<body>' + '<button>Action</button>'.repeat(65) + '</body>' : fixture);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browsers: Browser[] = [];
  const validate = async (raw: string) => {
    const url = new URL(raw);
    assert.equal(url.origin, origin, 'fixture must never access another origin');
    return url;
  };
  const launch = async () => { const browser = await launchBrowser(); browsers.push(browser); return browser; };
  const tools = createBrowserTools({ launch, validate });
  try {
    await t.test('startup and accessible names, roles, disabled and hidden controls', async () => {
      const result = await tools.navigate(origin);
      assert.equal(result.title, 'Safe fixture');
      assert.ok(result.elements.some(e => e.role === 'textbox' && e.accessibility.includes('Your name')));
      assert.ok(result.elements.some(e => e.accessibility.includes('Accessible action')));
      assert.ok(result.elements.some(e => e.accessibility.includes('Custom control')));
      assert.ok(result.elements.some(e => e.disabled && e.accessibility.includes('Unavailable')));
      assert.ok(!result.elements.some(e => e.accessibility.includes('Hidden control')));
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('bounds the element inventory', async () => {
      const result = await tools.navigate(`${origin}/many`);
      assert.equal(result.elements.length, 60);
      assert.equal(result.truncated, true);
      assert.equal('screenshotSha256' in result, false);
    });
    await t.test('snapshot keeps the inventory and adds a PNG', async () => {
      const result = await tools.snapshotPage(origin);
      assert.equal(result.title, 'Safe fixture');
      assert.ok(result.elements.some(element => element.accessibility.includes('Accessible action')));
      assert.match(result.screenshotSha256, /^[a-f0-9]{64}$/);
      assert.equal(result.screenshotBytes, Buffer.from(result.screenshotBase64, 'base64').length);
      assert.ok(result.screenshotBytes > 100);
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('preserves inspect evidence and blocks scripts, frames and submissions', async () => {
      const result = await tools.inspectPage(origin);
      assert.equal(result.mode, 'read_only_no_javascript');
      assert.equal(result.title, 'Safe fixture');
      assert.ok(result.text.includes('Visual label'));
      assert.ok(result.links.some(link => link.url === `${origin}/next`));
      assert.equal(result.structured.title, 'Safe fixture');
      assert.equal(result.structured.description, 'Fixture description');
      assert.deepEqual(result.structured.headings, [{ level: 'h1', text: 'Fixture heading' }]);
      assert.ok(result.structured.links.some(link => link.url === `${origin}/next`));
      assert.deepEqual(result.structured.tables, [[['Column'], ['Cell']]]);
      assert.deepEqual(result.structured.jsonLd, [{ '@type': 'Thing', name: 'Fixture' }]);
      assert.match(result.screenshotSha256, /^[a-f0-9]{64}$/);
      assert.ok(Buffer.from(result.screenshotBase64, 'base64').length > 100);
      assert.ok(!requests.some(request => /submit|script|frame|download/.test(request)));
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('validates redirects and bounds redirect loops', async () => {
      assert.equal((await tools.navigate(`${origin}/redirect`)).title, 'Safe fixture');
      await assert.rejects(tools.navigate(`${origin}/escape`), /fixture must never/);
      await assert.rejects(tools.navigate(`${origin}/loop`), /five redirects/);
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('closes after failed responses and downloads', async () => {
      await assert.rejects(tools.navigate(`${origin}/error`), /HTTP 500/);
      await assert.rejects(tools.navigate(`${origin}/download`));
      assert.ok(browsers.every(browser => !browser.isConnected()));
    });
    await t.test('navigation timeout and total deadline close the browser', async () => {
      await assert.rejects(createBrowserTools({ launch, validate, navigationTimeoutMs: 100 }).navigate(`${origin}/slow`));
      await assert.rejects(createBrowserTools({ launch, validate, timeoutMs: 1500 }).navigate(`${origin}/slow`), /timed out/);
      assert.ok(browsers.every(browser => !browser.isConnected()));
    });
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('cleanup covers context creation failure and late startup', async () => {
  let closed = 0;
  const browser = { newContext: async () => { throw new Error('context failed'); },
    close: async () => { closed++; } } as unknown as Browser;
  const validate = async (raw: string) => new URL(raw);
  await assert.rejects(createBrowserTools({ validate, launch: async () => browser }).navigate('https://example.com'), /context failed/);
  assert.equal(closed, 1);
  let finish!: (browser: Browser) => void;
  const pending = new Promise<Browser>(resolve => { finish = resolve; });
  await assert.rejects(createBrowserTools({ validate, launch: () => pending, timeoutMs: 10 }).navigate('https://example.com'), /timed out/);
  finish(browser);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closed, 2);
});

test('rejects unsafe URLs before browser startup', async () => {
  let launched = false;
  const tools = createBrowserTools({ launch: async () => { launched = true; throw new Error('unexpected launch'); } });
  await assert.rejects(tools.navigate('http://127.0.0.1'));
  await assert.rejects(tools.inspectPage('file:///etc/passwd'));
  assert.equal(launched, false);
});

test('pins one resolved address and does not fetch subresources', async () => {
  const seen: { url: string | undefined; host: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, host: request.headers.host });
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Pinned</title><body><img src="/resource" alt="Should not load"></body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let lookups = 0;
  const browsers: Browser[] = [];
  try {
    const result = await createBrowserTools({
      launch: async () => { const browser = await launchBrowser(); browsers.push(browser); return browser; },
      validate: async raw => {
        const url = new URL(raw);
        assert.equal(url.hostname, 'rove-pin.invalid');
        return url;
      },
      resolve: async url => {
        lookups += 1;
        assert.equal(url.hostname, 'rove-pin.invalid');
        return [{ address: '127.0.0.1', family: 4 }];
      },
    }).navigate(`http://rove-pin.invalid:${address.port}/`);
    assert.equal(result.title, 'Pinned');
    assert.equal(lookups, 1);
    assert.deepEqual(seen, [{ url: '/', host: `rove-pin.invalid:${address.port}` }]);
    assert.equal(browsers.at(-1)?.isConnected(), false);
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('rejects an oversized document before capture', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(Buffer.alloc(1_048_577, 97));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browsers: Browser[] = [];
  try {
    await assert.rejects(createBrowserTools({
      launch: async () => { const browser = await launchBrowser(); browsers.push(browser); return browser; },
      validate: async raw => new URL(raw),
    }).navigate(origin), /1 MiB/);
    assert.ok(browsers.every(browser => !browser.isConnected()));
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('model screenshot output keeps the hash and drops the image bytes', () => {
  const evidence = omitScreenshot({ screenshotBase64: 'abc', screenshotSha256: 'dead', screenshotBytes: 3, title: 'Safe fixture' });
  assert.deepEqual(evidence, { screenshotSha256: 'dead', screenshotBytes: 3, title: 'Safe fixture' });
});

test('public address selection rejects private DNS answers and keeps accepted literals', async () => {
  assert.deepEqual(selectPinnedAddresses([{ address: '8.8.8.8', family: 4 }]), [{ address: '8.8.8.8', family: 4 }]);
  assert.throws(() => selectPinnedAddresses([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /Private/);
  assert.throws(() => selectPinnedAddresses([]), /Private/);
  assert.deepEqual(await resolvePinned(new URL('http://127.0.0.1/path')), [{ address: '127.0.0.1', family: 4 }]);
});

test('startup failure and stalled validation settle without leaking', async () => {
  await assert.rejects(createBrowserTools({ validate: async raw => new URL(raw),
    launch: async () => { throw new Error('startup failed'); },
  }).navigate('https://example.com'), /startup failed/);
  let launched = false;
  await assert.rejects(createBrowserTools({ timeoutMs: 10,
    validate: () => new Promise(() => {}),
    launch: async () => { launched = true; throw new Error('unexpected launch'); },
  }).navigate('https://example.com'), /timed out/);
  assert.equal(launched, false);
});
