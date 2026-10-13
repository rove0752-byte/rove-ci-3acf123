// Stage A isolated-runner validation. Local fixtures only; browser container has no network.
// Every run uses a FRESH mkdtemp evidence dir and asserts that any VIOLATION was produced by this run (review H4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(process.env.STAGE_A_EVIDENCE_PARENT ?? tmpdir(), 'stage-a-'));
const env = { ...process.env, A3_REGISTRY: join(root, 'registry'), A3_KILL_LOG: join(root, 'kill.log'), CMD: '', PROBE: '', STAGE_A_TEST: '' };
const ok = spawnSync('docker', ['image', 'inspect', 'rove-browser-pilot:local', 'node:24-bookworm-slim']).status === 0;
const opts = { skip: !ok && 'local images not present', timeout: 120_000 };
type Run = { code: number | null; out: string; started: number; stdout: string; read: (f: string) => string; summary: any; lines: (f: string) => any[]; violation: () => any };
const run = (name: string, wall: number, urls: string[], extra: Record<string, string> = {}): Run => {
  const out = join(mkdtempSync(join(root, name + '-')), 'ev');
  const started = Date.now();
  const r = spawnSync('zsh', [join(here, 'run.sh'), out, String(wall), ...urls], { env: { ...env, ...extra }, encoding: 'utf8' });
  const read = (f: string) => existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : '';
  return {
    code: r.status, out, started, stdout: r.stdout, read,
    summary: JSON.parse(read('summary.json') || '{}'),
    lines: (f: string) => read(f).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    violation: () => {
      const p = join(out, 'VIOLATION'); assert.ok(existsSync(p), 'VIOLATION produced');
      assert.ok(statSync(p).mtimeMs >= started, 'VIOLATION written by THIS run');
      return JSON.parse(readFileSync(p, 'utf8'));
    },
  };
};
const testRun = (name: string, wall: number, urls: string[], cmd: string, probe = '') => run(name, wall, urls, { STAGE_A_TEST: '1', CMD: cmd, PROBE: probe });
const nothingLeft = (r: Run) => {
  assert.equal(r.summary.containers_left, 0);
  const nonce = r.read('supervisor.log').match(/nonce=([0-9a-f]{8})/)![1];
  const all = spawnSync('docker', ['ps', '-a', '--format', '{{.Label "rove.a3.nonce"}}'], { encoding: 'utf8' }).stdout;
  assert.ok(!all.split('\n').some(n => n.startsWith(nonce)), 'no container from this run left');
};
const raw = (host: string, target: string, extra = '') => `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;

test('positive control: allowed hosts load; logs; limits; --network none browser; evidence 0700/0600; checksums', opts, () => {
  const r = run('ok', 60, ['http://allowed.test/', 'http://allowed.test/a', 'http://other.test/']);
  assert.equal(r.code, 0, r.read('supervisor.log'));
  assert.equal(r.summary.result, 'completed');
  assert.deepEqual(JSON.parse(r.read('browse.json')).map((x: any) => x.title), ['Allowed home', 'Page A', 'Allowed home']);
  for (const l of r.lines('requests.jsonl')) for (const k of ['host', 'ip', 'status', 'bytes']) assert.ok(k in l, k);
  assert.equal(r.lines('dns.jsonl').length, 2);
  assert.match(r.read('browser.inspect'), /^1000000000 1073741824 256 true true none\n?$/);
  assert.ok(r.summary.peak_memory_bytes > 10_000_000 && r.summary.peak_memory_bytes <= 1073741824);
  assert.equal(statSync(r.out).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.out, 'requests.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.out, 'summary.json')).mode & 0o777, 0o600);
  assert.equal(spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: r.out }).status, 0);
  nothingLeft(r);
  assert.equal(spawnSync('docker', ['network', 'ls', '-q', '--filter', 'label=rove.a3=1'], { encoding: 'utf8' }).stdout.trim(), '', 'L4 networks removed');
  assert.equal(spawnSync('docker', ['volume', 'ls', '-q', '--filter', 'label=rove.a3=1'], { encoding: 'utf8' }).stdout.trim(), '', 'socket volume removed');
});

test('H4: a non-empty evidence dir is refused (stale VIOLATION can never be read)', opts, () => {
  const d = mkdtempSync(join(root, 'stale-'));
  writeFileSync(join(d, 'VIOLATION'), '{"kind":"stale-from-previous-run"}\n');
  const r = spawnSync('zsh', [join(here, 'run.sh'), d, '30', 'http://allowed.test/'], { env, encoding: 'utf8' });
  assert.equal(r.status, 6);
  assert.match(r.stdout, /not empty/);
});

test('M2: CMD/PROBE hooks are refused outside test mode', opts, () => {
  for (const extra of [{ CMD: 'id' }, { PROBE: '[]' }]) {
    const d = join(mkdtempSync(join(root, 'm2-')), 'ev');
    const r = spawnSync('zsh', [join(here, 'run.sh'), d, '30', 'http://allowed.test/'], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(r.status, 7, JSON.stringify(extra));
    assert.equal(existsSync(d), false, 'nothing started');
  }
  const t = testRun('m2ok', 30, [], 'echo hook-ran');
  assert.match(t.read('supervisor.log'), /TEST MODE: CMD hook in use/);
});

// B-class: terminate
for (const [name, urls, kind] of [
  ['unlisted-top', ['http://evil.test/'], 'off-list-host'],
  ['private', ['http://private.test/'], 'private-ip'],
  ['mixed', ['http://mixed.test/'], 'private-ip'],
  ['robots-top-repeat', ['http://allowed.test/private/1', 'http://allowed.test/private/2', 'http://allowed.test/private/3'], 'robots-top-level-repeat'],
  ['redirect-off-top', ['http://allowed.test/redir-off'], 'redirect-off-list'],
] as const) {
  test(`terminate: ${name} (${kind})`, opts, () => {
    const r = run(name, 60, [...urls]);
    assert.equal(r.code, 9, r.read('supervisor.log'));
    assert.equal(r.violation().kind, kind);
    assert.match(r.summary.result, /^auto-terminated/);
    nothingLeft(r);
  });
}

// A-class: block and log, run continues
for (const [name, urls, rule] of [
  ['offlist-subresource', ['http://allowed.test/offlist'], 'off-list-subresource'],
  ['robots-literal', ['http://allowed.test/robots-trap'], 'robots'],
  ['robots-specific-group', ['http://other.test/a'], 'robots'],
  ['redirect-off-subresource', ['http://allowed.test/sub-redir'], 'redirect-off-list'],
] as const) {
  test(`block-and-log: ${name} (${rule})`, opts, () => {
    const r = run(name, 60, [...urls]);
    assert.equal(r.code, 0, r.read('supervisor.log'));
    assert.equal(existsSync(join(r.out, 'VIOLATION')), false);
    assert.equal(r.summary.result, 'completed-with-blocks');
    assert.ok(r.summary.blocks[rule] >= 1, JSON.stringify(r.summary.blocks));
    const d = r.lines('decisions.jsonl').find(x => x.rule === rule)!;
    for (const k of ['t', 'host', 'path_raw', 'dest', 'class', 'rule', 'count']) assert.ok(k in d, k);
    assert.equal(d.class, 'A');
  });
}

const imgs = (n: number) => ({ parallel: true, reqs: Array.from({ length: n }, (_, i) => raw('allowed.test', `http://allowed.test/img/${i}.png`)) });
test('rate: over-rate requests beyond the queue get 429 and are logged (A-class), run continues', opts, () => {
  const r = testRun('rate-block', 40, [], 'node /runner/tests/probe.mjs', JSON.stringify(imgs(24)));
  assert.equal(existsSync(join(r.out, 'VIOLATION')), false);
  assert.equal(r.summary.result, 'completed-with-blocks', r.read('supervisor.log'));
  assert.ok(r.summary.blocks.rate >= 1 && r.summary.blocks.rate <= 20, JSON.stringify(r.summary.blocks));
  assert.ok(JSON.parse(r.read('probe.json')).some((l: string) => / 429 /.test(l)));
});
test('rate: sustained abuse (> aClassMax denials) terminates the run', opts, () => {
  const r = testRun('flood', 40, [], 'node /runner/tests/probe.mjs', JSON.stringify(imgs(60)));
  assert.equal(r.violation().kind, 'a-class-threshold');
  nothingLeft(r);
});

