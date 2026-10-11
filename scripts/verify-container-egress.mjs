// Local disposable containers on an internal network. No public website, published port, deploy, or paid call.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const image = 'rove-browser-pilot:local';
const id = `rove-egress-${process.pid}`;
const evidence = mkdtempSync(join(tmpdir(), `${id}-`));
const context = mkdtempSync(join(tmpdir(), `${id}-context-`));
const names = [`${id}-a`, `${id}-b`, `${id}-probe`, `${id}-ping`];

function docker(args, input) {
  return spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
}

function must(args, input) {
  const result = docker(args, input);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || '').trim();
}

function readJson(name) {
  return JSON.parse(readFileSync(join(evidence, name), 'utf8'));
}

function growth(before, after) {
  const delta = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'ready') continue;
    delta[key] = (after[key] ?? 0) - (before[key] ?? 0);
  }
  return delta;
}

async function waitReady(file, container) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if (readJson(file).ready === 1) return;
    } catch { /* canary still binding */ }
    await delay(250);
  }
  const logs = docker(['logs', container]);
  throw new Error(`${container} did not become ready\n${logs.stdout}\n${logs.stderr}`);
}

function runProbe(mode, canary, other, canary6, extra = []) {
  const args = [
    'run', '--rm', '--name', `${id}-probe`, '--network', id,
    '--cap-add', 'NET_ADMIN', '--dns', canary,
    '--sysctl', 'net.ipv4.ping_group_range=0 2147483647',
    '-e', 'ROVE_EGRESS_APPLY=dedicated-container',
    '-e', `ROVE_EGRESS_MODE=${mode}`,
    '-e', `CANARY_IP=${canary}`,
    '-e', `CANARY2_IP=${other}`,
    '-e', `ROVE_DNS_NAME=${names[0]}`,
    '-e', 'HOME=/tmp',
    '-v', `${join(root, 'agent')}:/app/agent:ro`,
    '-v', `${join(root, 'scripts/container-egress-entry.ts')}:/app/scripts/container-egress-entry.ts:ro`,
    '-v', `${join(root, 'scripts/container-egress-probe.ts')}:/app/scripts/container-egress-probe.ts:ro`,
    '-v', `${join(root, 'scripts/container-egress-launch.sh')}:/app/scripts/container-egress-launch.sh:ro`,
    '-v', `${evidence}:/evidence`,
  ];
  for (const item of extra) args.push('-e', item);
  if (canary6) args.splice(8, 0, '-e', `CANARY_IP6=${canary6}`);
  args.push('--entrypoint', 'sh', image, '/app/scripts/container-egress-launch.sh');
  const result = docker(args);
  assert.equal(result.status, 0, `${mode} probe failed\n${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /CONTAINER_EGRESS_RESULT/);
  return readJson(`result-${mode}.json`);
}

function assertNetns(network, accepted, extra = []) {
  const result = docker([
    'run', '--rm', ...extra, '--network', network,
    '-e', 'ROVE_EGRESS_APPLY=dedicated-container',
    '-v', `${join(root, 'agent')}:/app/agent:ro`,
    '-v', `${join(root, 'scripts/container-egress-entry.ts')}:/app/scripts/container-egress-entry.ts:ro`,
    '--entrypoint', 'node', image,
    '--experimental-strip-types', '/app/scripts/container-egress-entry.ts', '--assert-netns',
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (accepted) {
    assert.equal(result.status, 0, output);
    assert.match(result.stdout, /Dedicated container network namespace confirmed/);
  } else {
    assert.notEqual(result.status, 0, output);
    assert.match(output, /dedicated container/);
  }
}

const requiredHits = ['tcp9', 'tcp53', 'tcp80', 'tcp853', 'tcp8080', 'udp53', 'udp443', 'udp3478', 'udp5353'];
let passed = false;

try {
  const build = spawnSync('docker', ['build', '-f', join(root, 'Dockerfile.browser-pilot'), '-t', image, context], {
    encoding: 'utf8', stdio: 'inherit',
  });
  assert.equal(build.status, 0, 'browser pilot image build failed');

  let ipv6 = false;
  const v6 = docker(['network', 'create', '--internal', '--ipv6', '--subnet', '172.28.210.0/24', '--subnet', 'fdcc:10::/64', id]);
  if (v6.status === 0) ipv6 = true;
  else must(['network', 'create', '--internal', '--subnet', '172.28.210.0/24', id]);

  const mounts = [
    '-v', `${join(root, 'scripts/container-egress-probe.ts')}:/app/scripts/container-egress-probe.ts:ro`,
    '-v', `${evidence}:/evidence`,
  ];
  must(['run', '-d', '--name', names[0], '--network', id, '--cap-add', 'NET_BIND_SERVICE',
    '-e', 'CANARY_NAME=canary-a', '-e', `CANARY_IPV6=${ipv6 ? '1' : '0'}`, ...mounts,
    '--entrypoint', 'node', image, '--experimental-strip-types', '/app/scripts/container-egress-probe.ts', '--canary']);
  must(['run', '-d', '--name', names[1], '--network', id,
    '-e', 'CANARY_NAME=canary-b', ...mounts,
    '--entrypoint', 'node', image, '--experimental-strip-types', '/app/scripts/container-egress-probe.ts', '--canary']);
  await waitReady('canary-a.json', names[0]);
  await waitReady('canary-b.json', names[1]);

  const canary = must(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', names[0]]);
  const other = must(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', names[1]]);
  const canary6 = ipv6 ? must(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}', names[0]]) : '';
  assert.match(canary, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(other, /^\d+\.\d+\.\d+\.\d+$/);
  assert.notEqual(canary, other);
  must(['run', '-d', '--name', `${id}-ping`, '--network', id, '--entrypoint', 'ping', image, '-i', '5', '127.0.0.1']);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const icmp = docker(['exec', `${id}-ping`, 'sh', '-c', 'awk "NR>1 && NF" /proc/net/icmp']);
    if ((icmp.stdout || '').trim()) break;
    if (attempt === 19) throw new Error('ping did not open an ICMP socket');
    await delay(200);
  }
  assertNetns(id, true);
  assertNetns(`container:${names[0]}`, false);
  assertNetns(`container:${names[0]}`, false, ['--pid', `container:${names[0]}`]);
  assertNetns(`container:${id}-ping`, false);

  const beforeControlA = readJson('canary-a.json');
  const beforeControlB = readJson('canary-b.json');
  const control = runProbe('control', canary, other, canary6);
  await delay(300);
  const controlGrowthA = growth(beforeControlA, readJson('canary-a.json'));
  const controlGrowthB = growth(beforeControlB, readJson('canary-b.json'));

  const beforeEnforceA = readJson('canary-a.json');
  const beforeEnforceB = readJson('canary-b.json');
  const enforce = runProbe('enforce', canary, other, canary6);
  await delay(300);
  const enforceGrowthA = growth(beforeEnforceA, readJson('canary-a.json'));
  const enforceGrowthB = growth(beforeEnforceB, readJson('canary-b.json'));

  for (const result of [control, enforce]) {
    assert.equal(result.uid, 1000);
    assert.equal(result.agent.uid, 1000);
    assert.notEqual(result.agent.pid, result.pid);
    assert.equal(result.capsDropped, true);
    assert.equal(result.iptablesBlocked, true);
    assert.equal(result.sysctlBlocked, true);
    assert.equal(result.loopback, 'hit');
    assert.equal(result.policy.publicBrowserPilot, false);
    assert.equal(result.policy.pilot, 'off');
    assert.equal(result.policy.localFixture, false);
    assert.ok(result.chromium.pids.length > 0);
  }

  for (const key of requiredHits) assert.ok(controlGrowthA[key] > 0, `control ${key} produced no packet`);
  assert.ok(controlGrowthB.other80 > 0, 'control other host produced no packet');
  assert.ok(controlGrowthB.proxy8888 > 0, 'control proxy produced no packet');
  assert.equal(control.agent.icmp, 'hit');
  assert.equal(control.agent.tcp9, 'hit');
  assert.equal(control.agent.udp53, 'hit');
  assert.equal(control.agent.tcp853, 'hit');
  assert.equal(control.agent.mapped80, 'hit');
  assert.equal(control.agent.dockerDns, 'hit');
  assert.equal(control.agent.resolver, 'hit');
  assert.equal(control.chromium.direct, 'hit');
  assert.equal(control.chromium.quic, 'hit');
  assert.equal(control.chromium.webrtc, 'hit');
  assert.equal(control.chromium.proxy, 'hit');
  assert.equal(control.policy.enforced, false);

  for (const [label, delta] of [['a', enforceGrowthA], ['b', enforceGrowthB]]) {
    for (const [key, value] of Object.entries(delta)) assert.equal(value, 0, `enforce ${label} ${key} saw ${value} packets`);
  }
  for (const [group, key] of [['agent', 'tcp9'], ['agent', 'tcp53'], ['agent', 'udp53'], ['agent', 'udp5353'], ['agent', 'tcp853'], ['agent', 'tcp80'], ['agent', 'other80'], ['agent', 'mapped80'], ['agent', 'icmp'], ['agent', 'dockerDns'], ['agent', 'resolver'], ['chromium', 'direct'], ['chromium', 'quic'], ['chromium', 'webrtc'], ['chromium', 'proxy']]) {
    assert.equal(enforce[group][key], 'fail', `enforce ${group}.${key}`);
  }
  assert.equal(enforce.policy.enforced, true);
  assert.match(enforce.policy.ipv4, /\*filter[\s\S]*:OUTPUT DROP/);
  assert.match(enforce.policy.ipv4, /rove-deny-dns/);
  assert.match(enforce.policy.ipv6, /\*filter[\s\S]*:OUTPUT DROP/);
  assert.match(enforce.policy.ipv6, /rove-deny-quic/);
  assert.match(enforce.policy.ipv4, /rove-raw-deny-dns/);
  assert.match(enforce.policy.ipv4, /rove-raw-deny-quic/);
  assert.equal(enforce.policy.nftDockerDns, false);
  assert.equal(/\b(?:DNAT|SNAT|MASQUERADE|REDIRECT)\b/.test(enforce.policy.ipv4 + enforce.policy.ipv6), false);
  const externalAccepts = enforce.policy.ipv4.split('\n').filter(line => line.includes('-j ACCEPT') && !line.includes(' lo'));
  assert.deepEqual(externalAccepts, []);
  if (canary6) {
    assert.ok(controlGrowthA.tcp80v6 > 0, 'control IPv6 produced no packet');
    assert.ok(controlGrowthA.udp53v6 > 0, 'control IPv6 DNS produced no packet');
    assert.equal(control.agent.tcp80v6, 'hit');
    assert.equal(enforce.agent.tcp80v6, 'fail');
    assert.equal(enforce.agent.udp53v6, 'fail');
  }

  const beforePinA = readJson('canary-a.json');
  const beforePinB = readJson('canary-b.json');
  const pinned = runProbe('enforce', canary, other, canary6, [
    'ROVE_EGRESS_LOCAL_FIXTURE=1',
    `ROVE_EGRESS_FIXTURE_PINS=${JSON.stringify([{ address: canary, port: 80 }])}`,
  ]);
  await delay(300);
  const pinGrowthA = growth(beforePinA, readJson('canary-a.json'));
  const pinGrowthB = growth(beforePinB, readJson('canary-b.json'));
  assert.equal(pinned.policy.localFixture, true);
  assert.equal(pinned.policy.publicBrowserPilot, false);
  assert.equal(pinned.policy.pilot, 'off');
  assert.equal(pinned.agent.tcp80, 'hit');
  assert.ok(pinGrowthA.tcp80 > 0, 'local fixture pin produced no packet');
  for (const [key, value] of Object.entries(pinGrowthA)) {
    if (key === 'tcp80') continue;
    assert.equal(value, 0, `local fixture pin opened ${key}`);
  }
  for (const [key, value] of Object.entries(pinGrowthB)) assert.equal(value, 0, `local fixture pin opened ${key}`);
  for (const key of ['tcp9', 'tcp53', 'udp53', 'udp5353', 'tcp853', 'other80', 'icmp', 'dockerDns', 'resolver']) {
    assert.equal(pinned.agent[key], 'fail', `local fixture ${key}`);
  }
  for (const key of ['direct', 'quic', 'webrtc', 'proxy']) assert.equal(pinned.chromium[key], 'fail', `local fixture chromium ${key}`);
  if (canary6) {
    assert.equal(pinned.agent.tcp80v6, 'fail');
    assert.equal(pinned.agent.udp53v6, 'fail');
  }
  const pinAccepts = pinned.policy.ipv4.split('\n').filter(line => line.includes('-j ACCEPT') && !line.includes(' lo'));
  assert.ok(pinAccepts.length > 0 && pinAccepts.every(line => line.includes(canary) && line.includes('-p tcp') && line.includes('rove-fixture-')));
  assert.equal(pinned.policy.ipv4.split('\n').some(line => line.includes('-p udp') && line.includes('-j ACCEPT')), false);
  assert.match(pinned.policy.ipv4, /rove-raw-deny-quic/);
  console.log(`Container egress verification passed${canary6 ? ' (IPv4 and IPv6)' : ' (IPv4; IPv6 filter installed)'}`);
  passed = true;
} finally {
  for (const name of names) docker(['rm', '-f', name]);
  docker(['network', 'rm', id]);
  if (passed) {
    rmSync(evidence, { recursive: true, force: true });
    rmSync(context, { recursive: true, force: true });
  } else console.error(`Evidence kept at ${evidence}`);
}
