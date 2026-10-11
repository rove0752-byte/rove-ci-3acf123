// Default-drop policy for a dedicated container network namespace.
// The public browser pilot stays off. Local fixture pins are a test-only TCP allow.
import { isIP } from 'node:net';

export const PUBLIC_BROWSER_PILOT_ENABLED = false;

export type ContainerEgressRules = { ipv4: string; ipv6: string };
export type LocalFixturePin = { address: string; port: number };
export type NetnsInterface = {
  name: string;
  ifindex: number;
  iflink: number;
  up: boolean;
  ipv4: readonly string[];
  ipv6: readonly string[];
};
export type NetnsSocket = { inode: string; local: string; family: string };
export type PidRecord = { pid: number; ppid: number };

// These fallback devices are created in every network namespace when the tunnel modules are loaded.
const FALLBACK_TUNNELS = new Set(['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0', 'teql0']);

const PILOT_DISABLED = 'Public browser pilot is disabled.';
const DEDICATED_NETNS = 'Container egress apply is refused outside a dedicated container.';

const IPV4_REJECT_UDP = 'icmp-port-unreachable';
const IPV4_REJECT_TCP = 'tcp-reset';
const IPV4_REJECT_OTHER = 'icmp-admin-prohibited';
const IPV6_REJECT_UDP = 'icmp6-port-unreachable';
const IPV6_REJECT_TCP = 'tcp-reset';
const IPV6_REJECT_OTHER = 'icmp6-adm-prohibited';

function reject(family: 4 | 6, protocol: 'udp' | 'tcp' | 'icmp', comment: string, match = ''): string {
  const tcp = protocol === 'tcp';
  const udp = protocol === 'udp';
  const withReject = family === 4
    ? (tcp ? IPV4_REJECT_TCP : udp ? IPV4_REJECT_UDP : IPV4_REJECT_OTHER)
    : (tcp ? IPV6_REJECT_TCP : udp ? IPV6_REJECT_UDP : IPV6_REJECT_OTHER);
  const proto = protocol === 'icmp' && family === 6 ? 'ipv6-icmp' : protocol;
  return `-A OUTPUT -p ${proto}${match} -m comment --comment ${comment} -j REJECT --reject-with ${withReject}`;
}

function rawDrop(protocol: 'udp' | 'tcp', comment: string, match: string): string {
  return `-A OUTPUT -p ${protocol}${match} -m comment --comment ${comment} -j DROP`;
}

function localFixtureAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // ULA only. IPv4-mapped addresses are not fixture pins; they would leave as IPv4.
  return isIP(address) === 6 && /^(?:fc|fd)[0-9a-f]{2}:/i.test(address);
}

