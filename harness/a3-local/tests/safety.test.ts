// A3 safety regression tests. Disposable child processes only; an isolated registry per test run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'a3-safety-'));
const env = { ...process.env, A3_REGISTRY: join(root, 'registry'), A3_KILL_LOG: join(root, 'kill.log') };
const sh = (script: string, args: string[]) => spawnSync('zsh', [join(here, script), ...args], { env, encoding: 'utf8' });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgidOf = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
const killLog = () => existsSync(env.A3_KILL_LOG) ? readFileSync(env.A3_KILL_LOG, 'utf8') : '';
const register = (name: string, pid: number, pgid: number) => {
  execFileSync('zsh', ['-c', `source ${join(here, 'registry.sh')}; a3_init; print -r -- "type=pgid pid=${pid} pgid=${pgid} lstart=$(ps -o lstart= -p ${pid});" > "$A3_REGISTRY/${name}"`], { env });
};
const docker = spawnSync('docker', ['image', 'inspect', 'rove-browser-pilot:local']).status === 0;

test('kill.sh stops only a registered target group; supervisor and an unrelated sibling survive', async () => {
  const sibling = spawn('perl', ['-e', 'setpgrp(0,0); sleep 60'], { stdio: 'ignore' });
  const out = sh('spawn.sh', ['target1', join(root, 't1.log'), '--', 'zsh', '-c', 'sleep 60 & sleep 60 & wait']);
  const pid = Number(out.stdout.trim());
  assert.ok(pid > 1 && alive(pid));
  const children = execFileSync('pgrep', ['-g', String(pgidOf(pid))], { encoding: 'utf8' }).trim().split('\n').map(Number);
  assert.ok(children.length >= 3, 'target group has its own children');
  const r = sh('kill.sh', ['target1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  await new Promise(res => setTimeout(res, 300));
  assert.deepEqual(children.filter(alive), [], 'whole target group gone');
  assert.ok(alive(process.pid), 'supervisor (this test) survives');
  assert.ok(alive(sibling.pid!), 'unrelated sibling survives');
  assert.match(killLog(), /kill name=target1 pgid=\d+ signal=TERM/);
  assert.match(killLog(), /killed name=target1/);
  sibling.kill('SIGKILL');
});

test('kill.sh refuses unregistered, own, parent, PID 1 and session-leader targets and signals nothing', () => {
  const sibling = spawn('perl', ['-e', 'setpgrp(0,0); sleep 60'], { stdio: 'ignore' });
  assert.equal(sh('kill.sh', ['nope']).status, 3);
  register('own', process.pid, pgidOf(process.pid));
  register('pid1', 1, 1);
  const leader = spawn('perl', ['-e', 'use POSIX; POSIX::setsid(); sleep 60'], { stdio: 'ignore' });
  spawnSync('sleep', ['0.3']);
  register('leader', leader.pid!, pgidOf(leader.pid!));
  for (const name of ['own', 'pid1', 'leader']) {
    const r = sh('kill.sh', [name]);
    assert.equal(r.status, 4, `${name}: ${r.stdout}`);
  }
  assert.match(killLog(), /refuse name=nope reason=not-registered/);
  assert.match(killLog(), /refuse name=own .*reason=(own-pgid|parent-pgid)/);
  assert.match(killLog(), /refuse name=pid1 .*reason=pid1/);
  assert.match(killLog(), /refuse name=leader .*reason=session-leader/);
  assert.ok(alive(process.pid) && alive(sibling.pid!) && alive(leader.pid!));
  sibling.kill('SIGKILL'); leader.kill('SIGKILL');
});

test('external termination escalates to SIGKILL for a target that ignores SIGTERM', async () => {
  const pid = Number(sh('spawn.sh', ['stubborn', join(root, 's.log'), '--', 'perl', '-e', '$SIG{TERM}="IGNORE"; sleep 60']).stdout.trim());
  assert.ok(alive(pid));
  const t0 = Date.now();
  const r = sh('kill.sh', ['stubborn']);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(alive(pid), false);
  assert.match(killLog(), /kill name=stubborn pgid=\d+ signal=KILL/);
});

test('harness evidence is 0700 dirs / 0600 files', { timeout: 120_000 }, () => {
  const out = join(root, 'ev');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(here, 'run.ts'), out], { env: { ...env, A3_PAGES: 'simple' }, encoding: 'utf8', timeout: 110_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(statSync(join(out, 'screenshots')).mode & 0o777, 0o700);
  for (const f of readdirSync(out).filter(n => n !== 'screenshots')) assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, f);
});

test('container runs use --rm, keep logs, and the wall-clock kill is logged', { skip: !docker && 'local image not present', timeout: 180_000 }, () => {
  const ok = join(root, 'c-ok');
  const r1 = spawnSync('zsh', [join(here, 'runner.sh'), ok, '120'], { env: { ...env, A3_PAGES: 'simple' }, encoding: 'utf8' });
  assert.equal(r1.status, 0, readFileSync(join(ok, 'container.log'), 'utf8'));
  assert.match(readFileSync(join(ok, 'container.inspect'), 'utf8'), /1000000000 1073741824 256 "none" true true/);
  assert.equal(statSync(ok).mode & 0o777, 0o700);
  const hang = join(root, 'c-hang');
  const r2 = spawnSync('zsh', [join(here, 'runner.sh'), hang, '6'], { env: { ...env, A3_PAGES: 'hang' }, encoding: 'utf8' });
  assert.equal(r2.status, 137);
  assert.match(readFileSync(join(hang, 'runner.log'), 'utf8'), /wall-clock kill after 6s/);
  assert.match(killLog(), /wall-clock name=rove-a3-/);
  const left = spawnSync('docker', ['ps', '-a', '-q', '--filter', 'label=rove.a3=1'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'no containers left behind');
  assert.deepEqual(readdirSync(env.A3_REGISTRY).filter(n => n.startsWith('rove-a3-')), [], 'container registry entries cleaned');
});

test('security: path traversal, malformed entries, foreign containers and PID reuse are refused', { timeout: 30_000 }, () => {
  execFileSync('zsh', ['-c', `source ${join(here, 'registry.sh')}; a3_log seed`], { env });
  assert.equal(sh('kill.sh', ['../kill.log']).status, 3);
  assert.match(killLog(), /seed/, 'kill log not deleted via traversal');
  writeFileSync(join(env.A3_REGISTRY, 'bad'), 'type=pgid pid=abc pgid=abc\n');
  assert.equal(sh('kill.sh', ['bad']).status, 4);
  const reused = spawn('perl', ['-e', 'setpgrp(0,0); sleep 60'], { stdio: 'ignore' });
  spawnSync('sleep', ['0.3']);
  writeFileSync(join(env.A3_REGISTRY, 'reuse'), `type=pgid pid=${reused.pid} pgid=${reused.pid} lstart=Thu Jan  1 00:00:00 1970;\n`);
  assert.equal(sh('kill.sh', ['reuse']).status, 4);
  assert.ok(alive(reused.pid!), 'process with recycled pid survives');
  reused.kill('SIGKILL');
  if (docker) {
    spawnSync('docker', ['run', '-d', '--rm', '--name', 'a3sec-foreign', '--network', 'none', 'rove-browser-pilot:local', 'sleep', '30']);
    writeFileSync(join(env.A3_REGISTRY, 'foreign'), 'type=docker container=a3sec-foreign\n');
    assert.equal(sh('kill.sh', ['foreign']).status, 4);
    assert.equal(spawnSync('docker', ['ps', '-q', '--filter', 'name=a3sec-foreign'], { encoding: 'utf8' }).stdout.trim().length > 0, true, 'foreign container untouched');
    spawnSync('docker', ['kill', 'a3sec-foreign']);
  }
  assert.match(killLog(), /reason=bad-name/); assert.match(killLog(), /reason=malformed-entry/); assert.match(killLog(), /reason=start-time-mismatch/);
});
