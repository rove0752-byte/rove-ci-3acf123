import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { BrowserStopped, createBrowserTools, launchBrowser } from '../agent/lib/browser.ts';

// All descendants of this test process (Chrome, its helpers and the isolation process).
function descendants(root = process.pid): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number) as [number, number]);
  const found: number[] = [];
  const walk = (parent: number) => { for (const [pid, ppid] of rows) if (ppid === parent && pid !== process.pid) { found.push(pid); walk(pid); } };
  walk(root);
  return found;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('kill switch: stop() ends a hanging real-browser visit within 5s and leaves no Chrome or helper processes', async () => {
  let hit: () => void = () => {};
  const reached = new Promise<void>(resolve => { hit = resolve; });
  // Local fixture only: the page never responds.
  const server = createServer(() => { hit(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const tools = createBrowserTools({
    launch: launchBrowser,
    validate: async raw => { const url = new URL(raw); assert.equal(url.origin, origin); return url; },
    timeoutMs: 60_000, navigationTimeoutMs: 60_000,
  });
  const before = new Set(descendants());
  try {
    const visit = tools.navigate(`${origin}/hang`);
    void visit.catch(() => {});
    await reached;
    const spawned = descendants().filter(pid => !before.has(pid));
    assert.ok(spawned.length >= 2, `Chrome and the isolation process are running (${spawned.length})`);
    const started = Date.now();
    const count = await tools.stop();
    await assert.rejects(visit, (error: unknown) => error instanceof BrowserStopped);
    const elapsed = Date.now() - started;
    assert.equal(count, 1);
    assert.ok(elapsed < 5_000, `stopped in ${elapsed}ms`);
    // Allow the OS to reap; then nothing launched by this visit may remain.
    const deadline = Date.now() + 2_000;
    while (spawned.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(spawned.filter(alive), [], 'no orphaned processes');
    assert.equal(await tools.stop(), 0, 'stop with nothing running is a no-op');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
