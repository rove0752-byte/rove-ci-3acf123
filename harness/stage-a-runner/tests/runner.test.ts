// Stage A isolated-runner validation. Local fixtures on internal-only Docker networks; no external hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const EV = process.env.STAGE_A_EVIDENCE ?? join(process.env.HOME!, 'rove-recovery-evidence', 'stage-a-runner', 'tmp');
mkdirSync(EV, { recursive: true, mode: 0o700 });
const env = { ...process.env, A3_REGISTRY: join(EV, 'registry'), A3_KILL_LOG: join(EV, 'kill.log') };
const ok = spawnSync('docker', ['image', 'inspect', 'rove-browser-pilot:local', 'node:24-bookworm-slim']).status === 0;
const opts = { skip: !ok && 'local images not present', timeout: 120_000 };
const run = (name: string, wall: number, urls: string[], extra: Record<string, string> = {}) => {
  const out = join(EV, name);
  const r = spawnSync('zsh', [join(here, 'run.sh'), out, String(wall), ...urls], { env: { ...env, ...extra }, encoding: 'utf8' });
  const read = (f: string) => existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : '';
  return { code: r.status, out, read, summary: JSON.parse(read('summary.json') || '{}'), lines: (f: string) => read(f).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
};
const noLeft = () => assert.equal(spawnSync('docker', ['ps', '-aq', '--filter', 'label=rove.a3=1'], { encoding: 'utf8' }).stdout.trim(), '');

test('positive control: allowed hosts load; per-request and DNS logs; limits applied; evidence 0700/0600; checksums', opts, () => {
  const r = run('ok', 60, ['http://allowed.test/', 'http://allowed.test/a', 'http://other.test/']);
  assert.equal(r.code, 0, r.read('supervisor.log'));
  assert.deepEqual(JSON.parse(r.read('browse.json')).map((x: any) => x.title), ['Allowed home', 'Page A', 'Allowed home']);
  for (const l of r.lines('requests.jsonl')) for (const k of ['host', 'ip', 'status', 'bytes']) assert.ok(k in l, k);
  assert.ok(r.lines('requests.jsonl').filter(l => !l.robots).every(l => 'ms' in l));
  assert.equal(r.lines('dns.jsonl').length, 2);
  assert.match(r.read('browser.inspect'), /^1000000000 1073741824 256 true true .*"rove-a3-in"/);
  assert.ok(r.summary.peak_memory_bytes > 10_000_000 && r.summary.peak_memory_bytes <= 1073741824);
  assert.equal(statSync(r.out).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.out, 'requests.jsonl')).mode & 0o777, 0o600);
  assert.equal(spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: r.out }).status, 0);
  noLeft();
});

for (const [name, urls, kind] of [
  ['offlist', ['http://allowed.test/offlist'], 'off-list-host'],
  ['private', ['http://private.test/'], 'private-ip'],
  ['mixed', ['http://mixed.test/'], 'private-ip'],
  ['rate', ['http://allowed.test/burst'], 'rate-exceeded'],
  ['robots', ['http://allowed.test/robots-trap'], 'robots-disallow'],
  ['unlisted-direct', ['http://evil.test/'], 'off-list-host'],
] as const) {
  test(`negative: ${name} auto-terminates the run (${kind})`, opts, () => {
    const r = run(name, 60, [...urls]);
    assert.equal(r.code, 9);
    assert.equal(JSON.parse(r.read('VIOLATION')).kind, kind);
    assert.match(r.summary.result, /^auto-terminated/);
    assert.equal(r.summary.containers_left, 0);
    noLeft();
  });
}

test('DNS pinning: a rebinding answer on the second lookup is never used', opts, () => {
  const r = run('rebind', 60, ['http://rebind.test/', 'http://rebind.test/a']);
  assert.equal(r.code, 0);
  assert.equal(r.lines('dns.jsonl').length, 1, 'resolved once');
  assert.ok(r.lines('requests.jsonl').every(l => l.ip === '45.0.0.10'));
});

test('isolation: browser container has no route to the fixture, the internet or DNS except via the proxy', opts, () => {
  const probe = `node -e 'const t=async(n,f)=>{try{await f();return n+":REACHED"}catch(e){return n+":blocked"}};Promise.all([t("fixture-direct",()=>fetch("http://10.89.1.10/",{signal:AbortSignal.timeout(3000)})),t("internet-ip",()=>fetch("http://1.1.1.1/",{signal:AbortSignal.timeout(3000)})),t("public-dns",()=>require("dns").promises.lookup("example.com"))]).then(r=>require("fs").writeFileSync("/evidence/probe.txt",r.join("\\n")))'`;
  const r = run('isolation', 30, [], { CMD: probe });
  assert.equal(r.read('probe.txt').trim(), 'fixture-direct:blocked\ninternet-ip:blocked\npublic-dns:blocked');
  for (const n of ['rove-a3-up', 'rove-a3-in']) assert.equal(spawnSync('docker', ['network', 'inspect', '-f', '{{.Internal}}', n], { encoding: 'utf8' }).stdout.trim(), 'true');
});

test('memory and pids limits hold; peak memory captured', opts, () => {
  const r = run('limits', 40, [], { CMD: `node -e 'const a=[];for(;;)a.push(Buffer.alloc(5e7,1))'; (for i in $(seq 400); do sleep 5 & done; wait) 2>&1 | tail -1; echo done` });
  assert.ok(r.summary.peak_memory_bytes > 900_000_000 && r.summary.peak_memory_bytes <= 1073741824, String(r.summary.peak_memory_bytes));
  assert.match(r.read('browser.log'), /fork|Resource temporarily unavailable|Cannot/i);
});

test('wall clock kills a hung run and logs it', opts, () => {
  const r = run('wall', 8, ['http://allowed.test/hang']);
  assert.equal(r.code, 9);
  assert.match(r.summary.result, /wall-clock kill after 8s/);
  assert.match(r.read('supervisor.log'), /wall-clock -> kill/);
  noLeft();
});

test('external kill (kill.sh) ends a hung run; nothing left behind; kill logged', opts, async () => {
  const out = join(EV, 'extkill');
  const child = spawn('zsh', [join(here, 'run.sh'), out, '90', 'http://allowed.test/hang'], { env, stdio: 'ignore' });
  await new Promise(res => setTimeout(res, 6000));
  const k = spawnSync('zsh', [join(here, '..', 'a3-local', 'kill.sh')], { env, encoding: 'utf8' });
  assert.equal(k.status, 0, k.stdout);
  const code = await new Promise(res => child.on('exit', res));
  assert.equal(code, 9);
  assert.match(readFileSync(join(env.A3_KILL_LOG), 'utf8'), /killed name=rove-a3-\d+-\d+3 container=/);
  noLeft();
});