test('rate: queueing serves a moderate burst instead of terminating (L3)', opts, () => {
  const r = run('rate-detail', 60, ['http://allowed.test/burst']);
  const served = r.lines('requests.jsonl').filter(l => l.path?.startsWith('/img/') && l.status === 200).length;
  assert.ok(served >= 14, `served ${served} of 20 images via the queue`);
});

test('robots: Allow longest-match wins over a shorter Disallow', opts, () => {
  const r = run('robots-allow', 60, ['http://allowed.test/private/public-ok']);
  assert.equal(r.summary.result, 'completed');
  assert.equal(JSON.parse(r.read('browse.json'))[0].title, 'Allowed by longer Allow');
});

test('M7: same-host and allowed cross-host redirects are followed with Location forwarded and policed', opts, () => {
  const r = run('redirects', 60, ['http://allowed.test/redir-same', 'http://allowed.test/redir-cross']);
  assert.equal(r.summary.result, 'completed', r.read('supervisor.log'));
  const b = JSON.parse(r.read('browse.json'));
  assert.deepEqual(b.map((x: any) => [x.final, x.title]), [['http://allowed.test/a', 'Page A'], ['http://other.test/', 'Allowed home']]);
  assert.equal(r.lines('decisions.jsonl').filter(d => d.rule === 'redirect' && d.class === 'ok').length, 2);
});

