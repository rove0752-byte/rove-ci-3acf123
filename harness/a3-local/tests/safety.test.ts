// A3 safety regression tests. Disposable child processes only; an isolated registry per test run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'a3-safety-'));
const env = { ...process.env, A3_REGISTRY: join(root, 'registry'), A3_KILL_LOG: join(root, 'kill.log'), A3_PROTECTED: join(root, 'protected') };
const sh = (script: string, args: string[]) => spawnSync('zsh', [join(here, script), ...args], { env, encoding: 'utf8' });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgidOf = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
const killLog = () => existsSync(env.A3_KILL_LOG) ? readFileSync(env.A3_KILL_LOG, 'utf8') : '';
const register = (name: string, pid: number, pgid: number) => {
  execFileSync('zsh', ['-c', `source ${join(here, 'registry.sh')}; a3_init; print -r -- "type=pgid pid=${pid} pgid=${pgid} lstart=$(ps -o lstart= -p ${pid} | sed "s/^ *//;s/ *$//");" > "$A3_REGISTRY/${name}"`], { env });
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
  assert.match(killLog(), /kill name=target1 pgid=\d+ .*signal=TERM/);
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
  assert.match(killLog(), /refuse name=own .*reason=ancestor/);
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
  assert.match(killLog(), /kill name=stubborn pgid=\d+ .*signal=KILL/);
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
  const t0 = Date.now();
  const r1 = spawnSync('zsh', [join(here, 'runner.sh'), ok, '117'], { env: { ...env, A3_PAGES: 'simple' }, encoding: 'utf8' });
  assert.equal(r1.status, 0, readFileSync(join(ok, 'container.log'), 'utf8'));
  assert.ok(Date.now() - t0 < 60_000, 'runner returns promptly (no orphan watchdog holding stdout)');
  assert.equal(spawnSync('pgrep', ['-f', '^sleep 117$']).status, 1, 'no orphan watchdog sleep');
  assert.match(readFileSync(join(ok, 'container.inspect'), 'utf8'), /1000000000 1073741824 256 "none" true true/);
  assert.equal(statSync(ok).mode & 0o777, 0o700);
  const hang = join(root, 'c-hang');
  const r2 = spawnSync('zsh', [join(here, 'runner.sh'), hang, '6'], { env: { ...env, A3_PAGES: 'hang' }, encoding: 'utf8' });
  assert.equal(r2.status, 137);
  assert.match(readFileSync(join(hang, 'runner.log'), 'utf8'), /wall-clock kill after 6s/);
  assert.match(killLog(), /wall-clock name=rove-a3-/);
  for (const name of killLog().match(/start name=(rove-a3-[0-9-]+)/g)!.map(x => x.slice(11)))
    assert.equal(spawnSync('docker', ['ps', '-a', '-q', '--filter', `name=^${name}$`], { encoding: 'utf8' }).stdout.trim(), '', `${name} removed`);
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
  assert.match(killLog(), /reason=bad-name/); assert.match(killLog(), /reason=malformed-entry/); assert.match(killLog(), /reason=start-time-mismatch/);
});

