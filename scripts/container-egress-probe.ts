import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

type Outcome = 'hit' | 'fail';
type Counts = Record<string, number>;

const evidenceDir = '/evidence';
const attemptMs = 800;

function writeJson(path: string, value: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function readCounts(name: string): Counts {
  try {
    return JSON.parse(readFileSync(`${evidenceDir}/${name}.json`, 'utf8')) as Counts;
  } catch {
    return {};
  }
}

function emptyCounts(): Counts {
  return {
    tcp9: 0, tcp53: 0, tcp80: 0, tcp443: 0, tcp853: 0, tcp8080: 0,
    udp53: 0, udp443: 0, udp3478: 0, udp5353: 0, tcp80v6: 0, udp53v6: 0,
    other80: 0, proxy8888: 0,
  };
}

function listenTcp(port: number, host: string, ipv6Only: boolean, mark: (key: string) => void, key: string): Promise<void> {
  const server = createServer((_request, response) => {
    mark(key);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Fixture</title>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only }, () => resolve());
  });
}

async function runCanary(): Promise<void> {
  const name = process.env.CANARY_NAME;
  if (name !== 'canary-a' && name !== 'canary-b') throw new Error('Canary name is required.');
  const hits = emptyCounts();
  const persist = () => writeJson(`${evidenceDir}/${name}.json`, hits);
  const mark = (key: string) => { hits[key] = (hits[key] ?? 0) + 1; persist(); };
  const tcp = (port: number, key: string, host = '0.0.0.0', ipv6Only = false) => listenTcp(port, host, ipv6Only, mark, key);
  if (name === 'canary-a') {
    await tcp(9, 'tcp9');
    await tcp(53, 'tcp53');
    await tcp(80, 'tcp80');
    await tcp(443, 'tcp443');
    await tcp(853, 'tcp853');
    await tcp(8080, 'tcp8080');
    await udp(53, 'udp53', mark);
    await udp(443, 'udp443', mark);
    await udp(3478, 'udp3478', mark);
    await udp(5353, 'udp5353', mark);
    if (process.env.CANARY_IPV6 === '1') {
      await tcp(80, 'tcp80v6', '::', true);
      // Port 53 on :: is already used by the container resolver. 5300 is the IPv6 DNS canary.
      await udp(5300, 'udp53v6', mark, 'udp6');
    }
  } else {
    await tcp(80, 'other80');
    await tcp(8888, 'proxy8888');
  }
  hits.ready = 1;
  persist();
  await new Promise(() => {});
}

function udp(port: number, key: string, mark: (key: string) => void, family: 'udp4' | 'udp6' = 'udp4'): Promise<void> {
  const socket = createSocket(family);
  socket.on('message', (_message, remote) => {
    mark(key);
    socket.send('HIT', remote.port, remote.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, family === 'udp6' ? '::' : '0.0.0.0', () => resolve());
  });
}

function httpGet(host: string, port: number, family: 4 | 6): Promise<Outcome> {
  return new Promise(resolve => {
    const req = httpRequest({ host, port, family, path: '/', method: 'GET', timeout: attemptMs }, response => {
      response.resume();
      resolve(response.statusCode === 200 ? 'hit' : 'fail');
    });
    req.on('timeout', () => { req.destroy(); resolve('fail'); });
    req.on('error', () => resolve('fail'));
    req.end();
  });
}

function encodeDnsQuery(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4f56, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const parts: Buffer[] = [header];
  for (const label of name.split('.')) {
    const text = Buffer.from(label);
    if (text.length === 0 || text.length > 63) throw new Error('DNS label is invalid.');
    parts.push(Buffer.from([text.length]), text);
  }
  parts.push(Buffer.from([0, 0x00, 0x01, 0x00, 0x01]));
  return Buffer.concat(parts);
}

function dnsResponse(host: string, name: string): Promise<Outcome> {
  return new Promise(resolve => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve('fail'); }, attemptMs);
    socket.once('message', buffer => {
      clearTimeout(timer);
      socket.close();
      resolve(buffer.length >= 12 && (buffer[2] & 0x80) !== 0 ? 'hit' : 'fail');
    });
    socket.once('error', () => { clearTimeout(timer); socket.close(); resolve('fail'); });
    socket.send(encodeDnsQuery(name), 53, host, error => {
      if (error) { clearTimeout(timer); socket.close(); resolve('fail'); }
    });
  });
}

function udpGet(host: string, port: number, family: 'udp4' | 'udp6'): Promise<Outcome> {
  return new Promise(resolve => {
    const socket = createSocket(family);
    const timer = setTimeout(() => { socket.close(); resolve('fail'); }, attemptMs);
    socket.once('message', buffer => {
      clearTimeout(timer);
      socket.close();
      resolve(buffer.includes('HIT') ? 'hit' : 'fail');
    });
    socket.once('error', () => { clearTimeout(timer); socket.close(); resolve('fail'); });
    socket.send(Buffer.from([0]), port, host, error => {
      if (error) { clearTimeout(timer); socket.close(); resolve('fail'); }
    });
  });
}

