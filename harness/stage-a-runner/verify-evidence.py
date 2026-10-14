#!/usr/bin/env python3
"""Independent evidence verifier (t27u). Usage: verify-evidence.py <evidence-dir>
Checks, without trusting anything the browser could have touched:
 1. proxy/journal.chain re-derives from its seed, and every proxy/ file matches the journal exactly;
 2. MANIFEST.sealed (written by the supervisor AFTER every container has exited) lists sha256 of every file,
    no file is missing/extra/changed, and the seal line = sha256(manifest body + run nonce) matches.
Exit 0 = intact; 1 = tampered (reason printed)."""
import hashlib, os, signal, stat, sys
FILE_CAP = 64 << 20
signal.alarm(60)  # overall timeout: the verifier never blocks forever
H = lambda b: hashlib.sha256(b).hexdigest()

def journal(out):
    pd = os.path.join(out, 'proxy'); chain = H(b'stage-a-journal-v1'); expect = {}
    try: lines = read_regular(os.path.join(pd, 'journal.chain')).decode().splitlines()
    except FileNotFoundError: return 'journal-missing'
    for line in lines:
        f, mode, csha, ch = line.split('\t')
        chain = H(f'{chain}\t{f}\t{mode}\t{csha}'.encode())
        if chain != ch: return 'chain-break'
        if mode == 'append': expect.setdefault(f, ('append', []))[1].append(csha)
        else: expect[f] = ('replace', [csha])
    for f, (mode, parts) in expect.items():
        try: data = read_regular(os.path.join(pd, f))
        except FileNotFoundError: return f'missing:{f}'
        except NonRegular: return f'non-regular:proxy/{f}'
        if mode == 'replace': good = H(data) == parts[0]
        else:
            ls = data.decode().splitlines(keepends=True)
            good = len(ls) == len(parts) and all(H(l.encode()) == s for l, s in zip(ls, parts))
        if not good: return f'mismatch:{f}'
    extra = set(os.listdir(pd)) - set(expect) - {'journal.chain', 'proxy-probe.json'}
    return 'unjournaled:' + ','.join(sorted(extra)) if extra else ''

class NonRegular(Exception): pass

def read_regular(path):
    """Read a regular file without following symlinks or blocking on FIFOs; size-capped."""
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode): raise NonRegular(path)
    if st.st_size > FILE_CAP: raise NonRegular(path + ' (size-cap)')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise NonRegular(path)
        chunks, n = [], 0
        while True:
            b = os.read(fd, 1 << 20)
            if not b: break
            n += len(b)
            if n > FILE_CAP: raise NonRegular(path + ' (size-cap)')
            chunks.append(b)
        return b''.join(chunks)
    finally: os.close(fd)

def walk(out):
    for root, dirs, files in os.walk(out, followlinks=False):
        for n in files + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
            rel = os.path.relpath(os.path.join(root, n), out)
            if rel != 'MANIFEST.sealed': yield rel

def seal(out, nonce):
    body = ''.join(f'{H(read_regular(os.path.join(out, r)))}  {r}\n' for r in sorted(walk(out)))
    return body + f'SEAL {H((body + nonce).encode())}\n'

def verify(out):
    for r in walk(out):
        if not stat.S_ISREG(os.lstat(os.path.join(out, r)).st_mode): return f'non-regular:{r}'
    why = journal(out)
    if why: return why
    try: text = read_regular(os.path.join(out, 'MANIFEST.sealed')).decode()
    except FileNotFoundError: return 'manifest-missing'
    body, _, last = text.rstrip('\n').rpartition('\n')
    nonce = read_regular(os.path.join(out, 'supervisor.nonce')).decode().strip() if os.path.exists(os.path.join(out, 'supervisor.nonce')) else ''
    if not last.startswith('SEAL ') or last[5:] != H((body + '\n' + nonce).encode()): return 'seal-mismatch'
    listed = {}
    for l in body.splitlines():
        s, _, r = l.partition('  '); listed[r] = s
    actual = set(walk(out))
    if actual != set(listed): return 'file-set-changed:' + ','.join(sorted(actual ^ set(listed)))
    for r, s in listed.items():
        if H(read_regular(os.path.join(out, r))) != s: return f'changed:{r}'
    return ''

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--seal':
        out, nonce = sys.argv[2], sys.argv[3]
        try: text = seal(out, nonce)
        except Exception as e: print(f'seal-failed: {type(e).__name__}: {e}'); sys.exit(2)
        mp = os.path.join(out, 'MANIFEST.sealed')
        if os.path.lexists(mp): os.chmod(mp, 0o600); os.unlink(mp)
        fd = os.open(mp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        os.write(fd, text.encode()); os.close(fd); sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--journal':
        r = journal(sys.argv[2]); print(r or 'ok'); sys.exit(1 if r else 0)
    try: r = verify(sys.argv[1])
    except Exception as e: r = f'verify-error: {type(e).__name__}'
    print(r or 'intact'); sys.exit(1 if r else 0)
