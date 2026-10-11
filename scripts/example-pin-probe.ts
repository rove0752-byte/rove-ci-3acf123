import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { externalAccepts } from '../agent/lib/container-egress.ts';
import { publicAddress } from '../agent/lib/public-address.ts';

type Policy = {
  enforced: boolean;
  pilot: string;
  publicBrowserPilot: boolean;
  localFixture: boolean;
  exampleRead: { host: string; address: string; port: number; answers: string[] } | null;
  structuredRead?: unknown;
  ipv4: string;
  ipv6: string;
};

const policy = JSON.parse(readFileSync('/run/rove/egress-policy.json', 'utf8')) as Policy;
const pin = policy.exampleRead;
if (!policy.enforced || policy.pilot !== 'off' || policy.publicBrowserPilot || policy.localFixture || policy.structuredRead || !pin) {
  throw new Error('Example read pin was not installed.');
}
if (pin.host !== 'example.com' || pin.port !== 443 || !publicAddress(pin.address)) {
  throw new Error('Example read pin was not installed.');
}
const pinned = pin.address;

function tcp(address: string, port: number): Promise<string> {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return Promise.resolve('closed');
  return new Promise(resolve => {
    const socket = connect({ host: address, port, family });
    const timer = setTimeout(() => { socket.destroy(); resolve('closed'); }, 3_000);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve('open'); });
    socket.once('error', () => { clearTimeout(timer); resolve('closed'); });
  });
}

function udp(address: string, port: number): Promise<string> {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return Promise.resolve('closed');
  return new Promise(resolve => {
    const socket = createSocket(family === 6 ? 'udp6' : 'udp4');
    const timer = setTimeout(() => { socket.close(); resolve('closed'); }, 1_500);
    socket.once('message', () => { clearTimeout(timer); socket.close(); resolve('open'); });
    socket.once('error', () => { clearTimeout(timer); resolve('closed'); });
    socket.send(Buffer.from('x'), port, address);
  });
}

function tlsHandshake(): Promise<{ open: boolean; authorized: boolean; exampleName: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    const socket = tlsConnect({
      host: pinned,
      port: 443,
      servername: 'example.com',
      rejectUnauthorized: true,
    });
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const certificate = open ? socket.getPeerCertificate() : undefined;
      const names = `${certificate?.subjectaltname ?? ''},${certificate?.subject?.CN ?? ''}`;
      const exampleName = names.split(/,\s*/).some(item => item === 'DNS:example.com' || item === 'example.com');
      const authorized = open && socket.authorized;
      socket.destroy();
      resolve({ open, authorized, exampleName });
    };
    const timer = setTimeout(() => finish(false), 8_000);
    socket.once('secureConnect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const loopback = await new Promise<string>(resolve => {
  const server = createServer(socket => socket.end('ok'));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    void tcp('127.0.0.1', port).then(result => { server.close(); resolve(result); });
  });
});

const others = pin.answers.filter(address => address !== pin.address);
const alternate = pin.address === '1.1.1.1' ? '9.9.9.9' : '1.1.1.1';
const resolver = await Promise.race([
  lookup('example.com', { all: true }).then(() => 'open', () => 'closed'),
  new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 2_000)),
]);
const icmpScript = `my $host = shift;
socket(my $s, PF_INET, SOCK_DGRAM, getprotobyname("icmp")) or do { print "socket $!\\n"; exit 2; };
my $payload = "rove-icmp";
my $sum = 0;
my $data = pack("C2 n3", 8, 0, 0, 1, 1) . $payload;
$data .= "\\0" if length($data) % 2;
for (my $i = 0; $i < length($data); $i += 2) { $sum += unpack("n", substr($data, $i, 2)); }
while ($sum >> 16) { $sum = ($sum & 0xffff) + ($sum >> 16); }
my $pkt = pack("C2 n3", 8, 0, (~$sum) & 0xffff, 1, 1) . $payload;
send($s, $pkt, 0, sockaddr_in(0, inet_aton($host))) or do { print "send $!\\n"; exit 3; };
my $rin = "";
vec($rin, fileno($s), 1) = 1;
my $got = select($rin, undef, undef, 1);
if (!defined $got || $got < 0) { print "select $!\\n"; exit 4; }
if ($got == 0) { print "silent\\n"; exit 1; }
my $buf = "";
defined recv($s, $buf, 64, 0) or do { print "recv $!\\n"; exit 4; };
my $type = unpack("C", $buf);
print "recv type=$type\\n";
exit($type == 0 ? 0 : 1);
`;
const icmp = spawnSync('perl', ['-MSocket', '-e', icmpScript, pin.address], { encoding: 'utf8', timeout: 3_000 });
const icmpDetail = `${icmp.stdout ?? ''}${icmp.stderr ?? ''}`.trim();
const icmpResult = icmp.error || icmp.status === null
  ? 'inconclusive'
  : icmp.status === 0
    ? 'open'
    : icmp.status === 1
      ? 'closed'
      : icmp.status === 3 && /Operation not permitted|Permission denied/.test(icmpDetail)
        ? 'closed'
        : 'inconclusive';

const rules = `${policy.ipv4}\n${policy.ipv6}`;
const accepts = externalAccepts(rules);
const tls = await tlsHandshake();
const result = {
  address: pin.address,
  answers: pin.answers,
  tls,
  loopback,
  pin80: await tcp(pin.address, 80),
  pinUdp443: await udp(pin.address, 443),
  other443: await tcp(alternate, 443),
  dnsTcp: await tcp('8.8.8.8', 53),
  dnsUdp: await udp('8.8.8.8', 53),
  otherAnswers: await Promise.all(others.map(async address => ({ address, result: await tcp(address, 443) }))),
  resolver,
  icmp: icmpResult,
  icmpDetail,
  accepts: accepts.length,
  acceptShape: accepts.every(line => line.includes(pin.address) && line.includes('-p tcp') && line.includes('443') && line.includes('rove-example')),
  quicDrop: rules.includes('rove-raw-deny-quic') && rules.includes('rove-deny-quic'),
  dnsDenied: policy.ipv4.includes('rove-deny-dns') && policy.ipv6.includes('rove-deny-dns'),
  icmpDenied: policy.ipv4.includes('rove-deny-icmp') && policy.ipv6.includes('rove-deny-icmp'),
  outputDrop: /\*filter[\s\S]*:OUTPUT DROP/.test(policy.ipv4) && /\*filter[\s\S]*:OUTPUT DROP/.test(policy.ipv6),
  udpAccept: accepts.some(line => line.includes('-p udp')),
};
const passed = tls.open && tls.authorized && tls.exampleName && loopback === 'open' && result.pin80 === 'closed' &&
  result.pinUdp443 === 'closed' && result.other443 === 'closed' && result.dnsTcp === 'closed' && result.dnsUdp === 'closed' &&
  result.otherAnswers.every(item => item.result === 'closed') && resolver === 'closed' && result.icmp === 'closed' &&
  result.accepts === 2 && result.acceptShape && result.quicDrop && result.dnsDenied && result.icmpDenied &&
  result.outputDrop && !result.udpAccept;
mkdirSync('/evidence', { recursive: true });
writeFileSync('/evidence/example-pin.json', JSON.stringify(result, null, 2));
if (!passed) {
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exit(1);
}
process.stdout.write('Example pin verification passed\n');