function statusValue(field: string): string {
  const match = new RegExp(`^${field}:\\s*(\\S+)`, 'm').exec(readFileSync('/proc/self/status', 'utf8'));
  return match?.[1] ?? '';
}

function cleared(value: string): boolean {
  return /^0+$/.test(value);
}

async function runAgent(): Promise<void> {
  const canary = requiredIp('CANARY_IP');
  const other = requiredIp('CANARY2_IP');
  const canary6 = process.env.CANARY_IP6 || '';
  const ping = spawnSync('perl', ['-MSocket', '-e', icmpScript, canary], { encoding: 'utf8', timeout: 3_000 });
  let mapped: Outcome = 'fail';
  if (isIP(canary) === 4) mapped = await httpGet(`::ffff:${canary}`, 80, 6);
  let tcp80v6: Outcome = 'fail';
  let udp53v6: Outcome = 'fail';
  if (isIP(canary6) === 6) {
    tcp80v6 = await httpGet(canary6, 80, 6);
    udp53v6 = await udpGet(canary6, 5300, 'udp6');
  }
  const dnsName = process.env.ROVE_DNS_NAME ?? '';
  let dockerDns: Outcome = 'fail';
  if (dnsName) dockerDns = await dnsResponse('127.0.0.11', dnsName);
  let resolver: Outcome = 'fail';
  if (dnsName) {
    try {
      const found = await Promise.race([
        lookup(dnsName, { family: 4 }),
        delay(attemptMs).then(() => null),
      ]);
      resolver = found && isIP(found.address) ? 'hit' : 'fail';
    } catch { resolver = 'fail'; }
  }
  const result = {
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    tcp9: await httpGet(canary, 9, 4),
    tcp53: await httpGet(canary, 53, 4),
    udp53: await udpGet(canary, 53, 'udp4'),
    udp5353: await udpGet(canary, 5353, 'udp4'),
    tcp853: await httpGet(canary, 853, 4),
    tcp80: await httpGet(canary, 80, 4),
    other80: await httpGet(other, 80, 4),
    mapped80: mapped,
    tcp80v6,
    udp53v6,
    dockerDns,
    resolver,
    icmp: ping.status === 0 ? 'hit' as const : 'fail' as const,
  };
  process.stdout.write(`AGENT_RESULT ${JSON.stringify(result)}\n`);
}

// Datagram ICMP avoids ping's file capability, which cannot execute once the bounding set is empty.
const icmpScript = `my $host = shift;
socket(my $s, PF_INET, SOCK_DGRAM, getprotobyname('icmp')) or die $!;
my $payload = 'rove-icmp';
my $sum = 0;
my $data = pack('C2 n3', 8, 0, 0, 1, 1) . $payload;
$data .= "\\0" if length($data) % 2;
for (my $i = 0; $i < length($data); $i += 2) { $sum += unpack('n', substr($data, $i, 2)); }
while ($sum >> 16) { $sum = ($sum & 0xffff) + ($sum >> 16); }
my $pkt = pack('C2 n3', 8, 0, (~$sum) & 0xffff, 1, 1) . $payload;
send($s, $pkt, 0, sockaddr_in(0, inet_aton($host))) or die $!;
my $rin = '';
vec($rin, fileno($s), 1) = 1;
exit(select($rin, undef, undef, 0.8) ? 0 : 2);
`;

function requiredIp(name: string): string {
  const value = process.env[name] ?? '';
  if (!isIP(value)) throw new Error(`${name} must be an IP literal.`);
  return value;
}