// Runs `inner` as the grandchild of a registered group leader G: G -> zsh (own group) -> kill.sh.
test('H1: kill.sh refuses a grandparent (any ancestor) group and the caller survives', () => {
  const reg = join(here, 'registry.sh');
  const script = `source ${reg}; a3_init; print -r -- "type=pgid pid=$$ pgid=$$ lstart=$(ps -o lstart= -p $$ | sed 's/^ *//;s/ *$//');" > "$A3_REGISTRY/gp"; perl -e 'setpgrp(0,0); exec @ARGV' zsh -c 'perl -e "setpgrp(0,0); exec @ARGV" zsh ${join(here, 'kill.sh')} gp; echo inner=$?'; echo outer-alive`;
  const r = spawnSync('perl', ['-e', 'setpgrp(0,0); exec @ARGV', 'zsh', '-c', script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inner=4/);
  assert.match(r.stdout, /outer-alive/);
  assert.match(killLog(), /refuse name=gp .*reason=ancestor/);
});

test('H1: own-pgid-only case (kill.sh exec-ed inside the registered group) is refused', () => {
  const reg = join(here, 'registry.sh');
  const script = `source ${reg}; a3_init; print -r -- "type=pgid pid=$$ pgid=$$ lstart=$(ps -o lstart= -p $$ | sed 's/^ *//;s/ *$//');" > "$A3_REGISTRY/self"; zsh ${join(here, 'kill.sh')} self; echo rc=$?`;
  const r = spawnSync('perl', ['-e', 'setpgrp(0,0); exec @ARGV', 'zsh', '-c', script], { env, encoding: 'utf8' });
  assert.match(r.stdout, /rc=4/);
  assert.match(killLog(), /refuse name=self .*reason=ancestor/);
});

test('M3: when the leader has exited, verified orphan members are still killed', async () => {
  const pid = Number(sh('spawn.sh', ['orph', join(root, 'o.log'), '--', 'zsh', '-c', 'perl -e \'$SIG{TERM}="IGNORE"; sleep 60\' & echo $! > ' + join(root, 'orph.child') + '; sleep 0.3']).stdout.trim());
  await new Promise(res => setTimeout(res, 1500));
  const child = Number(readFileSync(join(root, 'orph.child'), 'utf8'));
  assert.equal(alive(pid), false, 'leader exited');
  assert.ok(alive(child), 'orphan member alive');
  const r = sh('kill.sh', ['orph']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(alive(child), false, 'orphan member killed');
  assert.match(killLog(), /kill name=orph .*leader=exited signal=TERM/);
  assert.match(killLog(), /kill name=orph .*signal=KILL/);
});

test('M3/M5: a group member that predates the recorded leader start is not signalled (unverifiable)', () => {
  const m = spawn('perl', ['-e', 'setpgrp(0,0); sleep 60'], { stdio: 'ignore' });
  spawnSync('sleep', ['1.2']);
  // Forged entry: leader pid is m (still alive) but recorded start is later than m's real start.
  const later = new Date(Date.now() + 120_000).toString().replace(/ GMT.*/, '').replace(/^(\w+) (\w+) (\d+) (\d+) ([\d:]+)/, '$1 $2 $3 $5 $4');
  writeFileSync(join(env.A3_REGISTRY, 'early'), `type=pgid pid=${m.pid} pgid=${m.pid} lstart=${later};\n`);
  assert.equal(sh('kill.sh', ['early']).status, 4);
  assert.ok(alive(m.pid!));
  m.kill('SIGKILL');
});

test('M6: a look-alike container (matching name, rove.a3=1 label, real id) with the wrong nonce is refused; the right nonce works', { skip: !docker && 'local image not present', timeout: 60_000 }, () => {
  const name = `rove-a3-1-${process.pid}`;
  spawnSync('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--label', 'rove.a3=1', '--label', 'rove.a3.nonce=' + 'a'.repeat(32), '--name', name, 'rove-browser-pilot:local', 'sleep', '60']);
  const [id, created] = spawnSync('docker', ['inspect', '-f', '{{.Id}} {{.Created}}', name], { encoding: 'utf8' }).stdout.trim().split(' ');
  writeFileSync(join(env.A3_REGISTRY, 'spoof'), `type=docker name=${name} id=${id} created=${created} nonce=${'b'.repeat(32)}\n`);
  assert.equal(sh('kill.sh', ['spoof']).status, 4);
  assert.match(killLog(), /refuse name=spoof .*reason=container-not-ours/);
  assert.equal(spawnSync('docker', ['ps', '-q', '--filter', `name=^${name}$`], { encoding: 'utf8' }).stdout.trim().length > 0, true, 'look-alike untouched');
  writeFileSync(join(env.A3_REGISTRY, 'mine'), `type=docker name=${name} id=${id} created=${created} nonce=${'a'.repeat(32)}\n`);
  assert.equal(sh('kill.sh', ['mine']).status, 0);
  assert.equal(spawnSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' }).stdout.trim(), '');
  writeFileSync(join(env.A3_REGISTRY, 'legacy'), `type=docker container=${name}\n`);
  assert.equal(sh('kill.sh', ['legacy']).status, 4, 'name-only entries are malformed');
});

// N2: the supervisor S registers itself as protected, is ALSO (maliciously/mistakenly) registered as a target,
// and launches kill.sh detached so that S is not in kill.sh's ancestry. S must survive in every variant.
for (const [variant, launch] of [
  ['double-fork+setsid', `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; exec @ARGV' zsh $K det`],
  // nohup+disown in the SAME group is already refused as own-pgid; this variant also leaves the group and the tree.
  ['nohup+disown', `( nohup perl -e 'setpgrp(0,0); select(undef,undef,undef,0.4); exec @ARGV' zsh $K det >/dev/null 2>&1 &! )`],
  ['setsid-only', `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exec @ARGV' zsh $K det`],
] as const) {
  test(`N2: protected supervisor survives a detached kill.sh (${variant})`, { timeout: 20_000 }, async () => {
    const reg = join(here, 'registry.sh');
    const tag = variant.replace(/\W/g, '');
    const script = `source ${reg}; a3_init; a3_protect $$; print -r -- "type=pgid pid=$$ pgid=$$ lstart=$(a3_lstart $$);" > "$A3_REGISTRY/det"; K=${join(here, 'kill.sh')}; ${launch}; for i in {1..60}; do grep -q 'name=det' "$A3_KILL_LOG" 2>/dev/null && break; sleep 0.1; done; sleep 0.5; echo survived-${tag}; a3_unprotect $$`;
    const vlog = join(root, `kill-${tag}.log`);
    const r = spawnSync('perl', ['-e', 'setpgrp(0,0); exec @ARGV', 'zsh', '-c', script], { env: { ...env, A3_KILL_LOG: vlog }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`survived-${tag}`));
    assert.match(readFileSync(vlog, 'utf8'), /refuse name=det .*reason=protected-supervisor/, 'refused by the deny-list, not by ancestry');
    rmSync(join(env.A3_REGISTRY, 'det'), { force: true });
  });
}

test('N2: a protected process inside a target group blocks the kill; a stale protection entry does not', async () => {
  const pid = Number(sh('spawn.sh', ['grp', join(root, 'g.log'), '--', 'zsh', '-c', 'sleep 30 & echo $! > ' + join(root, 'grp.child') + '; wait']).stdout.trim());
  await new Promise(res => setTimeout(res, 400));
  const child = Number(readFileSync(join(root, 'grp.child'), 'utf8'));
  execFileSync('zsh', ['-c', `source ${join(here, 'registry.sh')}; a3_protect ${child}`], { env });
  assert.equal(sh('kill.sh', ['grp']).status, 4);
  assert.match(killLog(), /refuse name=grp .*reason=protected-supervisor/);
  assert.ok(alive(pid) && alive(child));
  // make the entry stale (wrong start time): it must be ignored
  writeFileSync(join(env.A3_PROTECTED, String(child)), `pid=${child} lstart=Thu Jan  1 00:00:00 1970;\n`);
  assert.equal(sh('kill.sh', ['grp']).status, 0);
  assert.equal(alive(child), false);
});
