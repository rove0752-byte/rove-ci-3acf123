// A3-local dry run: synthetic fixtures on 127.0.0.1 only. Imports the integration code from this worktree.
// Evidence is written and checksum-verified after every step; any save failure aborts the run (exit 2).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserTools, launchBrowser } from '../../agent/lib/browser.ts';
import { validateUrl } from '../../agent/lib/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? join(here, 'evidence', new Date().toISOString().replace(/[:.]/g, '-'));
const KILL_FILE = process.env.A3_KILL_FILE ?? join(OUT, 'KILL');
const PAGES = (process.env.A3_PAGES ?? 'simple,links,jsonld,table,nav').split(',');
try { mkdirSync(join(OUT, 'screenshots'), { recursive: true }); } catch (error) { console.error(`EVIDENCE DIR FAILED: ${(error as Error).message}`); process.exit(2); }
const manifest = join(OUT, 'SHA256SUMS');
const sums = new Map<string, string>();

function save(name: string, data: string | Buffer) {
  const path = join(OUT, name);
  try {
    writeFileSync(path, data);
    const fd = openSync(path, 'r'); fsyncSync(fd); closeSync(fd);
    const want = createHash('sha256').update(data).digest('hex');
    const got = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (want !== got) throw new Error('checksum mismatch after write');
    sums.set(name, got);
    // Rewritten each step, so the manifest always lists the latest hash of every file.
    writeFileSync(manifest, [...sums].map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n');
  } catch (error) {
    console.error(`EVIDENCE SAVE FAILED for ${name}: ${(error as Error).message}`);
    process.exit(2);
  }
}
const log: string[] = [];
const event = (line: string) => { log.push(`${new Date().toISOString()} ${line}`); save('events.log', log.join('\n') + '\n'); };

// Loopback-only allow-list: the only origin the validate seam admits is this run's fixture server.
const hits: string[] = [];
const server = createServer((req, res) => {
  hits.push(req.url ?? '');
  const name = (req.url ?? '/').replace(/^\//, '').split('?')[0];
  if (name === 'hang') return; // deliberately never responds (kill-switch tests only)
  const file = join(here, 'fixtures', `${name}.html`);
  if (!/^[a-z]+$/.test(name) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', 'text/html'); res.end(readFileSync(file));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const canaryHits: string[] = [];
const canary = createServer((req, res) => { canaryHits.push(req.url ?? ''); res.end(); });
await new Promise<void>(resolve => canary.listen(0, '127.0.0.1', resolve));
const blockedOrigin = `http://127.0.0.1:${(canary.address() as { port: number }).port}`;
const validate = async (raw: string) => {
  const url = new URL(raw);
  if (url.origin !== origin) throw new Error('A3-local allow-list: only the loopback fixture origin is permitted.');
  return url;
};
const tools = createBrowserTools({ launch: launchBrowser, validate, timeoutMs: 30_000 });

let stopping = false;
async function shutdown(reason: string, code: number) {
  if (stopping) return; stopping = true;
  const stopped = await tools.stop();
  event(`shutdown reason=${reason} visitsStopped=${stopped}`);
  server.closeAllConnections(); server.close(); canary.closeAllConnections(); canary.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT', 130));
process.on('SIGTERM', () => void shutdown('SIGTERM', 143));
const watchdog = setInterval(() => { if (existsSync(KILL_FILE)) void shutdown('kill-file', 137); }, 200);

event(`start origin=${origin} pages=${PAGES.join(',')} pid=${process.pid}`);
// Negative tests first: nothing outside the loopback fixture origin may be admitted.
const negatives: { target: string; blocked: boolean; detail: string }[] = [];
for (const target of ['https://example.com/', `${blockedOrigin}/x`, 'http://169.254.169.254/']) {
  try { await tools.navigate(target); negatives.push({ target, blocked: false, detail: 'ADMITTED' }); }
  catch (error) { negatives.push({ target, blocked: true, detail: (error as Error).message }); }
}
try { await validateUrl('https://example.com/', '127.0.0.1'); negatives.push({ target: 'prod validateUrl example.com (allow 127.0.0.1)', blocked: false, detail: 'ADMITTED' }); }
catch (error) { negatives.push({ target: 'prod validateUrl example.com (allow 127.0.0.1)', blocked: true, detail: (error as Error).message }); }
save('negative-tests.json', JSON.stringify({ negatives, canaryHits: [...canaryHits] }, null, 2));
event(`negatives blocked=${negatives.filter(n => n.blocked).length}/${negatives.length} canaryHits=${canaryHits.length}`);
if (negatives.some(n => !n.blocked) || canaryHits.length) { event('NEGATIVE TEST FAILED'); await shutdown('negative-failed', 3); }

for (const name of PAGES) {
  const started = Date.now();
  try {
    const result = await tools.inspectPage(`${origin}/${name}`);
    const { screenshotBase64, ...rest } = result as typeof result & { screenshotBase64: string | null };
    if (screenshotBase64) save(`screenshots/${name}.png`, Buffer.from(screenshotBase64, 'base64'));
    save(`${name}.json`, JSON.stringify({ ...rest, durationMs: Date.now() - started }, null, 2));
    event(`page ${name} ok ${Date.now() - started}ms`);
  } catch (error) {
    save(`${name}.json`, JSON.stringify({ error: (error as Error).name, message: (error as Error).message }, null, 2));
    event(`page ${name} error ${(error as Error).message}`);
  }
}
save('network.json', JSON.stringify({ fixtureHits: hits, canaryHits }, null, 2));
clearInterval(watchdog);
event('done');
await shutdown('complete', 0);
