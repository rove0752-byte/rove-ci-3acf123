import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PUBLIC_BROWSER_PILOT_ENABLED,
  assertDedicatedContainerNetns,
  assertPrivatePidNamespace,
  assertPrivateSocketOwners,
  compileContainerEgress,
  externalAccepts,
  type NetnsInterface,
} from '../agent/lib/container-egress.ts';

const dedicated: NetnsInterface[] = [
  { name: 'lo', ifindex: 1, iflink: 1, up: true, ipv4: ['127.0.0.1'], ipv6: ['::1'] },
  { name: 'eth0', ifindex: 11, iflink: 164, up: true, ipv4: ['172.28.210.3'], ipv6: [] },
  { name: 'gre0', ifindex: 3, iflink: 0, up: false, ipv4: [], ipv6: [] },
];

test('container egress is default deny for IPv4 and IPv6', () => {
  assert.equal(PUBLIC_BROWSER_PILOT_ENABLED, false);
  const rules = compileContainerEgress();
  for (const text of [rules.ipv4, rules.ipv6]) {
    assert.match(text, /:INPUT DROP/);
    assert.match(text, /:FORWARD DROP/);
    assert.match(text, /:OUTPUT DROP/);
    assert.equal(externalAccepts(text).length, 0);
    const lines = text.split('\n');
    const dns = lines.findIndex(line => line.includes('rove-deny-dns'));
    const loopback = lines.findIndex(line => line.includes('-o lo -j ACCEPT'));
    const quic = lines.findIndex(line => line.includes('rove-deny-quic'));
    const stun = lines.findIndex(line => line.includes('rove-deny-stun'));
    const dot = lines.findIndex(line => line.includes('rove-deny-dot'));
    assert.ok(dns >= 0 && dns < loopback);
    assert.ok(quic >= 0 && quic < loopback);
    assert.ok(stun >= 0 && stun < loopback);
    assert.ok(dot >= 0 && dot < loopback);
    assert.equal(lines.filter(line => line.includes('-j ACCEPT')).length, 2);
    assert.equal(/\b(?:DNAT|SNAT|MASQUERADE|REDIRECT)\b/.test(text), false);
    assert.match(text, /\*raw[\s\S]*rove-raw-deny-dns/);
    assert.match(text, /rove-raw-deny-quic/);
    const raw = text.indexOf('*raw');
    const rawDns = text.indexOf('rove-raw-deny-dns');
    assert.ok(raw >= 0 && rawDns > raw);
  }
  assert.match(rules.ipv4, /-d 127\.0\.0\.11\/32/);
  assert.equal(rules.ipv6.includes('127.0.0.11'), false);
  assert.equal(rules.ipv4.includes('-p udp') && rules.ipv4.includes('-j ACCEPT'), true);
  assert.equal(rules.ipv4.split('\n').some(line => line.includes('-p udp') && line.includes('-j ACCEPT')), false);
});

test('container egress refuses pilot pins while the public pilot is disabled', () => {
  assert.throws(() => compileContainerEgress({ pins: [{ address: '1.1.1.1', port: 443 }] }), /Public browser pilot is disabled/);
  assert.throws(() => compileContainerEgress({ pins: [{ address: '172.28.210.10', port: 80 }] }), /Public browser pilot is disabled/);
});

