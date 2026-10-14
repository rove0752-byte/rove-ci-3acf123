#!/usr/bin/env python3
"""R6-1/R7-1: verify an extracted snapshot byte-for-byte against a commit, without trusting git's object lookup.
usage: verify-snapshot.py <repo> <commit-id> <snapshot-dir>  -> "ok <n-files>" (exit 0) or "mismatch <reason> <path>" (exit 1)
- git runs with --no-replace-objects (replace refs are ignored) and only as a raw object reader (cat-file --batch);
- the commit object and every tree object are re-hashed here ("<type> <len>\\0<bytes>") and must equal their ids, so a
  substituted/corrupted object file, a replace ref or a graft cannot change what is verified under the approved id;
- every blob is compared by recomputing its id from the snapshot file's bytes (filters / export-subst / export-ignore
  applied by `git archive` therefore show up as content mismatch, missing or extra files)."""
import hashlib, os, stat, subprocess, sys

repo, commit, snap = sys.argv[1:4]
GIT = os.environ.get('A3_GIT', 'git')
def fail(why, p): print(f"mismatch {why} {p}"); sys.exit(1)
fmt = subprocess.run([GIT, '--no-replace-objects', '-C', repo, 'rev-parse', '--show-object-format'], capture_output=True, text=True).stdout.strip() or 'sha1'
H, HL = (hashlib.sha256, 32) if fmt == 'sha256' else (hashlib.sha1, 20)
cat = subprocess.Popen([GIT, '--no-replace-objects', '-C', repo, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def obj(oid, want):
    cat.stdin.write(oid.encode() + b'\n'); cat.stdin.flush()
    hdr = cat.stdout.readline().split()
    if len(hdr) != 3 or hdr[1].decode() != want: fail(f'object-{want}', oid)
    data = cat.stdout.read(int(hdr[2])); cat.stdout.read(1)
    if H(want.encode() + b' %d\0' % len(data) + data).hexdigest() != oid: fail(f'{want}-hash', oid)   # independent re-hash
    return data
c = obj(commit, 'commit')
if not c.startswith(b'tree '): fail('commit-format', commit)
want = {}
def walk(tree, prefix):
    data, i = obj(tree, 'tree'), 0
    while i < len(data):
        sp = data.index(b' ', i); nul = data.index(b'\0', sp)
        mode, name = data[i:sp].decode(), os.fsdecode(data[sp + 1:nul]); oid = data[nul + 1:nul + 1 + HL].hex(); i = nul + 1 + HL
        path = prefix + name
        if mode == '40000': walk(oid, path + '/')
        else: want[path] = (mode, oid)
walk(c[5:5 + 2 * HL].decode(), '')
seen = set()
for root, dirs, files in os.walk(snap):
    for n in files + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
        seen.add(os.path.relpath(os.path.join(root, n), snap))
for path, (mode, oid) in want.items():
    p = os.path.join(snap, path)
    if mode == '160000':   # submodule: git archive emits no content
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
