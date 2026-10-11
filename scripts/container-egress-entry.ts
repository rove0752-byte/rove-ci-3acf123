import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import {
  PUBLIC_BROWSER_PILOT_ENABLED,
  assertDedicatedContainerNetns,
  assertPrivatePidNamespace,
  assertPrivateSocketOwners,
  compileContainerEgress,
  type LocalFixturePin,
  type NetnsInterface,
  type NetnsSocket,
  type PidRecord,
} from '../agent/lib/container-egress.ts';

// Applies the deny-all policy inside a dedicated container, then returns.
// The launcher replaces this root process with an unprivileged agent before any browser starts.
const prepareOnly = process.argv.includes('--prepare-only');
const assertOnly = process.argv.includes('--assert-netns');

function refuse(message: string): never {
  throw new Error(message);
}

if (process.env.ROVE_EGRESS_APPLY !== 'dedicated-container') {
  refuse('Container egress apply is refused outside a dedicated container.');
}
if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) {
  refuse('Container egress apply is refused outside a dedicated container.');
}
if (PUBLIC_BROWSER_PILOT_ENABLED) refuse('Public browser pilot is disabled.');

function run(command: string, args: string[] = [], input?: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', input });
  if (result.error) refuse(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) refuse(`${command} failed: ${result.stderr || result.stdout || result.status}`);
  return result.stdout;
}

function fixturePins(): LocalFixturePin[] {
  const requested = process.env.ROVE_EGRESS_LOCAL_FIXTURE === '1';
  const raw = process.env.ROVE_EGRESS_FIXTURE_PINS;
  if (!requested) {
    if (raw) refuse('Public browser pilot is disabled.');
    return [];
  }
  if (process.env.NODE_ENV === 'production') refuse('Public browser pilot is disabled.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    refuse('Public browser pilot is disabled.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) refuse('Public browser pilot is disabled.');
  return parsed.map(item => {
    if (!item || typeof item !== 'object') refuse('Public browser pilot is disabled.');
    const record = item as { address?: unknown; port?: unknown };
    if (typeof record.address !== 'string' || typeof record.port !== 'number') refuse('Public browser pilot is disabled.');
    return { address: record.address, port: record.port };
  });
}

function readNetns(): { interfaces: NetnsInterface[]; sockets: NetnsSocket[]; ownedInodes: string[]; socketOwnerPids: number[] } {
  const listed = JSON.parse(run('ip', ['-json', 'addr'])) as {
    ifname?: string;
    flags?: string[];
    addr_info?: { family?: string; local?: string }[];
  }[];
  const interfaces = readdirSync('/sys/class/net').filter(name => statSync(`/sys/class/net/${name}`).isDirectory()).map(name => {
    const base = `/sys/class/net/${name}`;
    const info = listed.find(item => item.ifname === name);
    const addresses = info?.addr_info ?? [];
    return {
      name,
      ifindex: Number(readFileSync(`${base}/ifindex`, 'utf8')),
      iflink: Number(readFileSync(`${base}/iflink`, 'utf8')),
      up: info?.flags?.includes('UP') === true,
      ipv4: addresses.filter(item => item.family === 'inet' && item.local).map(item => item.local ?? ''),
      ipv6: addresses.filter(item => item.family === 'inet6' && item.local).map(item => item.local ?? ''),
    };
  });
  const sockets: NetnsSocket[] = [];
  const add = (family: string, localIndex: number, inodeIndex: number) => {
    let text: string;
    try {
      text = readFileSync(`/proc/net/${family}`, 'utf8');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'ENOENT') return;
      refuse('Container egress apply is refused outside a dedicated container.');
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length > Math.max(localIndex, inodeIndex) && fields[localIndex] && fields[inodeIndex]) {
        sockets.push({ family, inode: fields[inodeIndex], local: fields[localIndex] });
      }
    }
  };
  for (const family of ['tcp', 'tcp6', 'udp', 'udp6', 'icmp', 'icmp6', 'raw', 'raw6']) add(family, 1, 9);
  add('unix', 6, 6);
  let packet: string;
  try {
    packet = readFileSync('/proc/net/packet', 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code !== 'ENOENT') refuse('Container egress apply is refused outside a dedicated container.');
    packet = '';
  }
  for (const line of packet.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const inode = fields.at(-1);
    if (fields.length >= 9 && inode) sockets.push({ family: 'packet', inode, local: `${fields[2]}:${fields[3]}:${fields[4]}` });
  }
  const ownedInodes: string[] = [];
  const socketOwnerPids: number[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (!match) continue;
        ownedInodes.push(match[1]);
        socketOwnerPids.push(Number(pid));
      } catch { /* closed while reading */ }
    }
  }
  return { interfaces, sockets, ownedInodes, socketOwnerPids };
}

const observed = readNetns();
assertDedicatedContainerNetns(observed);

function processRecords(): PidRecord[] {
  const records: PidRecord[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
      if (!Number.isInteger(ppid)) refuse('Container egress apply is refused outside a dedicated container.');
      records.push({ pid: Number(name), ppid });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'ENOENT') continue;
      refuse('Container egress apply is refused outside a dedicated container.');
    }
  }
  return records;
}

const processes = processRecords();
assertPrivatePidNamespace(processes, process.pid);
assertPrivateSocketOwners(processes, process.pid, observed.socketOwnerPids);
if (assertOnly) {
  process.stdout.write('Dedicated container network namespace confirmed.\n');
  process.exit(0);
}

function lockSysctl(path: string, value: string): boolean {
  try {
    writeFileSync(path, value);
    return true;
  } catch {
    return false;
  }
}

// An empty range disables unprivileged ICMP. A failed write must not widen the range instead.
const sysctls = {
  pingGroup: lockSysctl('/proc/sys/net/ipv4/ping_group_range', '1 0'),
  forward: lockSysctl('/proc/sys/net/ipv4/ip_forward', '0'),
  routeLocalnet: lockSysctl('/proc/sys/net/ipv4/conf/all/route_localnet', '0'),
  sourceRoute: lockSysctl('/proc/sys/net/ipv4/conf/all/accept_source_route', '0'),
  ipv6Forward: lockSysctl('/proc/sys/net/ipv6/conf/all/forwarding', '0'),
};

const pins = fixturePins();
const localFixture = pins.length > 0;
const compiled = localFixture ? compileContainerEgress({ localFixture: true, pins }) : compileContainerEgress();
let nftDockerDns: boolean | null = null;
if (!prepareOnly) {
  run('iptables-restore', [], compiled.ipv4);
  run('ip6tables-restore', [], compiled.ipv6);
  const tables = run('nft', ['list', 'tables']);
  for (const line of tables.split('\n')) {
    const match = /^table\s+(\S+)\s+(\S*docker-dns\S*)$/.exec(line.trim());
    if (!match) continue;
    run('nft', ['delete', 'table', match[1], match[2]]);
  }
  if (run('nft', ['list', 'tables']).includes('docker-dns')) refuse('docker-dns table survived');
  nftDockerDns = false;
}

const saved = {
  enforced: !prepareOnly,
  pilot: 'off' as const,
  publicBrowserPilot: false,
  localFixture,
  nftDockerDns,
  sysctls,
  ipv4: prepareOnly ? '' : run('iptables-save', []),
  ipv6: prepareOnly ? '' : run('ip6tables-save', []),
};
mkdirSync('/run/rove', { recursive: true, mode: 0o755 });
writeFileSync('/run/rove/egress-policy.json', JSON.stringify(saved));
chmodSync('/run/rove/egress-policy.json', 0o444);