test('local fixture pins allow only private TCP/80 and TCP/443', () => {
  const previous = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const rules = compileContainerEgress({ localFixture: true, pins: [{ address: '172.28.210.10', port: 80 }, { address: 'fdcc:10::10', port: 443 }] });
    const lines = rules.ipv4.split('\n');
    const quic = lines.findIndex(line => line.includes('rove-deny-quic'));
    const loopback = lines.findIndex(line => line.includes('-o lo -j ACCEPT'));
    const pin = lines.findIndex(line => line.includes('rove-fixture-pin'));
    assert.ok(quic >= 0 && quic < loopback && loopback < pin);
    const accepts = externalAccepts(rules.ipv4);
    assert.deepEqual(accepts.length, 2);
    assert.ok(accepts.every(line => line.includes('172.28.210.10') && line.includes('-p tcp') && line.includes('ESTABLISHED')));
    assert.equal(lines.some(line => line.includes('-p udp') && line.includes('-j ACCEPT')), false);
    assert.match(rules.ipv6, /fdcc:10::10/);
    assert.equal(rules.ipv4.includes('fdcc:10::10'), false);
    assert.equal(externalAccepts(rules.ipv4).some(line => line.includes('RELATED')), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('local fixture pins reject public, mapped, non-web, and production targets', () => {
  const previous = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    for (const pins of [
      [{ address: '1.1.1.1', port: 443 }],
      [{ address: '8.8.8.8', port: 53 }],
      [{ address: '172.28.210.10', port: 53 }],
      [{ address: '172.28.210.10', port: 8080 }],
      [{ address: '127.0.0.1', port: 80 }],
      [{ address: '100.64.0.1', port: 80 }],
      [{ address: '::ffff:172.28.210.10', port: 80 }],
      [{ address: '2001:4860:4860::8888', port: 443 }],
    ]) {
      assert.throws(() => compileContainerEgress({ localFixture: true, pins }), /Public browser pilot is disabled/);
    }
    process.env.NODE_ENV = 'production';
    assert.throws(() => compileContainerEgress({ localFixture: true, pins: [{ address: '10.0.0.8', port: 443 }] }), /Public browser pilot is disabled/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('dedicated network check refuses host devices, extra loopback, and foreign sockets', () => {
  const dockerDns = [{ inode: '20', local: '0B00007F:AFE1', family: 'udp' }];
  assert.doesNotThrow(() => assertDedicatedContainerNetns({ interfaces: dedicated, sockets: dockerDns, ownedInodes: [] }));
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: [dedicated[0], { name: 'eth0', ifindex: 2, iflink: 2, up: true, ipv4: [], ipv6: [] }],
    sockets: [],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: [...dedicated, { name: 'docker0', ifindex: 4, iflink: 9, up: true, ipv4: ['172.17.0.1'], ipv6: [] }],
    sockets: [],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: [dedicated[0], dedicated[1], { ...dedicated[2], up: true, ipv4: ['10.9.9.9'] }],
    sockets: [],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: [{ ...dedicated[0], ipv4: ['127.0.0.1', '127.0.0.53'] }, dedicated[1]],
    sockets: [],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [{ inode: '99', local: '00000000:0050', family: 'tcp' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [{ inode: '0', local: '0B00007F:AFE1', family: 'tcp' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [{ inode: '5', local: '00000000:0009', family: 'icmp' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [{ inode: '8', local: '0B00007F:0035', family: 'udp' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({ interfaces: [dedicated[0]], sockets: [], ownedInodes: [] }), /dedicated container/);
  const packet = { inode: '30', local: '2:0000:0', family: 'packet' };
  const icmp6 = { inode: '32', local: '00000000000000000000000001000000:003A', family: 'raw6' };
  assert.doesNotThrow(() => assertDedicatedContainerNetns({ interfaces: dedicated, sockets: [packet, icmp6], ownedInodes: [] }));
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [icmp6, { inode: '33', local: '00000000000000000000000000000000:003A', family: 'raw6' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.throws(() => assertDedicatedContainerNetns({
    interfaces: dedicated,
    sockets: [packet, { inode: '31', local: '2:0000:0', family: 'packet' }],
    ownedInodes: [],
  }), /dedicated container/);
  assert.doesNotThrow(() => assertPrivatePidNamespace([{ pid: 1, ppid: 0 }, { pid: 7, ppid: 1 }, { pid: 8, ppid: 7 }], 7));
  assert.throws(() => assertPrivatePidNamespace([{ pid: 1, ppid: 0 }, { pid: 7, ppid: 1 }, { pid: 9, ppid: 1 }], 7), /dedicated container/);
  assert.doesNotThrow(() => assertPrivateSocketOwners([{ pid: 1, ppid: 0 }, { pid: 7, ppid: 1 }, { pid: 8, ppid: 7 }], 7, [8]));
  assert.throws(() => assertPrivateSocketOwners([{ pid: 1, ppid: 0 }, { pid: 7, ppid: 1 }], 7, [1]), /dedicated container/);
});
