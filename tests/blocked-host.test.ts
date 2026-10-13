import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createBrowserTools, launchBrowser } from '../agent/lib/browser.ts';
import { validateUrl } from '../agent/lib/policy.ts';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function shut(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('negative egress: production validation refuses non-allowlisted and private targets without DNS', async () => {
  await assert.rejects(validateUrl('https://not-approved.invalid/', 'example.com'), /outside the configured allowlist/);
  for (const raw of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://0x7f000001/', 'http://[2002:7f00:1::]/']) {
    await assert.rejects(validateUrl(raw, 'example.com'), /blocked|allowlist|supported/, raw);
  }
});

test('negative egress: a real browser on an allowed fixture never reaches a second, blocked local host', async () => {
  const canaryHits: string[] = [];
  const canary = createServer((request, response) => { canaryHits.push(request.url ?? ''); response.end('canary'); });
  const blocked = await listen(canary);
  const fixture = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: `${blocked}/via-redirect` }); response.end(); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Fixture</title><link rel="stylesheet" href="${blocked}/css"><link rel="prefetch" href="${blocked}/prefetch">
      <script src="${blocked}/js"></script></head><body><h1>Fixture</h1><img src="${blocked}/img"><iframe src="${blocked}/frame"></iframe>
      <video src="${blocked}/video"></video><form action="${blocked}/form"></form><a href="${blocked}/link">link</a></body></html>`);
  });
  const allowed = await listen(fixture);
  // The test seam admits exactly one origin; the blocked origin must be refused at every layer.
  const tools = createBrowserTools({
    launch: launchBrowser,
    validate: async raw => { const url = new URL(raw); if (url.origin !== allowed) throw new Error('Host is outside the approved list.'); return url; },
  });
  try {
    const result = await tools.inspectPage(`${allowed}/`);
    assert.equal(result.title, 'Fixture');
    await assert.rejects(tools.navigate(`${allowed}/redirect`), /approved list|blocked|supported/);
    await assert.rejects(tools.navigate(`${blocked}/direct`), /approved list/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(canaryHits, [], 'no request reached the blocked host');
    // Positive control: the canary is reachable, so zero hits above is meaningful.
    await (await fetch(`${blocked}/control`)).text();
    assert.deepEqual(canaryHits, ['/control']);
  } finally { await shut(fixture); await shut(canary); }
});