export function validateLocalFixturePins(pins: readonly LocalFixturePin[]): LocalFixturePin[] {
  if (PUBLIC_BROWSER_PILOT_ENABLED || process.env.NODE_ENV === 'production' || pins.length === 0) {
    throw new Error(PILOT_DISABLED);
  }
  const accepted: LocalFixturePin[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    if (!pin || (pin.port !== 80 && pin.port !== 443) || !localFixtureAddress(pin.address)) throw new Error(PILOT_DISABLED);
    const key = `${pin.address.toLowerCase()}:${pin.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ address: pin.address, port: pin.port });
  }
  return accepted;
}

// A veth peer reports a different iflink. Host devices and a shared netns do not pass this shape.
export function assertDedicatedContainerNetns(input: {
  interfaces: readonly NetnsInterface[];
  sockets: readonly NetnsSocket[];
  ownedInodes: readonly string[];
}): void {
  const loopback = input.interfaces.find(item => item.name === 'lo');
  const others = input.interfaces.filter(item => item.name !== 'lo');
  if (!loopback) throw new Error(DEDICATED_NETNS);
  const ipv4 = loopback.ipv4;
  const ipv6 = loopback.ipv6.map(address => address.split('%')[0].toLowerCase());
  if (!ipv4.includes('127.0.0.1') || ipv4.some(address => address !== '127.0.0.1')) throw new Error(DEDICATED_NETNS);
  if (ipv6.some(address => address !== '::1')) throw new Error(DEDICATED_NETNS);
  let veths = 0;
  for (const item of others) {
    if (!Number.isInteger(item.ifindex) || !Number.isInteger(item.iflink)) throw new Error(DEDICATED_NETNS);
    if (/^eth\d+$/.test(item.name) && item.iflink > 0 && item.iflink !== item.ifindex) {
      veths += 1;
      continue;
    }
    const dormantTunnel = FALLBACK_TUNNELS.has(item.name) && !item.up && item.ipv4.length === 0 && item.ipv6.length === 0;
    if (!dormantTunnel) throw new Error(DEDICATED_NETNS);
  }
  if (veths === 0) throw new Error(DEDICATED_NETNS);
  const owned = new Set(input.ownedInodes);
  for (const socket of input.sockets) {
    if (socket.inode !== '0' && owned.has(socket.inode)) continue;
    // Docker's resolver binds high ports on 127.0.0.11 from outside the pid namespace.
    if (dockerResolverSocket(socket) || dockerPacketSocket(socket, input.sockets) || kernelIcmp6Socket(socket, input.sockets)) continue;
    throw new Error(DEDICATED_NETNS);
  }
}

// A bridge namespace has one unowned AF_PACKET socket. A second one belongs to somebody else.
function dockerPacketSocket(socket: NetnsSocket, sockets: readonly NetnsSocket[]): boolean {
  if (socket.family !== 'packet' || socket.inode === '0' || socket.local !== '2:0000:0') return false;
  return sockets.filter(item => item.family === 'packet').length === 1;
}

// IPv6 neighbor discovery owns one ICMPv6 raw socket. A second raw socket is not that baseline.
function kernelIcmp6Socket(socket: NetnsSocket, sockets: readonly NetnsSocket[]): boolean {
  if (socket.family !== 'raw6' || socket.inode === '0') return false;
  if (socket.local.split(':')[1]?.toLowerCase() !== '003a') return false;
  return sockets.filter(item => item.family === 'raw6').length === 1;
}

function dockerResolverSocket(socket: NetnsSocket): boolean {
  if (socket.inode === '0') return false;
  if (socket.family !== 'tcp' && socket.family !== 'udp' && socket.family !== 'tcp6' && socket.family !== 'udp6') return false;
  const [address, portHex] = socket.local.split(':');
  if (address?.toLowerCase() !== '0b00007f' || !portHex) return false;
  const port = Number.parseInt(portHex, 16);
  return Number.isInteger(port) && port > 1023;
}

// A shared pid namespace makes another container's sockets look locally owned.
export function assertPrivatePidNamespace(pids: readonly PidRecord[], self: number): void {
  const present = new Map(pids.map(item => [item.pid, item.ppid]));
  if (!present.has(self)) throw new Error(DEDICATED_NETNS);
  const ancestors = new Set<number>();
  let current = self;
  while (present.has(current)) {
    const parent = present.get(current) ?? 0;
    if (parent <= 0 || parent === self || ancestors.has(parent)) break;
    ancestors.add(parent);
    current = parent;
  }
  const descendants = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of pids) {
      if (item.pid === self || ancestors.has(item.pid) || descendants.has(item.pid)) continue;
      if (item.ppid === self || descendants.has(item.ppid)) {
        descendants.add(item.pid);
        grew = true;
      }
    }
  }
  if (pids.some(item => item.pid !== self && !ancestors.has(item.pid) && !descendants.has(item.pid))) {
    throw new Error(DEDICATED_NETNS);
  }
}

// An ancestor that owns a socket is another container's process, not the entrypoint shell.
export function assertPrivateSocketOwners(pids: readonly PidRecord[], self: number, owners: readonly number[]): void {
  const descendants = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of pids) {
      if (item.pid === self || descendants.has(item.pid)) continue;
      if (item.ppid === self || descendants.has(item.ppid)) {
        descendants.add(item.pid);
        grew = true;
      }
    }
  }
  if (owners.some(pid => pid !== self && !descendants.has(pid))) throw new Error(DEDICATED_NETNS);
}

// DNS, QUIC, STUN and mDNS are rejected on every interface, including loopback,
// before the loopback accept. Fixture pins are TCP/80 or TCP/443 only, after that accept.
function render(family: 4 | 6, pins: readonly LocalFixturePin[]): string {
  const lines = [
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT DROP [0:0]',
    '-A INPUT -i lo -j ACCEPT',
    reject(family, 'udp', 'rove-deny-dns', ' --dport 53'),
    reject(family, 'tcp', 'rove-deny-dns', ' --dport 53'),
    reject(family, 'udp', 'rove-deny-quic', ' --dport 443'),
    reject(family, 'udp', 'rove-deny-stun', ' --dport 3478'),
    reject(family, 'udp', 'rove-deny-mdns', ' --dport 5353'),
    reject(family, 'tcp', 'rove-deny-dot', ' --dport 853'),
  ];
  if (family === 4) lines.push('-A OUTPUT -d 127.0.0.11/32 -m comment --comment rove-deny-docker-dns -j REJECT --reject-with icmp-admin-prohibited');
  lines.push('-A OUTPUT -o lo -j ACCEPT');
  for (const pin of pins) {
    if ((family === 4 && isIP(pin.address) !== 4) || (family === 6 && isIP(pin.address) !== 6)) continue;
    // ESTABLISHED only: a pin is not permission for the remote host to open a new connection.
    lines.push(`-A INPUT -p tcp -s ${pin.address} --sport ${pin.port} -m conntrack --ctstate ESTABLISHED -m comment --comment rove-fixture-return -j ACCEPT`);
    lines.push(`-A OUTPUT -p tcp -d ${pin.address} --dport ${pin.port} -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment rove-fixture-pin -j ACCEPT`);
  }
  lines.push(
    reject(family, 'tcp', 'rove-deny-tcp'),
    reject(family, 'udp', 'rove-deny-udp'),
    reject(family, 'icmp', 'rove-deny-icmp'),
    'COMMIT',
    '*nat',
    ':PREROUTING ACCEPT [0:0]',
    ':INPUT ACCEPT [0:0]',
    ':OUTPUT ACCEPT [0:0]',
    ':POSTROUTING ACCEPT [0:0]',
    'COMMIT',
    '*mangle',
    ':PREROUTING ACCEPT [0:0]',
    ':INPUT ACCEPT [0:0]',
    ':FORWARD ACCEPT [0:0]',
    ':OUTPUT ACCEPT [0:0]',
    ':POSTROUTING ACCEPT [0:0]',
    'COMMIT',
    // Raw OUTPUT runs before the dstnat priority used by Docker's docker-dns table.
    '*raw',
    ':PREROUTING ACCEPT [0:0]',
    ':OUTPUT ACCEPT [0:0]',
    rawDrop('udp', 'rove-raw-deny-dns', ' --dport 53'),
    rawDrop('tcp', 'rove-raw-deny-dns', ' --dport 53'),
    rawDrop('udp', 'rove-raw-deny-quic', ' --dport 443'),
    rawDrop('udp', 'rove-raw-deny-stun', ' --dport 3478'),
    rawDrop('udp', 'rove-raw-deny-mdns', ' --dport 5353'),
    rawDrop('tcp', 'rove-raw-deny-dot', ' --dport 853'),
  );
  if (family === 4) lines.push('-A OUTPUT -d 127.0.0.11/32 -m comment --comment rove-raw-deny-docker-dns -j DROP');
  lines.push('COMMIT', '');
  return lines.join('\n');
}

export function compileContainerEgress(options: { pins?: readonly LocalFixturePin[]; localFixture?: boolean } = {}): ContainerEgressRules {
  if (PUBLIC_BROWSER_PILOT_ENABLED) throw new Error(PILOT_DISABLED);
  const requested = options.pins ?? [];
  if (requested.length > 0 && options.localFixture !== true) throw new Error(PILOT_DISABLED);
  const pins = options.localFixture === true ? validateLocalFixturePins(requested) : [];
  return {
    ipv4: render(4, pins.filter(pin => isIP(pin.address) === 4)),
    ipv6: render(6, pins.filter(pin => isIP(pin.address) === 6)),
  };
}

export function externalAccepts(rules: string): string[] {
  return rules.split('\n').filter(line => line.includes('-j ACCEPT') && !line.includes('-i lo') && !line.includes('-o lo'));
}
