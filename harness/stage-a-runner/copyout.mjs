// Trusted copier (runs in its own --network none container AFTER the browser has exited).
// Copies only regular files from the browser's capped tmpfs scratch volume (/s, read-only) to /out.
// lstat + O_NOFOLLOW|O_NONBLOCK; FIFOs, sockets, devices and symlinks are refused (never followed) and reported.
// Caps: 8 MiB per file, 64 MiB total, 256 entries, depth 4. Report on stdout as JSON.
import { lstatSync, readdirSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, constants as C } from 'node:fs';
import { join, relative } from 'node:path';
const SRC = '/s', OUT = '/out', FILE_CAP = 8 << 20, TOTAL_CAP = 64 << 20, MAX_ENTRIES = 256;
const report = { copied: [], refused: [] }; let total = 0, entries = 0;
const kind = st => st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isBlockDevice() || st.isCharacterDevice() ? 'device' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
function walk(dir, depth) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = relative(SRC, p);
    if (++entries > MAX_ENTRIES) { report.refused.push({ path: rel, reason: 'too-many-entries' }); return; }
    // R4-1: names outside [A-Za-z0-9._-]{1,128} (control chars, newlines, spaces, unicode) are refused, never copied.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..') { report.refused.push({ path: JSON.stringify(rel).slice(1, -1).slice(0, 200), reason: 'bad-name' }); continue; }
    const st = lstatSync(p); const k = kind(st);
    if (k === 'dir') { if (depth >= 4) report.refused.push({ path: rel, reason: 'too-deep' }); else { mkdirSync(join(OUT, rel), { mode: 0o700, recursive: true }); walk(p, depth + 1); } continue; }
    if (k !== 'file') { report.refused.push({ path: rel, reason: k }); continue; }
    if (st.size > FILE_CAP || total + st.size > TOTAL_CAP) { report.refused.push({ path: rel, reason: 'size-cap', size: st.size }); continue; }
    const fd = openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const buf = Buffer.alloc(Math.min(st.size, FILE_CAP) + 1); const n = readSync(fd, buf, 0, buf.length, 0);
      if (n > FILE_CAP) { report.refused.push({ path: rel, reason: 'size-cap' }); continue; }
      writeFileSync(join(OUT, rel), buf.subarray(0, n), { mode: 0o600, flag: 'wx' }); total += n; report.copied.push({ path: rel, bytes: n });
    } finally { closeSync(fd); }
  }
}
walk(SRC, 0);
process.stdout.write(JSON.stringify(report));
