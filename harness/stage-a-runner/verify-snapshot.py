#!/usr/bin/env python3
"""R6-1: verify an extracted snapshot byte-for-byte against the commit's tree, independent of git filters/attributes.
usage: verify-snapshot.py <repo> <commit> <snapshot-dir>   -> prints "ok <n-files>" (exit 0) or "mismatch <reason> <path>" (exit 1)
Blob ids are recomputed in Python ("blob <len>\\0<bytes>"), so smudge filters, export-subst, eol conversion or
export-ignore applied by `git archive` all show up as a mismatch, a missing file or an extra file."""
import hashlib, os, stat, subprocess, sys

repo, commit, snap = sys.argv[1:4]
def git(*a): return subprocess.run(['git', '-C', repo, *a], capture_output=True, check=True).stdout
fmt = git('rev-parse', '--show-object-format').decode().strip() or 'sha1'
H = hashlib.sha256 if fmt == 'sha256' else hashlib.sha1
def fail(why, p): print(f"mismatch {why} {p}"); sys.exit(1)
want = {}
for ent in git('ls-tree', '-r', '-z', '--full-tree', commit).split(b'\0'):
    if not ent: continue
    meta, path = ent.split(b'\t', 1); mode, typ, oid = meta.split(b' ')
    want[os.fsdecode(path)] = (mode.decode(), typ.decode(), oid.decode())
seen = set()
for root, dirs, files in os.walk(snap):
    for n in files + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
        seen.add(os.path.relpath(os.path.join(root, n), snap))
for path, (mode, typ, oid) in want.items():
    p = os.path.join(snap, path)
    if typ == 'commit':   # submodule: git archive emits no content
        if os.path.lexists(p) and not (os.path.isdir(p) and not os.listdir(p)): fail('submodule-content', path)
        continue
    try: st = os.lstat(p)
    except OSError: fail('missing', path)
    if mode == '120000':
        if not stat.S_ISLNK(st.st_mode): fail('type', path)
        data = os.fsencode(os.readlink(p))
    else:
        if not stat.S_ISREG(st.st_mode): fail('type', path)
        if (mode == '100755') != bool(st.st_mode & 0o100): fail('mode', path)
        with open(p, 'rb') as f: data = f.read()
    if H(b'blob %d\0' % len(data) + data).hexdigest() != oid: fail('content', path)
    seen.discard(path)
if seen: fail('extra', sorted(seen)[0])
print(f"ok {len(want)}")
