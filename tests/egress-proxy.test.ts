import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer as createNetServer, type AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { publicAddress } from '../agent/lib/public-address.ts';
import { isolatedChromiumArgs, startDenyEgressProxy } from '../agent/lib/egress-proxy.ts';

function proxyRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Egress proxy did not deny promptly.')); }, 1000);
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('the deny proxy stops destinations that application address checks would allow', async () => {
  assert.equal(publicAddress('93.184.216.34'), true);
  const args = isolatedChromiumArgs(9);
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(args.includes('--disable-quic'));
  assert.equal(args.includes('--proxy-server=http://127.0.0.1:9'), true);
  let canaryHits = 0;
  const canary = createNetServer(socket => { canaryHits++; socket.destroy(); });
  await new Promise<void>(resolve => canary.listen(0, '127.0.0.1', () => resolve()));
  const canaryPort = (canary.address() as AddressInfo).port;
  const proxy = await startDenyEgressProxy();
  try {
    assert.equal(proxy.address, '127.0.0.1');
    const publicConnect = await proxyRequest(proxy.port, 'CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\n\r\n');
    const canaryConnect = await proxyRequest(proxy.port, `CONNECT 127.0.0.1:${canaryPort} HTTP/1.1\r\nHost: 127.0.0.1:${canaryPort}\r\n\r\n`);
    const canaryGet = await proxyRequest(proxy.port, `GET http://127.0.0.1:${canaryPort}/secret HTTP/1.1\r\nHost: 127.0.0.1:${canaryPort}\r\n\r\n`);
    assert.match(publicConnect, /^HTTP\/1\.1 403/);
    assert.match(canaryConnect, /^HTTP\/1\.1 403/);
    assert.match(canaryGet, /^HTTP\/1\.1 403/);
    assert.equal(canaryHits, 0);
    assert.deepEqual(proxy.attempts.map(attempt => attempt.decision), ['deny', 'deny', 'deny']);
    await new Promise<void>((resolve, reject) => {
      canary.once('connection', () => resolve());
      const probe = createConnection({ host: '127.0.0.1', port: canaryPort });
      probe.on('connect', () => probe.end());
      probe.on('error', reject);
    });
    assert.equal(canaryHits, 1);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => canary.close(() => resolve()));
  }
});

test('a separate proxy process blocks Chromium egress that reaches a local server without it', async () => {
  const hits: string[] = [];
  const canary = createHttpServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('canary');
  });
  await new Promise<void>(resolve => canary.listen(0, '127.0.0.1', () => resolve()));
  const port = (canary.address() as AddressInfo).port;
  const target = `http://127.0.0.1:${port}/`;
  const open = await chromium.launch({ headless: true, timeout: 15_000 });
  try {
    const page = await open.newPage();
    const response = await page.goto(target, { timeout: 8_000 });
    assert.equal(response?.status(), 200);
    assert.deepEqual(hits, ['/']);
  } finally { await open.close(); }
  hits.length = 0;

  const script = fileURLToPath(new URL('../agent/lib/egress-proxy.ts', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let proxyError = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { proxyError += chunk; });
  const proxyPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Egress proxy did not start. ${proxyError}`)), 5_000);
    child.stdout.on('data', () => {
      const match = output.match(/"event":"listening","port":(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Egress proxy exited ${code}. ${proxyError}`)); });
  });
  const isolated = await chromium.launch({ headless: true, timeout: 15_000, args: isolatedChromiumArgs(proxyPort) });
  try {
    const page = await isolated.newPage();
    const response = await page.goto(target, { timeout: 8_000 }).catch(() => undefined);
    const body = await page.locator('body').textContent({ timeout: 1_000 }).catch(() => '');
    assert.equal(hits.length, 0, `canary received ${JSON.stringify(hits)}; status ${response?.status()}; body ${body}; proxy ${output}; ${proxyError}`);
    assert.notEqual(body, 'canary');
    assert.match(output, new RegExp(`"event":"deny","host":"127\\.0\\.0\\.1","port":${port}`));
  } finally {
    await isolated.close();
    child.kill('SIGTERM');
    await new Promise<void>(resolve => canary.close(() => resolve()));
  }
});