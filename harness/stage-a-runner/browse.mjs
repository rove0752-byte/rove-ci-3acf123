// Browser job. The container has NO network (--network none): Chromium's proxy is a loopback forwarder that pipes
// to the proxy's unix socket, so the only reachable destination is the proxy.
import { chromium } from 'playwright';
import { createServer, connect } from 'node:net';
import { writeFileSync } from 'node:fs';
const OUT = '/scratch'; const urls = (process.env.URLS || '').split(' ').filter(Boolean);
const fwd = createServer(c => { const u = connect('/sock/proxy.sock'); c.pipe(u).pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); });
await new Promise(r => fwd.listen(8080, '127.0.0.1', r));
const b = await chromium.launch({ proxy: { server: 'http://127.0.0.1:8080', bypass: '<-loopback>' }, args: ['--no-sandbox'] });
const results = [];
for (const u of urls) {
  const p = await b.newPage();
  try { const r = await p.goto(u, { timeout: 15000, waitUntil: 'load' }); await p.waitForTimeout(500); results.push({ url: u, final: p.url(), status: r?.status(), title: await p.title() }); }
  catch (e) { results.push({ url: u, error: String(e.message).slice(0, 200) }); }
  writeFileSync(`${OUT}/browse.json`, JSON.stringify(results, null, 1), { mode: 0o600 });
  await p.close();
}
await b.close(); fwd.close();
