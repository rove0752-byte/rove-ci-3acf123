// Stage A isolated-runner validation. Local fixtures only; browser container has no network.
// Every run uses a FRESH mkdtemp evidence dir and asserts that any VIOLATION was produced by this run (review H4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(process.env.STAGE_A_EVIDENCE_PARENT ?? tmpdir(), 'stage-a-'));
// R5-2: production mode reads ONLY the fixed default allowlist (empty: nothing is approved), so it cannot be exercised
// end-to-end by the suite. Runs therefore default to test mode (results carry -TEST); production is exercised for its
// refusal paths (PROD = { STAGE_A_TEST: '' }) and the approval logic is unit-tested via check-approval.py.
const headId = spawnSync('git', ['-C', dirname(dirname(here)), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const PROD = { STAGE_A_TEST: '' };
const env = { ...process.env, A3_REGISTRY: join(root, 'registry'), A3_KILL_LOG: join(root, 'kill.log'), CMD: '', PROBE: '', STAGE_A_TEST: '1' };
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
      const p = join(out, 'proxy', 'VIOLATION'); assert.ok(existsSync(p), 'VIOLATION produced');
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
// Labels carry the full 32-hex nonce; supervisor.log prints the first 8 — match by prefix (R3-6 scoping).
const ofRun = (kind: 'ps' | 'volume' | 'network', prefix: string) => spawnSync('docker', [...(kind === 'ps' ? ['ps', '-a'] : [kind, 'ls']), '--filter', 'label=rove.a3=1', '--format', '{{.Label "rove.a3.nonce"}}'], { encoding: 'utf8' }).stdout.split('\n').filter(n => n && n.startsWith(prefix));
const raw = (host: string, target: string, extra = '') => `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;

test('positive control: allowed hosts load; logs; limits; --network none browser; evidence 0700/0600; checksums', opts, () => {
  const r = run('ok', 60, ['http://allowed.test/', 'http://allowed.test/a', 'http://other.test/']);
  assert.equal(r.code, 0, r.read('supervisor.log'));
  assert.equal(r.summary.result, 'completed-TEST');
  assert.deepEqual(JSON.parse(r.read('browser/browse.json')).map((x: any) => x.title), ['Allowed home', 'Page A', 'Allowed home']);
  for (const l of r.lines('proxy/requests.jsonl')) for (const k of ['host', 'ip', 'status', 'bytes']) assert.ok(k in l, k);
  assert.equal(r.lines('proxy/dns.jsonl').length, 2);
  assert.match(r.read('browser.inspect'), /^1000000000 1073741824 256 true true none\n?$/);
  assert.ok(r.summary.peak_memory_bytes > 10_000_000 && r.summary.peak_memory_bytes <= 1073741824);
  assert.equal(statSync(r.out).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.out, 'proxy/requests.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.out, 'summary.json')).mode & 0o777, 0o600);
  assert.equal(spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: r.out }).status, 0);
  nothingLeft(r);
  const nonce = r.read('supervisor.log').match(/nonce=([0-9a-f]{8})/)![1];   // R3-6: scoped to THIS run
  assert.deepEqual(ofRun('network', nonce), [], 'no networks from this run');
  assert.deepEqual(ofRun('volume', nonce), [], 'socket + scratch volumes removed');
  assert.equal(r.summary.evidence_integrity, true); assert.equal(r.summary.integrity_checked_after_seal, true);
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
    const r = spawnSync('zsh', [join(here, 'run.sh'), d, '30', 'http://allowed.test/'], { env: { ...env, ...PROD, ...extra }, encoding: 'utf8' });
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
    assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
    assert.equal(r.summary.result, 'completed-with-blocks-TEST');
    assert.ok(r.summary.blocks[rule] >= 1, JSON.stringify(r.summary.blocks));
    const d = r.lines('proxy/decisions.jsonl').find(x => x.rule === rule)!;
    for (const k of ['t', 'host', 'path_raw', 'dest', 'class', 'rule', 'count']) assert.ok(k in d, k);
    assert.equal(d.class, 'A');
  });
}

const imgs = (n: number) => ({ parallel: true, reqs: Array.from({ length: n }, (_, i) => raw('allowed.test', `http://allowed.test/img/${i}.png`)) });
test('rate: over-rate requests beyond the queue get 429 and are logged (A-class), run continues', opts, () => {
  const r = testRun('rate-block', 40, [], 'node /runner/tests/probe.mjs', JSON.stringify(imgs(24)));
  assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
  assert.equal(r.summary.result, 'completed-with-blocks-TEST', r.read('supervisor.log'));
  assert.ok(r.summary.blocks.rate >= 1 && r.summary.blocks.rate <= 20, JSON.stringify(r.summary.blocks));
  assert.ok(JSON.parse(r.read('browser/probe.json')).some((l: string) => / 429 /.test(l)));
});
test('rate: sustained abuse (> aClassMax denials) terminates the run', opts, () => {
  const r = testRun('flood', 40, [], 'node /runner/tests/probe.mjs', JSON.stringify(imgs(60)));
  assert.equal(r.violation().kind, 'a-class-threshold');
  nothingLeft(r);
});

test('rate: queueing serves a moderate burst instead of terminating (L3)', opts, () => {
  const r = run('rate-detail', 60, ['http://allowed.test/burst']);
  const served = r.lines('proxy/requests.jsonl').filter(l => l.path?.startsWith('/img/') && l.status === 200).length;
  assert.ok(served >= 14, `served ${served} of 20 images via the queue`);
});

test('robots: Allow longest-match wins over a shorter Disallow', opts, () => {
  const r = run('robots-allow', 60, ['http://allowed.test/private/public-ok']);
  assert.equal(r.summary.result, 'completed-TEST');
  assert.equal(JSON.parse(r.read('browser/browse.json'))[0].title, 'Allowed by longer Allow');
});

test('M7: same-host and allowed cross-host redirects are followed with Location forwarded and policed', opts, () => {
  const r = run('redirects', 60, ['http://allowed.test/redir-same', 'http://allowed.test/redir-cross']);
  assert.equal(r.summary.result, 'completed-TEST', r.read('supervisor.log'));
  const b = JSON.parse(r.read('browser/browse.json'));
  assert.deepEqual(b.map((x: any) => [x.final, x.title]), [['http://allowed.test/a', 'Page A'], ['http://other.test/', 'Allowed home']]);
  assert.equal(r.lines('proxy/decisions.jsonl').filter(d => d.rule === 'redirect' && d.class === 'ok').length, 2);
});

// Raw-request bypass probes (test mode), each in its own run because each one terminates it.
for (const [name, req, kind] of [
  ['enc-p', raw('allowed.test', 'http://allowed.test/%70rivate/x'), 'encoded-path-robots-bypass'],
  ['double-enc', raw('allowed.test', 'http://allowed.test/%2570rivate/x'), 'encoded-path-double-encoding'],
  ['enc-slash', raw('allowed.test', 'http://allowed.test/a/..%2fprivate/x'), 'encoded-path-dot-segment'], // N6: %2F + dot segment
  ['connect', 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n', 'connect-tunnel'],
  ['origin-form', raw('allowed.test', '/a'), 'origin-form'],
  ['host-mismatch', raw('evil.test', 'http://allowed.test/a'), 'host-header-mismatch'],
  ['ip-decimal', raw('755105802', 'http://755105802/'), 'ip-literal'],
  ['ip-v6', raw('[::1]', 'http://[::1]/'), 'ip-literal'],
  ['post-top', `POST http://allowed.test/a HTTP/1.1\r\nHost: allowed.test\r\nAccept: text/html\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, 'method'],
] as const) {
  test(`bypass probe terminates: ${name} (${kind})`, opts, () => {
    const r = testRun(name, 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([req]));
    assert.equal(r.violation().kind, kind, r.read('proxy/decisions.jsonl'));
    nothingLeft(r);
  });
}

test('L3: trailing-dot host is canonicalised and allowed', opts, () => {
  const r = testRun('trailing-dot', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test.', 'http://allowed.test./a')]));
  assert.match(JSON.parse(r.read('browser/probe.json'))[0], /200/);
  assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
});

test('DNS pinning: a rebinding answer on the second lookup is never used', opts, () => {
  const r = run('rebind', 60, ['http://rebind.test/', 'http://rebind.test/a']);
  assert.equal(r.code, 0);
  assert.equal(r.lines('proxy/dns.jsonl').length, 1);
  assert.ok(r.lines('proxy/requests.jsonl').every(l => l.ip === '45.0.0.10'));
});

test('M4: browser container reaches nothing but the proxy socket (gateways, fixture, internet, metadata, IPv6, DNS)', opts, () => {
  const r = testRun('isolation', 30, [], 'node /runner/tests/isolation-probe.mjs');
  const p = JSON.parse(r.read('browser/probe.json'));
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
  assert.equal(r.summary.result, 'completed-with-errors-TEST', r.read('supervisor.log'));
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

// ---- t26 verification findings ----
test('N1: the browser cannot write evidence; only its scratch dir is writable (0600); integrity verified', opts, () => {
  const cmd = `for f in /evidence/proxy/requests.jsonl /evidence/proxy/VIOLATION /evidence/summary.json /evidence/forged; do (echo forged >> $f) 2>/dev/null && echo "$f WRITABLE" || echo "$f denied"; done > /scratch/tamper.txt; rm -f /evidence/proxy/journal.chain 2>/dev/null; echo ok > /scratch/own.txt`;
  const r = testRun('tamper', 30, [], cmd);
  const t = r.read('browser/tamper.txt');
  assert.doesNotMatch(t, /WRITABLE/, t);
  assert.equal((t.match(/denied/g) ?? []).length, 4);
  assert.ok(existsSync(join(r.out, 'proxy', 'journal.chain')), 'journal not deletable from the browser');
  assert.equal(existsSync(join(r.out, 'forged')), false);
  assert.equal(statSync(join(r.out, 'browser', 'own.txt')).mode & 0o777, 0o600);
  assert.equal(r.summary.evidence_integrity, true, r.summary.integrity_detail);
  assert.equal(spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: r.out }).status, 0);
});

test('N1: proxy evidence carries a verifiable hash chain (positive control run)', opts, () => {
  const r = run('chain', 30, ['http://allowed.test/a']);
  assert.equal(r.summary.evidence_integrity, true);
  const lines = r.read('proxy/journal.chain').trim().split('\n');
  assert.ok(lines.length >= 3 && lines.every(l => /^\S+\t(append|replace)\t[0-9a-f]{64}\t[0-9a-f]{64}$/.test(l)));
});

test('N5: non-default port terminates', opts, () => {
  const r = testRun('port', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test:81', 'http://allowed.test:81/a')]));
  assert.equal(r.violation().kind, 'port');
});
test('N5: percent-encoded hostname terminates', opts, () => {
  const r = testRun('enc-host', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'http://allowed%2etest/a')]));
  assert.equal(r.violation().kind, 'encoded-host');
});
test('N5: malformed requests are counted (A-class) and reflected in the status', opts, () => {
  const r = testRun('malformed', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([`GET http://allo\twed.test/ HTTP/1.1\r\nHost: allo\twed.test\r\n\r\n`, `\x00\x01garbage\r\n\r\n`]));
  assert.ok(r.summary.blocks['malformed-request'] >= 1, JSON.stringify(r.summary.blocks));
  assert.equal(r.summary.result, 'completed-with-blocks-TEST');
});

test('N6: a plain %2F is block-and-log (A-class), not termination', opts, () => {
  const r = run('enc-slash-block', 30, ['http://allowed.test/files/a%2Fb']);
  assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
  assert.equal(r.summary.result, 'completed-with-blocks-TEST');
  assert.equal(r.summary.blocks['encoded-slash'], 1);
});
test('N6: %2F combined with dot segments terminates', opts, () => {
  const r = testRun('enc-slash-dot', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'http://allowed.test/a%2F..%2Fprivate/x')]));
  assert.match(r.violation().kind, /^encoded-path-(dot-segment|encoded-separator)$/);
});

test('N7: policy hash recorded; mismatch refused outside test mode; test mode marked; test mode refuses real hosts', opts, () => {
  const pinned = readFileSync(join(here, 'policy.sha256'), 'utf8').trim();
  const real = spawnSync('shasum', ['-a', '256', join(here, 'policy.json')], { encoding: 'utf8' }).stdout.split(' ')[0];
  assert.equal(real, pinned, 'committed policy matches its pin');
  const ok = run('pol-ok', 30, ['http://allowed.test/a']);
  assert.equal(ok.summary.policy_sha256, pinned); assert.equal(ok.summary.policy_pinned_ok, true); assert.equal(ok.summary.test_mode, true);
  const pol = JSON.parse(readFileSync(join(here, 'policy.json'), 'utf8'));
  const loose = join(root, 'loose.json'); writeFileSync(loose, JSON.stringify({ ...pol, allow: [...pol.allow, 'evil.test'] }));
  const d = join(mkdtempSync(join(root, 'pol-')), 'ev');
  const r1 = spawnSync('zsh', [join(here, 'run.sh'), d, '30', 'http://allowed.test/a'], { env: { ...env, ...PROD, STAGE_A_POLICY: loose }, encoding: 'utf8' });
  assert.equal(r1.status, 8); assert.match(r1.stdout, /does not match pinned/); assert.equal(existsSync(d), false);
  const t = run('pol-test', 30, ['http://allowed.test/a'], { STAGE_A_TEST: '1', STAGE_A_POLICY: loose });
  assert.equal(t.summary.test_mode, true); assert.equal(t.summary.policy_pinned_ok, false); assert.match(t.summary.result, /-TEST$/);
  const realHost = join(root, 'realhost.json'); writeFileSync(realHost, JSON.stringify({ ...pol, allow: [...pol.allow, 'example.com'] }));
  const r2 = spawnSync('zsh', [join(here, 'run.sh'), join(mkdtempSync(join(root, 'pol2-')), 'ev'), '30'], { env: { ...env, STAGE_A_TEST: '1', STAGE_A_POLICY: realHost }, encoding: 'utf8' });
  assert.equal(r2.status, 7); assert.match(r2.stdout, /non-\.test hosts/);
});

test('L5: repeated oversized responses terminate (body-cap-repeat)', opts, () => {
  const r = run('bigs', 60, ['http://allowed.test/bigs']);
  assert.equal(r.violation().kind, 'body-cap-repeat');
});
test('L5: a redirect loop is cut off (A-class redirect-loop)', opts, () => {
  const r = run('loop', 60, ['http://allowed.test/loop']);
  assert.ok(r.summary.blocks['redirect-loop'] >= 1, JSON.stringify(r.summary));
  assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
  assert.ok(r.lines('proxy/requests.jsonl').filter(l => l.path === '/loop').length <= 11);
});
test('L5: Location header injection does not smuggle headers; only the safe set is forwarded', opts, () => {
  const r = testRun('inject', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify({ full: true, reqs: [raw('allowed.test', 'http://allowed.test/redir-inject')] }));
  const h = JSON.parse(r.read('browser/probe.json'))[0] as string;
  assert.match(h, /^HTTP\/1\.1 302/);
  assert.ok(!h.split('\r\n').some(l => /^(set-cookie|x-evil):/i.test(l)), h);
  const loc = h.split('\r\n').find(l => /^location:/i.test(l))!;
  assert.equal(loc, 'location: http://allowed.test/a%0d%0aSet-Cookie:%20injected=1');
});
for (const [name, path] of [['redir-userinfo', '/redir-userinfo'], ['redir-port', '/redir-port'], ['redir-js', '/redir-js']] as const) {
  test(`L5: top-level redirect to ${name} terminates`, opts, () => {
    const r = run(name, 30, [`http://allowed.test${path}`]);
    assert.equal(r.violation().kind, 'redirect-off-list');
  });
}

test('gateway: no Docker networks; proxy --network none, fixture in the proxy netns; proxy reaches no gateway', opts, () => {
  const r = testRun('proxy-isolation', 30, ['http://allowed.test/a'], 'node /runner/browse.mjs');
  const r2 = run('proxy-probe', 30, [], { STAGE_A_TEST: '1', CMD: 'sleep 6', PROXY_PROBE: '1' });
  const p = JSON.parse(r2.read('proxy/proxy-probe.json'));
  for (const k of ['gw_up_111', 'gw_in_111', 'gw_up_2375', 'internet', 'dns8', 'metadata', 'desktop_vm', 'ipv6', 'host_internal', 'gateway_internal', 'public_dns', 'fixture_old_bridge']) assert.equal(p[k], 'blocked', k);
  assert.equal(p.fixture_loopback, 'REACHED');
  assert.equal(p.ifaces, 'lo');
  const ci = r.read('containers.inspect').trim().split('\n').map(l => l.split(' '));
  assert.deepEqual(ci.map(c => c[6].replace(/:.*/, '')), ['none', 'none', 'container']);
  assert.ok(ci.every(c => c[7] === '["ALL"]' && c[8] === 'false'), 'caps dropped, not privileged');
  assert.match(r.read('docker-commands.txt'), /--network none/);
  assert.doesNotMatch(r.read('docker-commands.txt'), /--privileged|--cap-add/);
});

// ---- t27u ----
const runOut = (r: Run) => r.out;
test('t27u: sealed manifest detects post-run tampering of every evidence class', opts, () => {
  const r = run('seal', 30, ['http://allowed.test/a']);
  const verify = (d: string) => spawnSync('python3', [join(here, 'verify-evidence.py'), d], { encoding: 'utf8' });
  assert.equal(verify(r.out).stdout.trim(), 'intact');
  const cases: [string, (d: string) => void, RegExp][] = [
    ['proxy log edited', d => { chmodSync(join(d, 'proxy/requests.jsonl'), 0o600); appendFileSync(join(d, 'proxy/requests.jsonl'), '{}\n'); }, /mismatch:requests\.jsonl/],
    ['browser result edited', d => { chmodSync(join(d, 'browser/browse.json'), 0o600); writeFileSync(join(d, 'browser/browse.json'), '[]'); }, /changed:browser\/browse\.json/],
    ['summary edited', d => { chmodSync(join(d, 'summary.json'), 0o600); writeFileSync(join(d, 'summary.json'), '{}'); }, /changed:summary\.json/],
    ['file added', d => writeFileSync(join(d, 'browser/extra.txt'), 'x'), /file-set-changed/],
    ['file deleted', d => rmSync(join(d, 'proxy.log')), /file-set-changed/],
    ['journal truncated', d => { chmodSync(join(d, 'proxy/journal.chain'), 0o600); writeFileSync(join(d, 'proxy/journal.chain'), ''); }, /mismatch|unjournaled/],
    ['manifest re-written without nonce', d => { chmodSync(join(d, 'MANIFEST.sealed'), 0o600); writeFileSync(join(d, 'MANIFEST.sealed'), readFileSync(join(d, 'MANIFEST.sealed'), 'utf8').replace(/SEAL \w+/, 'SEAL ' + '0'.repeat(64))); }, /seal-mismatch/],
  ];
  for (const [name, tamper, why] of cases) {
    const d = mkdtempSync(join(root, 'tamper-copy-'));
    spawnSync('cp', ['-Rp', r.out + '/.', d]);
    assert.equal(verify(d).stdout.trim(), 'intact', `${name}: copy intact before tamper`);
    tamper(d);
    const v = verify(d);
    assert.equal(v.status, 1, name); assert.match(v.stdout, why, name);
  }
});

const polWith = (extra: object) => { const p = join(root, `pol-${Math.random().toString(36).slice(2)}.json`); const base = JSON.parse(readFileSync(join(here, 'policy.json'), 'utf8')); writeFileSync(p, JSON.stringify({ ...base, ...extra(base) })); return p; };
test('rule: userinfo in request URL terminates', opts, () => {
  const r = testRun('userinfo', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'http://u:p@allowed.test/a')]));
  assert.equal(r.violation().kind, 'userinfo');
});
test('rule: absolute https URL (scheme) terminates', opts, () => {
  const r = testRun('scheme', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'https://allowed.test/a')]));
  assert.equal(r.violation().kind, 'scheme');
});
test('rule: unparseable absolute URL terminates (bad-url)', opts, () => {
  const r = testRun('bad-url', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'http://[bad/')]));
  assert.match(r.violation().kind, /^(bad-url|malformed-request)$/);
});
test('rule: non-GET subresource is blocked and logged (A-class method)', opts, () => {
  const r = testRun('post-sub', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([`POST http://allowed.test/a HTTP/1.1\r\nHost: allowed.test\r\nAccept: */*\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`]));
  assert.equal(r.summary.blocks.method, 1); assert.equal(existsSync(join(r.out, 'proxy', 'VIOLATION')), false);
});
test('rule: >5 subresource attempts to one off-list host within 60 s terminates (off-list-repeat)', opts, () => {
  const r = testRun('offlist-repeat', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify(Array.from({ length: 7 }, (_, i) => raw('evil.test', `http://evil.test/${i}.png`, 'Accept: image/png\r\n'))));
  assert.equal(r.violation().kind, 'off-list-repeat');
});
test('rule: allowed host without a DNS answer is blocked (dns-nxdomain)', opts, () => {
  const r = run('nxdomain', 30, ['http://nodns.test/'], { STAGE_A_TEST: '1', STAGE_A_POLICY: polWith((b: any) => ({ allow: [...b.allow, 'nodns.test'] })) });
  assert.equal(r.summary.blocks['dns-nxdomain'], 1);
});
test('rule: upstream timeout is blocked and the run reports errors', opts, () => {
  const r = run('upstream', 40, ['http://allowed.test/hang']);
  assert.equal(r.summary.blocks['upstream-error'], 1); assert.equal(r.summary.result, 'completed-with-errors-TEST');
});
for (const host of ['r5.test', 'rhtml.test']) {
  test(`t27u: robots.txt ${host === 'r5.test' ? '5xx' : 'returning HTML'} fails closed (everything disallowed)`, opts, () => {
    const r = run('robots-' + host, 30, [`http://${host}/a`], { STAGE_A_TEST: '1', STAGE_A_POLICY: polWith((b: any) => ({ allow: [...b.allow, host], dns: { ...b.dns, [host]: ['45.0.0.10'] } })) });
    assert.equal(r.summary.blocks.robots, 1, JSON.stringify(r.summary));
    assert.ok(r.lines('proxy/decisions.jsonl').some(d => d.rule === 'robots-fail-closed'));
  });
}