// Raw-request bypass probes (test mode), each in its own run because each one terminates it.
for (const [name, req, kind] of [
  ['enc-p', raw('allowed.test', 'http://allowed.test/%70rivate/x'), 'encoded-path-robots-bypass'],
  ['double-enc', raw('allowed.test', 'http://allowed.test/%2570rivate/x'), 'encoded-path-double-encoding'],
  ['enc-slash', raw('allowed.test', 'http://allowed.test/a/..%2fprivate/x'), 'encoded-path-encoded-separator'],
  ['connect', 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n', 'connect-tunnel'],
  ['origin-form', raw('allowed.test', '/a'), 'origin-form'],
  ['host-mismatch', raw('evil.test', 'http://allowed.test/a'), 'host-header-mismatch'],
  ['ip-decimal', raw('755105802', 'http://755105802/'), 'ip-literal'],
  ['ip-v6', raw('[::1]', 'http://[::1]/'), 'ip-literal'],
  ['post-top', `POST http://allowed.test/a HTTP/1.1\r\nHost: allowed.test\r\nAccept: text/html\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, 'method'],
] as const) {
  test(`bypass probe terminates: ${name} (${kind})`, opts, () => {
    const r = testRun(name, 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([req]));
    assert.equal(r.violation().kind, kind, r.read('decisions.jsonl'));
    nothingLeft(r);
  });
}

test('L3: trailing-dot host is canonicalised and allowed', opts, () => {
  const r = testRun('trailing-dot', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test.', 'http://allowed.test./a')]));
  assert.match(JSON.parse(r.read('probe.json'))[0], /200/);
  assert.equal(existsSync(join(r.out, 'VIOLATION')), false);
});

test('DNS pinning: a rebinding answer on the second lookup is never used', opts, () => {
  const r = run('rebind', 60, ['http://rebind.test/', 'http://rebind.test/a']);
  assert.equal(r.code, 0);
  assert.equal(r.lines('dns.jsonl').length, 1);
  assert.ok(r.lines('requests.jsonl').every(l => l.ip === '45.0.0.10'));
});

test('M4: browser container reaches nothing but the proxy socket (gateways, fixture, internet, metadata, IPv6, DNS)', opts, () => {
  const r = testRun('isolation', 30, [], 'node /runner/tests/isolation-probe.mjs');
  const p = JSON.parse(r.read('probe.json'));
  assert.equal(p.ifaces, 'lo');
  for (const [k, v] of Object.entries(p)) if (k !== 'ifaces' && k !== 'proxy_socket') assert.equal(v, 'blocked', k);
  assert.equal(p.proxy_socket, 'REACHED');
});

test('memory and pids limits hold; peak memory captured', opts, () => {
  const r = testRun('limits', 40, [], `node -e 'const a=[];for(;;)a.push(Buffer.alloc(5e7,1))'; (for i in $(seq 400); do sleep 5 & done; wait) 2>&1 | tail -1; echo done`);
  assert.ok(r.summary.peak_memory_bytes > 900_000_000 && r.summary.peak_memory_bytes <= 1073741824, String(r.summary.peak_memory_bytes));
  assert.match(r.read('browser.log'), /Cannot fork/);
});

test('L4: a hung URL is reported completed-with-errors, not completed', opts, () => {
  const r = run('hang-errors', 40, ['http://allowed.test/hang']);
  assert.equal(r.summary.result, 'completed-with-errors', r.read('supervisor.log'));
});

test('wall clock kills a hung run and logs it', opts, () => {
  const r = run('wall', 8, ['http://allowed.test/hang']);
  assert.equal(r.code, 9);
  assert.match(r.summary.result, /wall-clock kill after 8s/);
  nothingLeft(r);
});

test('external kill (kill.sh) ends a hung run; nothing left behind; kill logged', opts, async () => {
  const out = join(mkdtempSync(join(root, 'extkill-')), 'ev');
  const child = spawn('zsh', [join(here, 'run.sh'), out, '90', 'http://allowed.test/hang'], { env, stdio: 'ignore' });
  await new Promise(res => setTimeout(res, 6000));
  const k = spawnSync('zsh', [join(here, '..', 'a3-local', 'kill.sh')], { env, encoding: 'utf8' });
  assert.equal(k.status, 0, k.stdout);
  assert.equal(await new Promise(res => child.on('exit', res)), 9);
  assert.match(readFileSync(env.A3_KILL_LOG, 'utf8'), /killed name=rove-a3-\d+-\d+3 container=/);
  assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).containers_left, 0);
});
