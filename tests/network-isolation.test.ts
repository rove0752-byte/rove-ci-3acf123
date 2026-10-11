import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { createBrowserTools, launchBrowser, networkIsolationFor } from '../agent/lib/browser.ts';
import { mandatoryChromiumArgs, startIsolatedNetwork } from '../agent/lib/egress-proxy.ts';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lsof(port: number): string {
  let last = '';
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      last = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
      if (last.includes('->')) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  return last;
}

function clientPids(output: string, serverPort: number): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const pid = /^\S+\s+(\d+)\s/.exec(line)?.[1];
    const link = /127\.0\.0\.1:(\d+)->127\.0\.0\.1:(\d+)/.exec(line);
    if (pid && link && link[2] === String(serverPort) && link[1] !== String(serverPort)) pids.push(Number(pid));
  }
  return pids;
}

function chromiumCommand(proxyPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-ax', '-ww', '-o', 'args='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.split('\n').find(line => line.includes(`--proxy-server=http://127.0.0.1:${proxyPort}`)) ?? '');
    });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('the isolation process rejects DNS, QUIC, UDP and raw sockets, and dials only a pinned literal', async () => {
  const proxySource = readFileSync(new URL('../agent/lib/egress-proxy.ts', import.meta.url), 'utf8');
  const browserSource = readFileSync(new URL('../agent/lib/browser.ts', import.meta.url), 'utf8');
  assert.equal(/node:dns/.test(proxySource), false);
  assert.equal(/dns\.lookup/.test(proxySource), false);
  assert.equal(browserSource.includes("from 'node:http'"), false);
  assert.equal(browserSource.includes("from 'node:https'"), false);
  const args = mandatoryChromiumArgs(9, ['--enable-quic', '--no-sandbox', '--origin-to-force-quic-on=127.0.0.1:443', '--proxy-server=http://evil:1', '--host-resolver-rules=MAP * 127.0.0.1', '--no-proxy-server']);
  assert.equal(args.includes('--enable-quic'), false);
  assert.equal(args.includes('--no-proxy-server'), false);
  assert.equal(args.includes('--proxy-server=http://evil:1'), false);
  assert.equal(args.includes('--no-sandbox'), true);
  assert.equal(args.includes('--host-resolver-rules=MAP * 127.0.0.1'), false);
  assert.ok(args.some(arg => arg.includes('MAP * ~NOTFOUND')));
  assert.ok(args.indexOf('--disable-quic') > args.indexOf('--no-sandbox'));

  const hits: { url: string | undefined; host: string | undefined }[] = [];
  const sockets: string[] = [];
  const server = createServer((request, response) => {
    const address = server.address();
    if (address && typeof address !== 'string') sockets.push(lsof(address.port));
    hits.push({ url: request.url, host: request.headers.host });
    response.setHeader('content-type', 'text/plain');
    response.end('pinned');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const network = await startIsolatedNetwork();
  try {
    const base = { port, https: false, servername: 'dns.bypass.invalid', hostHeader: 'dns.bypass.invalid', path: '/pinned', timeoutMs: 2_000 };
    await assert.rejects(network.request({ op: 'resolve', host: 'dns.bypass.invalid' }), /Unsupported network operation/);
    await assert.rejects(network.request({ op: 'connect', address: '127.0.0.1', port }), /Unsupported network operation/);
    await assert.rejects(network.request({ op: 'fetch', transport: 'quic', address: '127.0.0.1', family: 4, ...base }), /Unsupported network operation/);
    await assert.rejects(network.request({ op: 'fetch', transport: 'udp', address: '127.0.0.1', family: 4, ...base }), /Unsupported network operation/);
    await assert.rejects(network.request({ op: 'fetch', address: 'dns.bypass.invalid', family: 4, ...base }), /literal IP/);
    assert.equal(hits.length, 0);
    assert.equal(network.dials.length, 0);
    const document = await network.request({ op: 'fetch', address: '127.0.0.1', family: 4, ...base });
    assert.equal(document.status, 200);
    assert.equal(document.body.toString('utf8'), 'pinned');
    assert.deepEqual(hits, [{ url: '/pinned', host: 'dns.bypass.invalid' }]);
    const clients = clientPids(sockets.join('\n'), port);
    assert.equal(clients.includes(process.pid), false, sockets.join('\n'));
    assert.equal(clients.includes(network.pid), true, sockets.join('\n'));
    assert.equal(network.dials.some(dial => dial.pid === network.pid && dial.address === '127.0.0.1' && dial.port === port), true);
    assert.notEqual(network.pid, process.pid);
  } finally {
    await network.close();
    assert.equal(alive(network.pid), false);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('document fetching follows the pinned literal and ignores URL host and extra addresses', async () => {
  const hits: { url: string | undefined; host: string | undefined }[] = [];
  const server = createServer((request, response) => {
    hits.push({ url: request.url, host: request.headers.host });
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Pinned</title><body>pinned</body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const browsers: Browser[] = [];
  const launch = async () => { const browser = await launchBrowser(); browsers.push(browser); return browser; };
  try {
    const opened = await createBrowserTools({
      launch,
      validate: async raw => new URL(raw),
      resolve: async url => {
        assert.equal(url.hostname, 'unresolved.invalid');
        return [{ address: '127.0.0.1', family: 4 }];
      },
    }).navigate(`http://unresolved.invalid:${port}/ok`);
    assert.equal(opened.title, 'Pinned');
    assert.deepEqual(hits, [{ url: '/ok', host: `unresolved.invalid:${port}` }]);
    const missed: string[] = [];
    const v6 = createServer((request, response) => {
      missed.push(request.url ?? '');
      response.end('hit');
    });
    await new Promise<void>(resolve => v6.listen(0, '::1', () => resolve()));
    const v6port = (v6.address() as AddressInfo).port;
    try {
      // The URL names the listening v6 canary. The first pin is a closed v4 port, so a DNS or
      // URL-host dial would be observed and a later address must not be used as a fallback.
      await assert.rejects(createBrowserTools({
        launch,
        validate: async raw => new URL(raw),
        resolve: async () => [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ],
      }).navigate(`http://[::1]:${v6port}/bypass`), /Navigation failed/);
      assert.deepEqual(missed, []);
    } finally {
      v6.closeAllConnections();
      await new Promise<void>(resolve => v6.close(() => resolve()));
    }
  } finally {
    await Promise.all(browsers.map(browser => browser.close().catch(() => undefined)));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('launchBrowser blocks direct sockets and advertises the mandatory Chromium flags', async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end('canary');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const open = await chromium.launch({ headless: true, timeout: 15_000 });
  try {
    const page = await open.newPage();
    assert.equal((await page.goto(`http://127.0.0.1:${port}/open`, { timeout: 8_000 }))?.status(), 200);
    assert.deepEqual(hits, ['/open']);
  } finally { await open.close(); }
  hits.length = 0;

  const browser = await launchBrowser();
  const network = networkIsolationFor(browser);
  try {
    const argv = await chromiumCommand(network.port);
    assert.notEqual(argv, '');
    for (const flag of ['--disable-quic', '--disable-http3', '--dns-prefetch-disable', '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', 'MAP * ~NOTFOUND']) {
      assert.equal(argv.includes(flag), true, argv);
    }
    assert.equal(argv.includes(`--proxy-server=http://127.0.0.1:${network.port}`), true, argv);
    assert.equal(argv.includes('--enable-quic'), false, argv);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/direct`, { timeout: 8_000 }).catch(() => undefined);
    await page.goto(`http://localhost:${port}/dns`, { timeout: 8_000 }).catch(() => undefined);
    for (let attempt = 0; network.denials.length < 1 && attempt < 50; attempt++) await delay(20);
    assert.equal(hits.length, 0, JSON.stringify(hits));
    assert.equal(network.denials.some(denial => denial.host === '127.0.0.1' && denial.port === port), true);
    assert.equal(network.denials.some(denial => denial.host === 'localhost' && denial.port === port), true);
  } finally { await browser.close(); }
  assert.equal(alive(network.pid), false);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function gatherIce(page: import('playwright').Page, port: number) {
  await page.setContent('<!doctype html><title>probe</title>', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async stunPort => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${stunPort}` }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1_500);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    peer.close();
  }, port);
}

test('Chromium cannot bypass isolation with WebRTC or QUIC', { timeout: 60_000 }, async () => {
  const packets: Buffer[] = [];
  const udp = createSocket('udp4');
  udp.on('message', message => packets.push(Buffer.from(message)));
  await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', () => resolve()));
  const port = udp.address().port;
  await new Promise<void>((resolve, reject) => udp.send(Buffer.from('listener'), port, '127.0.0.1', error => error ? reject(error) : resolve()));
  await delay(50);
  assert.equal(packets.length > 0, true);
  packets.length = 0;

  const positive = await chromium.launch({ headless: true, timeout: 15_000 });
  try {
    await gatherIce(await positive.newPage(), port);
    await delay(300);
    assert.equal(packets.length > 0, true, 'WebRTC control produced no UDP packet');
  } finally { await positive.close(); }
  const afterWebRtc = packets.length;

  const quic = await chromium.launch({
    headless: true, timeout: 15_000,
    args: ['--enable-quic', `--origin-to-force-quic-on=127.0.0.1:${port}`],
  });
  try {
    const page = await quic.newPage();
    await page.goto(`https://127.0.0.1:${port}/`, { timeout: 3_000 }).catch(() => undefined);
    for (let attempt = 0; packets.length === afterWebRtc && attempt < 40; attempt++) await delay(50);
    assert.equal(packets.length > afterWebRtc, true, 'QUIC control produced no UDP packet');
  } finally { await quic.close(); }
  const afterQuic = packets.length;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await gatherIce(page, port);
    await page.goto(`https://127.0.0.1:${port}/`, { timeout: 3_000 }).catch(() => undefined);
    await delay(1_000);
    assert.equal(packets.length, afterQuic);
  } finally {
    await browser.close();
    udp.close();
  }
});
