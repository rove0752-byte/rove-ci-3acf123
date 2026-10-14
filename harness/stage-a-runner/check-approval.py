#!/usr/bin/env python3
"""Stage A production approval check (R4-2, R5-2, R5-3). Trusted, host-side only; no container mounts this.
usage: check-approval.py <head-commit> <worktree> [override-path]
The override is passed by run.sh ONLY in test mode (R5-2); in production the allowlist is always the fixed default
<passwd home>/rove-recovery-evidence/stage-a-runner/APPROVED-COMMITS.txt ($HOME is not trusted for this).
Prints four lines: <0|1>, <sha256|->, <reason>, <path>."""
import hashlib, os, pwd, re, stat, subprocess, sys

DEFAULT = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, 'rove-recovery-evidence', 'stage-a-runner', 'APPROVED-COMMITS.txt')

def check(head, wt, path):
    def out(ok, why, sha='-'): return f"{ok}\n{sha}\n{why}\n{path}"
    try: st = os.lstat(path)
    except OSError: return out(0, 'allowlist-missing')
    if not stat.S_ISREG(st.st_mode): return out(0, 'allowlist-not-regular')
    rp, wtr = os.path.realpath(path), os.path.realpath(wt)
    if rp == wtr or rp.startswith(wtr + os.sep): return out(0, 'allowlist-inside-repo')
    # R5-3: refuse if the file's real directory is inside ANY git worktree / repo / .git dir (e.g. ~/rove, ~/rove-wt/*).
    g = subprocess.run(['git', '-C', os.path.dirname(rp), 'rev-parse', '--git-dir'], capture_output=True, text=True,
                       env={**os.environ, 'GIT_CEILING_DIRECTORIES': ''})
    if g.returncode == 0: return out(0, 'allowlist-inside-git')
    if st.st_uid != os.getuid() or st.st_mode & 0o022: return out(0, 'allowlist-bad-owner-or-mode')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW); data = os.read(fd, 1 << 20); os.close(fd)
    sha = hashlib.sha256(data).hexdigest()
    if not re.fullmatch(r'[0-9a-f]{40}', head): return out(0, 'no-head', sha)
    ids = {m.group(1) for l in data.decode('utf-8', 'replace').splitlines() if (m := re.match(r'([0-9a-f]{40})(\s|$)', l))}
    return out(1, 'approved', sha) if head in ids else out(0, 'head-not-approved', sha)

if __name__ == '__main__':
    head, wt = sys.argv[1], sys.argv[2]
    path = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else DEFAULT
    print(check(head, wt, path))
