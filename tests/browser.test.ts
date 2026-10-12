import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Browser } from 'playwright';
import { ExtractionTimeout, createBrowserTools, launchBrowser, omitScreenshot, resolvePinned, selectPinnedAddresses } from '../agent/lib/browser.ts';
import { HEADING_LIMIT, catalogDocument } from '../agent/lib/document-catalog.ts';

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

const navDocument = `<!doctype html>
<html><head><title>Outline</title></head><body>
<nav>
  <h3>Download</h3>
  <h3>Docs by version</h3>
</nav>
<h1>Python 3.15.0 documentation</h1>
<h2>Other resources</h2>
<h3>Download</h3>
<h2>Notes</h2>
<h2>Notes</h2>
<div class="sphinxsidebar" role="Navigation">
  <h3>Download</h3>
  <h3>Docs by version</h3>
</div>
<a href="/keep">Keep</a>
</body></html>`;

const outlineParts = Array.from({ length: HEADING_LIMIT }, (_, index) => `<h2>Part ${index}</h2>`).join('');
const outlineDocument = `<!doctype html><html><head><title>Capped</title></head><body>
<nav><h3>Download</h3><h3>Docs by version</h3></nav>
<h1>Guide</h1>
<h2>Notes</h2>
<h2>Notes</h2>
${outlineParts}
<div role="navigation"><h3>Download</h3><h3>Docs by version</h3></div>
<h2>Tail</h2>
<a href="/keep">Keep</a>
</body></html>`;

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
    if (request.url === '/links') {
      response.setHeader('content-type', 'text/html');
      const anchors = Array.from({ length: 61 }, (_, index) => `<a href="/p/${index}">P${index}</a>`).join('');
      response.end(`<html><head><title>Links</title></head><body><h1>Links</h1>${anchors}<a href="/${'z'.repeat(2100)}">Long</a></body></html>`);
      return;
    }
    if (request.url === '/many') {
      response.setHeader('content-type', 'text/html');
      const buttons = Array.from({ length: 65 }, (_, index) => `<button>Action ${index}</button>`).join('');
      response.end(`<body>${buttons}<button hidden>Hidden extra</button></body>`);
      return;
    }
    if (request.url === '/sixty') {
      response.setHeader('content-type', 'text/html');
      const buttons = Array.from({ length: 60 }, (_, index) => `<button>Slot ${index}</button>`).join('');
      response.end(`<body>${buttons}<button hidden>Secret</button><input hidden aria-label="Secret field"></body>`);
      return;
    }
    if (request.url === '/essay') {
      response.setHeader('content-type', 'text/html');
      response.end(`<html><head><title>Essay</title></head><body><h1>Essay</h1><p>${'word '.repeat(4000)}</p><a href="/keep">Keep</a></body></html>`);
      return;
    }
    if (request.url === '/nav') {
      response.setHeader('content-type', 'text/html');
      response.end(navDocument);
      return;
    }
    if (request.url === '/outline') {
      response.setHeader('content-type', 'text/html');
      response.end(outlineDocument);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(fixture);
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
      const names = ['Next page', 'Download', 'Accessible action', 'Unavailable', 'Custom control', 'Submit GET', 'Choose File', 'Submit POST', 'Your name', 'Consent'];
      assert.equal(result.elements.length, names.length);
      names.forEach((name, index) => assert.ok(result.elements[index]?.accessibility.includes(name), name));
      names.forEach((name, index) => assert.ok(result.elements[index]?.accessibility.includes(name), name));
      assert.equal(result.truncated, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: names.length, omitted: 0, reasons: [] });
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('bounds the element inventory', async () => {
      const result = await tools.navigate(`${origin}/many`);
      assert.equal(result.elements.length, 60);
      assert.equal(result.truncated, true);
      assert.equal('screenshotSha256' in result, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: false, kept: 60, omitted: 5, reasons: ['inventory-cap'] });
      assert.equal(result.elements.every(element => element.role === 'button'), true);
      assert.ok(result.elements[0]?.accessibility.includes('Action 0'));
      assert.ok(result.elements[59]?.accessibility.includes('Action 59'));
      assert.ok(!result.elements.some(element => element.accessibility.includes('Action 60') || element.accessibility.includes('Hidden extra')));
    });
    await t.test('an inventory of exactly 60 visible controls is complete', async () => {
      const result = await tools.navigate(`${origin}/sixty`);
      assert.equal(result.elements.length, 60);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: 60, omitted: 0, reasons: [] });
      assert.ok(result.elements[0]?.accessibility.includes('Slot 0'));
      assert.ok(result.elements[59]?.accessibility.includes('Slot 59'));
      assert.ok(!result.elements.some(element => element.accessibility.includes('Secret')));
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('snapshot keeps the inventory and adds a PNG', async () => {
      const result = await tools.snapshotPage(origin);
      assert.equal(result.title, 'Safe fixture');
      assert.ok(result.elements.some(element => element.accessibility.includes('Accessible action')));
      assert.equal(result.truncated, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: result.elements.length, omitted: 0, reasons: [] });
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
      assert.equal(result.completeness.complete, true);
      assert.equal(result.completeness.linksOmitted, 0);
      assert.equal(result.completeness.overlongLinks, 0);
      assert.equal(result.completeness.timedOut, false);
      assert.equal(result.completeness.timeoutStage, null);
      assert.equal(result.structured.completeness.complete, true);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: 10, omitted: 0, reasons: [] });
      assert.equal(result.links.length, result.structured.links.length);
      assert.deepEqual(result.structured.tables, [[['Column'], ['Cell']]]);
      assert.deepEqual(result.structured.jsonLd, [{ '@type': 'Thing', name: 'Fixture' }]);
      assert.match(result.screenshotSha256, /^[a-f0-9]{64}$/);
      assert.ok(Buffer.from(result.screenshotBase64, 'base64').length > 100);
      assert.ok(!requests.some(request => /submit|script|frame|download/.test(request)));
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('inspect keeps links past the old cap and reports an overlong url', async () => {
      const result = await tools.inspectPage(`${origin}/links`);
      assert.equal(result.title, 'Links');
      assert.equal(result.links.length, 61);
      assert.equal(result.links.some(link => link.url === `${origin}/p/60`), true);
      assert.equal(result.completeness.linksKept, 61);
      assert.equal(result.completeness.linksOmitted, 0);
      assert.equal(result.completeness.overlongLinks, 1);
      assert.equal(result.completeness.complete, false);
      assert.equal(result.completeness.reasons.includes('overlong-link'), true);
      assert.equal(result.structured.completeness.complete, false);
      assert.equal(result.links.some(link => link.url.length > 2048), false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: false, kept: 60, omitted: 2, reasons: ['inventory-cap'] });
      assert.deepEqual(result.completeness.reasons, ['overlong-link']);
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('inspect de-duplicates nav headings and keeps repeated content headings', async () => {
      const result = await tools.inspectPage(`${origin}/nav`);
      const catalog = catalogDocument(navDocument, `${origin}/nav`);
      assert.deepEqual(result.structured.headings, [
        { level: 'h3', text: 'Download' },
        { level: 'h3', text: 'Docs by version' },
        { level: 'h1', text: 'Python 3.15.0 documentation' },
        { level: 'h2', text: 'Other resources' },
        { level: 'h3', text: 'Download' },
        { level: 'h2', text: 'Notes' },
        { level: 'h2', text: 'Notes' },
      ]);
      assert.deepEqual(result.structured.headings, catalog.headings);
      assert.equal(result.completeness.headingsOmitted, 0);
      assert.equal(result.completeness.complete, true);
      assert.deepEqual(result.completeness.reasons, []);
      assert.equal(result.structured.headings.filter(heading => heading.text === 'Notes').length, 2);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: 1, omitted: 0, reasons: [] });
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('heading completeness uses the post-dedupe set and stays separate from the inventory', async () => {
      const result = await tools.inspectPage(`${origin}/outline`);
      const catalog = catalogDocument(outlineDocument, `${origin}/outline`);
      assert.equal(catalog.completeness.headingsOmitted, 6);
      assert.equal(catalog.headings.length, HEADING_LIMIT);
      assert.deepEqual(result.structured.headings, catalog.headings);
      assert.equal(result.structured.headings.filter(heading => heading.text === 'Notes').length, 2);
      assert.equal(result.structured.headings.filter(heading => heading.text === 'Download').length, 1);
      assert.deepEqual(result.structured.headings.slice(0, 5), [
        { level: 'h3', text: 'Download' },
        { level: 'h3', text: 'Docs by version' },
        { level: 'h1', text: 'Guide' },
        { level: 'h2', text: 'Notes' },
        { level: 'h2', text: 'Notes' },
      ]);
      assert.equal(result.completeness.headingsKept, HEADING_LIMIT);
      assert.equal(result.completeness.headingsOmitted, 6);
      assert.equal(result.completeness.complete, false);
      assert.deepEqual(result.completeness.reasons, ['heading-cap']);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: 1, omitted: 0, reasons: [] });
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('body text truncation is incomplete even when the inventory is complete', async () => {
      const result = await tools.inspectPage(`${origin}/essay`);
      assert.equal(result.truncated, true);
      assert.equal(result.text.length, 18_000);
      assert.equal(result.completeness.complete, false);
      assert.deepEqual(result.completeness.reasons, ['text-cap']);
      assert.equal(result.completeness.headingsOmitted, 0);
      assert.equal(result.completeness.linksOmitted, 0);
      assert.deepEqual(result.structured.headings, [{ level: 'h1', text: 'Essay' }]);
      assert.deepEqual(result.accessibilityCompleteness, { complete: true, kept: 1, omitted: 0, reasons: [] });
      assert.equal(browsers.at(-1)?.isConnected(), false);
    });
    await t.test('a capped inventory does not mark link and heading extraction incomplete', async () => {
      const result = await tools.inspectPage(`${origin}/many`);
      assert.equal(result.completeness.complete, true);
      assert.deepEqual(result.completeness.reasons, []);
      assert.equal(result.completeness.linksOmitted, 0);
      assert.equal(result.completeness.headingsOmitted, 0);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.accessibilityCompleteness, { complete: false, kept: 60, omitted: 5, reasons: ['inventory-cap'] });
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
      await assert.rejects(createBrowserTools({ launch, validate, navigationTimeoutMs: 100 }).navigate(`${origin}/slow`), (error: unknown) => {
        assert.ok(error instanceof ExtractionTimeout);
        assert.equal(error.complete, false);
        assert.equal(error.failed, true);
        assert.equal(error.reason, 'timeout');
        assert.equal(error.timedOut, true);
        assert.equal(error.stage === 'fetch' || error.stage === 'navigation', true);
        assert.match(error.message, /timed out/);
        return true;
      });
      await assert.rejects(createBrowserTools({ launch, validate, timeoutMs: 1500 }).navigate(`${origin}/slow`), (error: unknown) => {
        assert.ok(error instanceof ExtractionTimeout);
        assert.equal(error.stage, 'deadline');
        assert.equal(error.complete, false);
        assert.match(error.message, /timed out/);
        return true;
      });
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
