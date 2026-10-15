#!/usr/bin/env python3
"""Stage A production approval check (R4-2, R5-2, R5-3). Trusted, host-side only; no container mounts this.
usage: check-approval.py <head-commit> <worktree> [override-path]
The override is passed by run.sh ONLY in test mode (R5-2); in production the allowlist is always the fixed default
<passwd home>/rove-recovery-evidence/stage-a-runner/APPROVED-COMMITS.txt ($HOME is not trusted for this).
       check-approval.py --launcher-dir <dir>      (R7-4: trusted external launcher)
       check-approval.py --node-modules <dir>      (M3/NM: node_modules tree hash vs APPROVED-NODE-MODULES.txt)
Prints four lines: <0|1>, <sha256|->, <reason>, <path>.
The approved-launchers list is APPROVED-LAUNCHERS.txt next to the commit allowlist (same fixed directory)."""
import hashlib, os, pwd, re, stat, subprocess, sys

DEFAULT = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, 'rove-recovery-evidence', 'stage-a-runner', 'APPROVED-COMMITS.txt')

def check(head, wt, path, idre=r'([0-9a-f]{40})(\s|$)'):
    def out(ok, why, sha='-'): return f"{ok}\n{sha}\n{why}\n{path}"
    try: st = os.lstat(path)
    except OSError: return out(0, 'allowlist-missing')
    if not stat.S_ISREG(st.st_mode): return out(0, 'allowlist-not-regular')
    rp, wtr = os.path.realpath(path), os.path.realpath(wt)
    if rp == wtr or rp.startswith(wtr + os.sep): return out(0, 'allowlist-inside-repo')
    # R5-3: refuse if the file's real directory is inside ANY git worktree / repo / .git dir (e.g. ~/rove, ~/rove-wt/*).
    g = subprocess.run([os.environ.get('A3_GIT', 'git'), '-C', os.path.dirname(rp), 'rev-parse', '--git-dir'], capture_output=True, text=True,
                       env={**os.environ, 'GIT_CEILING_DIRECTORIES': ''})
    if g.returncode == 0: return out(0, 'allowlist-inside-git')
    if st.st_uid != os.getuid() or st.st_mode & 0o022: return out(0, 'allowlist-bad-owner-or-mode')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW); data = os.read(fd, 1 << 20); os.close(fd)
    sha = hashlib.sha256(data).hexdigest()
    if not re.fullmatch(idre[1:idre.index(')')], head): return out(0, 'no-head', sha)
    ids = {m.group(1) for l in data.decode('utf-8', 'replace').splitlines() if (m := re.match(idre, l))}
    return out(1, 'approved', sha) if head in ids else out(0, 'head-not-approved', sha)

LAUNCHER_FILES = ('a3-launch', 'check-approval.py', 'verify-snapshot.py')

def launcher_hash(d):
    """Manifest hash of an installed launcher dir: sha256 over "<sha256>  <name>\n" lines of its 3 files, sorted."""
    return hashlib.sha256(''.join(f"{hashlib.sha256(open(os.path.join(d, n), 'rb').read()).hexdigest()}  {n}\n" for n in sorted(LAUNCHER_FILES)).encode()).hexdigest()

def check_launcher(d):
    path = os.path.join(os.path.dirname(DEFAULT), 'APPROVED-LAUNCHERS.txt')
    def out(ok, why, sha='-'): return f"{ok}\n{sha}\n{why}\n{path}"
    try: st = os.lstat(d)
    except OSError: return out(0, 'launcher-missing')
    if not stat.S_ISDIR(st.st_mode): return out(0, 'launcher-not-dir')
    if sorted(os.listdir(d)) != sorted(LAUNCHER_FILES): return out(0, 'launcher-unexpected-files')
    for p in [d] + [os.path.join(d, n) for n in LAUNCHER_FILES]:
        s2 = os.lstat(p)
        if p != d and not stat.S_ISREG(s2.st_mode): return out(0, 'launcher-not-regular')
        if s2.st_uid != os.getuid() or s2.st_mode & 0o222: return out(0, 'launcher-writable-or-foreign')
    g = subprocess.run([os.environ.get('A3_GIT', 'git'), '-C', os.path.realpath(d), 'rev-parse', '--git-dir'], capture_output=True, text=True)
    if g.returncode == 0: return out(0, 'launcher-inside-git')
    sha = launcher_hash(d)
    ok, lsha, why, _ = check(sha, '/nonexistent', path, idre=r'([0-9a-f]{64})(\s|$)').split('\n')
    return out(int(ok), {'approved': 'launcher-approved', 'head-not-approved': 'launcher-not-approved'}.get(why, why), sha)

NM_EXCLUDE_TOP = ('.cache',)   # tool caches written at dev time (e.g. .cache/eve); never code that the runner loads

def _sha_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def nm_hash(root):
    """M3/NM: tree hash of node_modules. sha256 over the sorted lines "<f|l|o> <x|-> <sha256|link-target|->  <relpath>"
    for every entry (regular files hashed, symlinks recorded by target and never followed, anything else marked 'o').
    Only the top-level NM_EXCLUDE_TOP dirs are skipped."""
    root = os.path.realpath(root); lines = []
    for dp, dns, fns in os.walk(root, followlinks=False):
        rel = os.path.relpath(dp, root)
        if rel == '.': dns[:] = [d for d in dns if d not in NM_EXCLUDE_TOP]
        for n in fns + [d for d in dns if os.path.islink(os.path.join(dp, d))]:
            p = os.path.join(dp, n); r = os.path.normpath(os.path.join(rel, n)); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode): lines.append(f"l - {os.readlink(p)}  {r}\n")
            elif stat.S_ISREG(st.st_mode): lines.append(f"f {'x' if st.st_mode & 0o111 else '-'} {_sha_file(p)}  {r}\n")
            else: lines.append(f"o - -  {r}\n")
    return hashlib.sha256(''.join(sorted(lines)).encode()).hexdigest()

def check_nm(d):
    path = os.path.join(os.path.dirname(DEFAULT), 'APPROVED-NODE-MODULES.txt')
    def out(ok, why, sha='-'): return f"{ok}\n{sha}\n{why}\n{path}"
    if not os.path.isdir(d): return out(0, 'node-modules-missing')
    sha = nm_hash(d)
    ok, _, why, _ = check(sha, '/nonexistent', path, idre=r'([0-9a-f]{64})(\s|$)').split('\n')
    return out(int(ok), {'approved': 'node-modules-approved', 'head-not-approved': 'node-modules-not-approved'}.get(why, why), sha)

if __name__ == '__main__':
    if sys.argv[1] == '--launcher-dir': print(check_launcher(sys.argv[2])); sys.exit(0)
    if sys.argv[1] == '--node-modules': print(check_nm(sys.argv[2])); sys.exit(0)
    head, wt = sys.argv[1], sys.argv[2]
    path = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else DEFAULT
    print(check(head, wt, path))