// ---- Round 3 ----
test('R3-1: FIFO / host-symlink / dangling symlink in scratch are refused and logged as a violation; nothing followed', opts, () => {
  const r = testRun('scratch-evil', 30, [], 'mkfifo /scratch/browse.json; ln -s /etc/passwd /scratch/host; ln -s ../nope /scratch/dangle; echo hi > /scratch/ok.txt');
  assert.match(r.summary.result, /^auto-terminated: scratch-violation /);
  const reasons = r.summary.scratch_refused.map((x: any) => `${x.path}:${x.reason}`).sort();
  assert.deepEqual(reasons, ['browse.json:fifo', 'dangle:symlink', 'host:symlink']);
  assert.equal(existsSync(join(r.out, 'browser/host')), false); assert.equal(existsSync(join(r.out, 'browser/browse.json')), false);
  assert.equal(r.read('browser/ok.txt'), 'hi\n');
  assert.notEqual(r.code, 0); assert.equal(r.summary.evidence_integrity, true); nothingLeft(r);
});
test('R3-1: disk fill is bounded by the 64 MiB tmpfs and the per-file cap refuses the file', opts, () => {
  // dd's own stderr can't be kept in a full /scratch, so the bound is shown by the file size the tmpfs allowed (asked: 200 MiB).
  const r = testRun('scratch-fill', 40, [], 'dd if=/dev/zero of=/scratch/fill bs=1M count=200; true');
  const f = r.summary.scratch_refused.find((x: any) => x.path === 'fill');
  assert.equal(f.reason, 'size-cap'); assert.ok(f.size > 60 * 1024 * 1024 && f.size <= 64 * 1024 * 1024, String(f.size));
  assert.equal(existsSync(join(r.out, 'browser/fill')), false);
  assert.match(r.summary.result, /scratch-violation/); nothingLeft(r);
});
test('R3-2: a sealing failure fails the run (non-zero exit, integrity false)', opts, () => {
  const r = run('seal-break', 30, ['http://allowed.test/a'], { STAGE_A_TEST: '1', STAGE_A_TEST_BREAK_SEAL: '1' });
  assert.equal(r.code, 10, r.stdout); assert.equal(r.summary.evidence_integrity, false);
  assert.equal(r.summary.integrity_checked_after_seal, true);
});
test('R3-4: robots rules match path + query', opts, () => {
  const r = run('robots-query', 30, ['http://allowed.test/search?q=x', 'http://allowed.test/search?p=1']);
  assert.equal(r.summary.blocks['robots'], 1, JSON.stringify(r.summary.blocks));
  assert.ok(r.lines('proxy/requests.jsonl').some((l: any) => l.status === 200 && /search/.test(l.path_raw ?? l.path ?? '')));
});
test('R3-5: missing Host header terminates', opts, () => {
  const r = testRun('host-missing', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([`GET http://allowed.test/a HTTP/1.1\r\nConnection: close\r\n\r\n`]));
  assert.equal(r.violation().kind, 'host-header-missing');
});
test('R3-5: duplicate Host header terminates', opts, () => {
  const r = testRun('host-dup', 30, [], 'node /runner/tests/probe.mjs', JSON.stringify([raw('allowed.test', 'http://allowed.test/a', 'Host: blocked.test\r\n')]));
  assert.equal(r.violation().kind, 'host-header-duplicate');
});
test('R3-6: a SIGKILLed supervisor leaves resources that the next start sweeps', opts, async () => {
  const out = join(mkdtempSync(join(root, 'killed-')), 'ev');
  const p = spawn('zsh', [join(here, 'run.sh'), out, '60'], { env: { ...env, STAGE_A_TEST: '1', CMD: 'sleep 50' }, stdio: 'ignore' });
  let nonce = '';
  for (let i = 0; i < 100 && !nonce; i++) { await new Promise(r => setTimeout(r, 300)); nonce = (existsSync(join(out, 'supervisor.log')) ? readFileSync(join(out, 'supervisor.log'), 'utf8') : '').match(/nonce=([0-9a-f]{8})/)?.[1] ?? ''; }
  assert.ok(nonce);
  for (let i = 0; i < 50 && ofRun('ps', nonce).length < 4; i++) await new Promise(r => setTimeout(r, 300));
  p.kill('SIGKILL'); await new Promise(r => p.once('exit', r));   // our own disposable child zsh only
  const q = (k: 'ps' | 'volume') => ofRun(k, nonce).join(',');
  assert.notEqual(q('ps') + q('volume'), '', 'SIGKILL leaves something behind (precondition)');
  const r = run('after-kill', 30, ['http://allowed.test/a']);
  assert.match(r.read('supervisor.log') + readFileSync(env.A3_KILL_LOG, 'utf8'), /sweep stale/);
  assert.equal(q('ps'), ''); assert.equal(q('volume'), '');
});
test('R3-7: policy.json + policy.sha256 edited together (uncommitted) are refused outside test mode', { timeout: 60_000 }, () => {
  const wt = dirname(dirname(here)), d = mkdtempSync(join(tmpdir(), 'r37-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  try {
    spawnSync('git', ['clone', '-q', '--local', '--no-hardlinks', wt, d]);
    spawnSync('rsync', ['-a', '--exclude', 'node_modules', here + '/', join(d, 'harness/stage-a-runner/')]);
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'snapshot', '--allow-empty');
    const pj = join(d, 'harness/stage-a-runner/policy.json');
    writeFileSync(pj, readFileSync(pj, 'utf8').replace('"maxRedirects": 10', '"maxRedirects": 11'));
    const sha = spawnSync('shasum', ['-a', '256', pj], { encoding: 'utf8' }).stdout.split(' ')[0];
    writeFileSync(join(d, 'harness/stage-a-runner/policy.sha256'), sha + '\n');
    const r = spawnSync('zsh', [join(d, 'harness/stage-a-runner/run.sh'), join(d, 'ev'), '30'], { env: { ...env, ...PROD }, encoding: 'utf8' });
    assert.equal(r.status, 8, r.stdout + r.stderr); assert.match(r.stdout, /differ from committed HEAD/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Round 4 ----
const prodRun = (dir: string, extra: Record<string, string> = {}) => spawnSync('zsh', [join(dir, 'harness/stage-a-runner/run.sh'), join(mkdtempSync(join(tmpdir(), 'r4ev-')), 'ev'), '30'], { env: { ...env, ...PROD, ...extra }, encoding: 'utf8' });
const scratchClone = () => {
  const d = mkdtempSync(join(tmpdir(), 'r42-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
  spawnSync('git', ['clone', '-q', '--local', '--no-hardlinks', dirname(dirname(here)), d]);
  spawnSync('rsync', ['-a', '--exclude', 'node_modules', here + '/', join(d, 'harness/stage-a-runner/')]);
  g('add', '-A'); g('commit', '-qm', 'snapshot', '--allow-empty');
  return { d, g, head: () => g('rev-parse', 'HEAD').stdout.trim() };
};
test('R4-2: a detached, unreviewed commit with a loosened (re-pinned) policy is refused in production mode', { timeout: 60_000 }, () => {
  const { d, g, head } = scratchClone(); const allow = join(mkdtempSync(join(tmpdir(), 'r42a-')), 'approved.txt');
  try {
    const approved = head(); writeFileSync(allow, `${approved} D-test\n`, { mode: 0o600 });
    g('checkout', '-q', '--detach');
    const pj = join(d, 'harness/stage-a-runner/policy.json');
    const pol = JSON.parse(readFileSync(pj, 'utf8')); pol.allow.push('evil.example'); writeFileSync(pj, JSON.stringify(pol, null, 2));
    writeFileSync(join(d, 'harness/stage-a-runner/policy.sha256'), spawnSync('shasum', ['-a', '256', pj], { encoding: 'utf8' }).stdout.split(' ')[0] + '\n');
    g('commit', '-qam', 'loosen policy (unreviewed)');
    assert.equal(g('branch', '--show-current').stdout.trim(), '', 'detached');
    assert.notEqual(head(), approved);   // a descendant of an approved commit is still refused (exact-id match, not ancestry)
    const r = prodRun(d, { STAGE_A_APPROVED_COMMITS: allow });
    assert.equal(r.status, 8, r.stdout + r.stderr); assert.match(r.stdout, /is not an approved commit \(head-not-approved/);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(dirname(allow), { recursive: true, force: true }); }
});
const approval = (head: string, path: string, wt = dirname(dirname(here))) => spawnSync('python3', [join(here, 'check-approval.py'), head, wt, path], { encoding: 'utf8' }).stdout.split('\n');
test('R4-2/R5-3: allowlist checks (missing, symlink, world-/group-writable, in-repo, inside ANY git repo/worktree/.git, approved)', { timeout: 60_000 }, () => {
  const { d, g, head } = scratchClone(); const ad = mkdtempSync(join(tmpdir(), 'r42b-')); const h = head();
  try {
    const good = join(ad, 'ok.txt'); writeFileSync(good, h + ' D-test\n', { mode: 0o600 });
    const link = join(ad, 'link.txt'); spawnSync('ln', ['-s', good, link]);
    const ww = join(ad, 'ww.txt'); writeFileSync(ww, h + '\n'); chmodSync(ww, 0o602);
    const gw = join(ad, 'gw.txt'); writeFileSync(gw, h + '\n'); chmodSync(gw, 0o620);
    const inRepo = join(d, '.approved'); writeFileSync(inRepo, h + '\n', { mode: 0o600 });
    const other = mkdtempSync(join(tmpdir(), 'r53repo-')); spawnSync('git', ['init', '-q', other]);
    const inOther = join(other, 'sub'); mkdirSync(inOther); writeFileSync(join(inOther, 'a.txt'), h + '\n', { mode: 0o600 });
    writeFileSync(join(other, '.git', 'a.txt'), h + '\n', { mode: 0o600 });
    const wtDir = join(ad, 'linked-wt'); g('worktree', 'add', '-q', '--detach', wtDir); writeFileSync(join(wtDir, 'a.txt'), h + '\n', { mode: 0o600 });
    for (const [f, why] of [[join(ad, 'none.txt'), 'allowlist-missing'], [link, 'allowlist-not-regular'], [ww, 'allowlist-bad-owner-or-mode'], [gw, 'allowlist-bad-owner-or-mode'],
      [inRepo, 'allowlist-inside-repo'], [join(inOther, 'a.txt'), 'allowlist-inside-git'], [join(other, '.git', 'a.txt'), 'allowlist-inside-git'], [join(wtDir, 'a.txt'), 'allowlist-inside-git']] as const) {
      const [ok, , reason] = approval(h, f, d); assert.equal(ok, '0', f); assert.equal(reason, why, f);
    }
    const [ok, sha, reason, path] = approval(h, good, d);
    assert.deepEqual([ok, reason, path], ['1', 'approved', good]); assert.match(sha, /^[0-9a-f]{64}$/);
    assert.equal(approval('a'.repeat(40), good, d)[2], 'head-not-approved');
    assert.equal(approval(h.slice(0, 12), good, d)[2], 'no-head');
    rmSync(other, { recursive: true, force: true }); g('worktree', 'remove', '--force', wtDir);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(ad, { recursive: true, force: true }); }
});
test('R5-1: production refuses a dirty or untracked file ANYWHERE in the tree (agent/lib/public-address.ts)', { timeout: 60_000 }, () => {
  const { d } = scratchClone();
  try {
    const f = join(d, 'agent/lib/public-address.ts'); assert.ok(existsSync(f));
    const orig = readFileSync(f, 'utf8');
    writeFileSync(f, orig + '\n// unreviewed change\n');
    let r = prodRun(d); assert.equal(r.status, 8, r.stdout); assert.match(r.stdout, /not clean/);
    writeFileSync(f, orig);
    writeFileSync(join(d, 'agent/lib/untracked-helper.ts'), 'export {}\n');
    r = prodRun(d); assert.equal(r.status, 8, r.stdout); assert.match(r.stdout, /not clean/);
    rmSync(join(d, 'agent/lib/untracked-helper.ts'));
    spawnSync('ln', ['-s', '/nonexistent-nm', join(d, 'node_modules')]);   // node_modules alone is excluded from the check
    r = prodRun(d); assert.equal(r.status, 8, r.stdout); assert.doesNotMatch(r.stdout, /not clean/); assert.match(r.stdout, /not an approved commit/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('R5-2: STAGE_A_APPROVED_COMMITS is ignored in production (fixed default allowlist is used)', { timeout: 60_000 }, () => {
  const { d, head } = scratchClone(); const ad = mkdtempSync(join(tmpdir(), 'r52-'));
  try {
    const mine = join(ad, 'mine.txt'); writeFileSync(mine, head() + ' self-approved\n', { mode: 0o600 });
    assert.equal(approval(head(), mine, d)[0], '1', 'the file itself would approve HEAD');
    const r = prodRun(d, { STAGE_A_APPROVED_COMMITS: mine });
    assert.equal(r.status, 8, r.stdout); assert.match(r.stdout, /head-not-approved; allowlist .*rove-recovery-evidence\/stage-a-runner\/APPROVED-COMMITS\.txt\)/);
    assert.doesNotMatch(r.stdout, new RegExp(mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(ad, { recursive: true, force: true }); }
});
test('R5-4: containers run from a snapshot, not the live tree (git archive excludes uncommitted edits)', opts, () => {
  const { d } = scratchClone();
  try {
    const nmLive = join(dirname(dirname(here)), 'node_modules');
    spawnSync('ln', ['-s', spawnSync('readlink', [nmLive], { encoding: 'utf8' }).stdout.trim() || nmLive, join(d, 'node_modules')]);
    appendFileSync(join(d, 'harness/stage-a-runner/fixture.mjs'), '\n// R54MARK\n');
    const cmd = 'grep -c R54MARK /runner/fixture.mjs > /scratch/m.txt; true';
    const go = (extra: Record<string, string>) => {
      const out = join(mkdtempSync(join(root, 'r54-')), 'ev');
      spawnSync('zsh', [join(d, 'harness/stage-a-runner/run.sh'), out, '30'], { env: { ...env, CMD: cmd, ...extra }, encoding: 'utf8' });
      return { m: existsSync(join(out, 'browser/m.txt')) ? readFileSync(join(out, 'browser/m.txt'), 'utf8').trim() : 'missing', s: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')), out };
    };
    const a = go({ STAGE_A_TEST_SNAPSHOT: 'git-archive' });
    assert.equal(a.m, '0', 'uncommitted edit NOT visible'); assert.match(a.s.run_snapshot, /^git-archive:[0-9a-f]{40}$/);
    assert.match(a.s.node_modules_lock_sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(readFileSync(join(a.out, 'docker-commands.txt'), 'utf8'), new RegExp(`-v ${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/:]`), 'live tree never mounted');
    const b = go({});
    assert.equal(b.m, '1', 'test-mode worktree copy includes the edit'); assert.equal(b.s.run_snapshot, 'worktree-copy');
    assert.equal(spawnSync('sh', ['-c', `ls -d "\${TMPDIR:-/tmp}"/rove-a3-snap-* 2>/dev/null | wc -l`], { encoding: 'utf8' }).stdout.trim(), '0', 'snapshots removed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('R4-1: control-character / newline / space filenames are refused (bad-name); final result logged after verification', opts, () => {
  const r = testRun('badname', 30, [], `touch "/scratch/a$(printf '\\nresult=completed')" "/scratch/sp ace" /scratch/ok-1.txt`);
  assert.deepEqual([...new Set(r.summary.scratch_refused.map((x: any) => x.reason))], ['bad-name']);
  assert.equal(r.summary.scratch_refused.length, 2); assert.equal(r.summary.evidence_integrity, true);
  assert.match(r.summary.result, /^auto-terminated: scratch-violation bad-name-TEST$/);
  assert.ok(existsSync(join(r.out, 'browser/ok-1.txt')));
  const log = r.read('supervisor.log').trim().split('\n');
  assert.match(log.at(-1)!, /final result=auto-terminated: scratch-violation bad-name-TEST evidence_integrity=true/);
  assert.equal(log.filter(l => / result=completed/.test(l)).length, 0, 'no injected/stale completed line');
});
test('R4-3: the sweep skips rove.a3-labelled resources without the rove-a3- name prefix or a valid nonce', opts, () => {
  const tag = String(process.pid), dead = '1-DeadSupervisor';
  const decoys = [[`decoy-r43-${tag}`, 'a'.repeat(32)], [`rove-a3-r43bad-${tag}`, 'not-a-nonce']];
  try {
    for (const [n, nonce] of decoys) {
      assert.equal(spawnSync('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--label', 'rove.a3=1', '--label', `rove.a3.nonce=${nonce}`, '--label', `rove.a3.sup=${dead}`, '--name', n, 'node:24-bookworm-slim', 'sleep', '120']).status, 0);
      assert.equal(spawnSync('docker', ['volume', 'create', '--label', 'rove.a3=1', '--label', `rove.a3.nonce=${nonce}`, '--label', `rove.a3.sup=${dead}`, `${n}-vol`]).status, 0);
    }
    const r = run('sweep-guard', 30, ['http://allowed.test/a']);
    assert.equal(r.code, 0, r.stdout);
    for (const [n] of decoys) {
      assert.equal(spawnSync('docker', ['inspect', n]).status, 0, `${n} not swept`);
      assert.equal(spawnSync('docker', ['volume', 'inspect', `${n}-vol`]).status, 0, `${n}-vol not swept`);
    }
    assert.match(readFileSync(env.A3_KILL_LOG, 'utf8'), /sweep skip-unrecognised/);
  } finally { for (const [n] of decoys) { spawnSync('docker', ['rm', '-f', n]); spawnSync('docker', ['volume', 'rm', `${n}-vol`]); } }  // our own decoys only
});
test('R4-4: copy-out is aborted and the run fails if the browser container is still present', opts, () => {
  const r = run('browser-alive', 4, [], { STAGE_A_TEST: '1', CMD: 'echo x > /scratch/late.txt; sleep 60', STAGE_A_TEST_KEEP_BROWSER: '1' });
  assert.notEqual(r.code, 0); assert.match(r.summary.result, /^auto-terminated: scratch browser-still-present/);
  assert.equal(r.summary.scratch_copied, 0); assert.equal(existsSync(join(r.out, 'browser/late.txt')), false);
  assert.match(r.read('supervisor.log'), /copy-out aborted/); nothingLeft(r);
});
