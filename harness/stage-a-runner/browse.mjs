// Browser job: Chromium through the egress proxy only. It is on an internal network whose only other member is the proxy.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const OUT = '/evidence'; const urls = (process.env.URLS || '').split(' ').filter(Boolean);
const b = await chromium.launch({ proxy: { server: 'http://proxy:8080', bypass: '<-loopback>' }, args: ['--no-sandbox'] });
const results = [];
for (const u of urls) {
  const p = await b.newPage();
  try { const r = await p.goto(u, { timeout: 15000, waitUntil: 'load' }); await p.waitForTimeout(500); results.push({ url: u, status: r?.status(), title: await p.title() }); }
  catch (e) { results.push({ url: u, error: String(e.message).slice(0, 200) }); }
  writeFileSync(`${OUT}/browse.json`, JSON.stringify(results, null, 1), { mode: 0o600 });
  await p.close();
}
await b.close();
