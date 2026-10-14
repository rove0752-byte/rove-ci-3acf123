#!/usr/bin/env python3
"""Independent evidence verifier (t27u). Usage: verify-evidence.py <evidence-dir>
Checks, without trusting anything the browser could have touched:
 1. proxy/journal.chain re-derives from its seed, and every proxy/ file matches the journal exactly;
 2. MANIFEST.sealed (written by the supervisor AFTER every container has exited) lists sha256 of every file,
    no file is missing/extra/changed, and the seal line = sha256(manifest body + run nonce) matches.
Exit 0 = intact; 1 = tampered (reason printed)."""
import hashlib, os, sys
H = lambda b: hashlib.sha256(b).hexdigest()

def journal(out):
    pd = os.path.join(out, 'proxy'); chain = H(b'stage-a-journal-v1'); expect = {}
    try: lines = open(os.path.join(pd, 'journal.chain'), 'rb').read().decode().splitlines()
    except FileNotFoundError: return 'journal-missing'
    for line in lines:
        f, mode, csha, ch = line.split('\t')
        chain = H(f'{chain}\t{f}\t{mode}\t{csha}'.encode())
        if chain != ch: return 'chain-break'
        if mode == 'append': expect.setdefault(f, ('append', []))[1].append(csha)
        else: expect[f] = ('replace', [csha])
    for f, (mode, parts) in expect.items():
        try: data = open(os.path.join(pd, f), 'rb').read()
        except FileNotFoundError: return f'missing:{f}'
        if mode == 'replace': good = H(data) == parts[0]
        else:
            ls = data.decode().splitlines(keepends=True)
            good = len(ls) == len(parts) and all(H(l.encode()) == s for l, s in zip(ls, parts))
        if not good: return f'mismatch:{f}'
    extra = set(os.listdir(pd)) - set(expect) - {'journal.chain', 'proxy-probe.json'}
    return 'unjournaled:' + ','.join(sorted(extra)) if extra else ''

def walk(out):
    for root, _, files in os.walk(out):
        for n in files:
            rel = os.path.relpath(os.path.join(root, n), out)
            if rel != 'MANIFEST.sealed': yield rel

def seal(out, nonce):
    body = ''.join(f'{H(open(os.path.join(out, r), "rb").read())}  {r}\n' for r in sorted(walk(out)))
    return body + f'SEAL {H((body + nonce).encode())}\n'

def verify(out):
    why = journal(out)
    if why: return why
    try: text = open(os.path.join(out, 'MANIFEST.sealed')).read()
    except FileNotFoundError: return 'manifest-missing'
    body, _, last = text.rstrip('\n').rpartition('\n')
    nonce = open(os.path.join(out, 'supervisor.nonce')).read().strip() if os.path.exists(os.path.join(out, 'supervisor.nonce')) else ''
    if not last.startswith('SEAL ') or last[5:] != H((body + '\n' + nonce).encode()): return 'seal-mismatch'
    listed = {}
    for l in body.splitlines():
        s, _, r = l.partition('  '); listed[r] = s
    actual = set(walk(out))
    if actual != set(listed): return 'file-set-changed:' + ','.join(sorted(actual ^ set(listed)))
    for r, s in listed.items():
        if H(open(os.path.join(out, r), 'rb').read()) != s: return f'changed:{r}'
    return ''

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--seal':
        out, nonce = sys.argv[2], sys.argv[3]
        fd = os.open(os.path.join(out, 'MANIFEST.sealed'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
        os.write(fd, seal(out, nonce).encode()); os.close(fd); sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--journal':
        r = journal(sys.argv[2]); print(r or 'ok'); sys.exit(1 if r else 0)
    r = verify(sys.argv[1]); print(r or 'intact'); sys.exit(1 if r else 0)