async function gatherIce(page: import('playwright').Page, address: string): Promise<void> {
  await page.setContent('<!doctype html><title>probe</title>', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (stun: { address: string; port: number }) => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:${stun.address}:${stun.port}` }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1_500);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    peer.close();
  }, { address, port: 3478 });
}

async function chromiumPass(canary: string, other: string): Promise<{ direct: Outcome; quic: Outcome; webrtc: Outcome; proxy: Outcome; pids: number[] }> {
  const { chromium } = await import('playwright');
  const pids = new Set<number>();
  const note = () => {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const command = readFileSync(`/proc/${entry}/cmdline`).toString();
        if (command.includes('chrom')) pids.add(Number(entry));
      } catch { /* exited */ }
    }
  };
  const launch = async (args: string[], proxy?: string) => {
    const browser = await chromium.launch({
      headless: true,
      timeout: 20_000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...args],
      ...(proxy ? { proxy: { server: proxy } } : {}),
    });
    note();
    return browser;
  };

  let direct: Outcome = 'fail';
  let webrtc: Outcome = 'fail';
  const beforeIce = readCounts('canary-a').udp3478 ?? 0;
  const directBrowser = await launch([]);
  try {
    const page = await directBrowser.newPage();
    const response = await page.goto(`http://${canary}:8080/`, { timeout: 4_000 }).catch(() => null);
    direct = response?.ok() ? 'hit' : 'fail';
    await gatherIce(page, canary).catch(() => undefined);
    await delay(300);
  } finally { await directBrowser.close(); }
  webrtc = (readCounts('canary-a').udp3478 ?? 0) > beforeIce ? 'hit' : 'fail';

  const beforeQuic = readCounts('canary-a').udp443 ?? 0;
  const quicBrowser = await launch(['--enable-quic', `--origin-to-force-quic-on=${canary}:443`]);
  let quic: Outcome = 'fail';
  try {
    const page = await quicBrowser.newPage();
    await page.goto(`https://${canary}:443/`, { timeout: 3_000 }).catch(() => undefined);
    await delay(800);
  } finally { await quicBrowser.close(); }
  quic = (readCounts('canary-a').udp443 ?? 0) > beforeQuic ? 'hit' : 'fail';

  const beforeProxy = readCounts('canary-b').proxy8888 ?? 0;
  const proxyBrowser = await launch([], `http://${other}:8888`);
  let proxy: Outcome = 'fail';
  try {
    const page = await proxyBrowser.newPage();
    await page.goto(`http://${canary}:8080/`, { timeout: 4_000 }).catch(() => undefined);
    await delay(200);
  } finally { await proxyBrowser.close(); }
  proxy = (readCounts('canary-b').proxy8888 ?? 0) > beforeProxy ? 'hit' : 'fail';
  return { direct, quic, webrtc, proxy, pids: [...pids] };
}

async function runProbe(): Promise<void> {
  const canary = requiredIp('CANARY_IP');
  const other = requiredIp('CANARY2_IP');
  const mode = process.env.ROVE_EGRESS_MODE;
  if (mode !== 'control' && mode !== 'enforce') throw new Error('Egress mode is required.');
  const loopback = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('HIT');
  });
  await new Promise<void>((resolve, reject) => {
    loopback.once('error', reject);
    loopback.listen(0, '127.0.0.1', () => resolve());
  });
  const loopPort = (loopback.address() as { port: number }).port;
  const loopResult = await httpGet('127.0.0.1', loopPort, 4);
  loopback.close();

  const filterChange = spawnSync('iptables', ['-A', 'OUTPUT', '-j', 'ACCEPT'], { encoding: 'utf8', timeout: 2_000 });
  const natChange = spawnSync('iptables', ['-t', 'nat', '-A', 'OUTPUT', '-j', 'ACCEPT'], { encoding: 'utf8', timeout: 2_000 });
  const iptables = { status: filterChange.status === 0 || natChange.status === 0 ? 0 : 1 };
  let sysctlBlocked = true;
  try {
    writeFileSync('/proc/sys/net/ipv4/ip_forward', '1');
    sysctlBlocked = false;
  } catch { sysctlBlocked = true; }

  const beforeA = readCounts('canary-a');
  const beforeB = readCounts('canary-b');
  const agent = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--agent-only'], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Agent probe timed out.')); }, 30_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(item => item.startsWith('AGENT_RESULT '));
      if (!line) reject(new Error(`Agent probe produced no result: ${stdout}`));
      else resolve(JSON.parse(line.slice('AGENT_RESULT '.length)) as Record<string, unknown>);
    });
  });
  const chromium = await chromiumPass(canary, other);
  const result = {
    mode,
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    capEff: statusValue('CapEff'),
    capBnd: statusValue('CapBnd'),
    capsDropped: cleared(statusValue('CapEff')) && cleared(statusValue('CapBnd')),
    iptablesBlocked: iptables.status !== 0,
    sysctlBlocked,
    loopback: loopResult,
    policy: JSON.parse(readFileSync('/run/rove/egress-policy.json', 'utf8')) as unknown,
    agent,
    chromium,
    afterA: readCounts('canary-a'),
    afterB: readCounts('canary-b'),
    beforeA,
    beforeB,
  };
  writeJson(`${evidenceDir}/result-${mode}.json`, result);
  process.stdout.write(`CONTAINER_EGRESS_RESULT ${JSON.stringify({ mode, pid: result.pid, agentPid: agent.pid, capsDropped: result.capsDropped })}\n`);
}

const command = process.argv[2];
if (command === '--canary') await runCanary();
else if (command === '--agent-only') await runAgent();
else await runProbe();
