// Allow-list egress proxy (listens ONLY on a unix socket shared with the browser container, which has no network).
// Controlled DNS stub + pinning, robots (decoded/normalised), per-host rate limit with queueing, redirect policing,
// and the cross-origin policy (review t25): A-class = block and log, B-class = terminate (VIOLATION + exit).
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicAddress } from '/app/agent/lib/public-address.ts';
import { robotsFromBytes, disallowed, normalisePath, type Rule, type Robots } from '/app/harness/stage-a-runner/robots.ts';

const OUT = process.env.OUT ?? '/evidence';
const SOCK = process.env.SOCK ?? '/sock/proxy.sock';
const UA = 'RoveStageA/0.1';
const cfg = JSON.parse(readFileSync('/cfg/policy.json', 'utf8'));
const co = cfg.crossOrigin;
const topLevel = new Set((process.env.TOPLEVEL ?? '').split(' ').filter(Boolean).map(u => { try { return new URL(u).href; } catch { return u; } }));
const now = () => new Date().toISOString();
// Append-only, hash-chained journal (N1): every evidence write is recorded as file, sha256(content), chain hash.
// The supervisor re-derives the chain and each file's contents before it writes summary.json / SHA256SUMS.
let chain = createHash('sha256').update('stage-a-journal-v1').digest('hex');
const sha = (b: string) => createHash('sha256').update(b).digest('hex');
function journal(file: string, mode: 'append' | 'replace', content: string) {
  chain = sha(chain + '\t' + file + '\t' + mode + '\t' + sha(content));
  appendFileSync(`${OUT}/journal.chain`, `${file}\t${mode}\t${sha(content)}\t${chain}\n`, { mode: 0o600 });
}
const log = (file: string, rec: object) => { const line = JSON.stringify({ t: now(), ...rec }) + '\n'; appendFileSync(`${OUT}/${file}`, line, { mode: 0o600 }); journal(file, 'append', line); };
const put = (file: string, content: string) => { writeFileSync(`${OUT}/${file}`, content, { mode: 0o600 }); journal(file, 'replace', content); };
const counts: Record<string, number> = {};
let aTotal = 0, dead = false, robotsTopStreak = 0, bodyCaps = 0;
const offListSeen = new Map<string, number[]>();
const summary = () => put('policy-summary.json', JSON.stringify({ blocks: counts, aTotal, terminated: dead }) + '\n');

type Ctx = { host: string; path_raw: string; path_norm?: string; dest: 'top-level' | 'subresource' };
function terminate(rule: string, c: Partial<Ctx>, extra: object = {}) {
  if (dead) return; dead = true;
  counts[rule] = (counts[rule] ?? 0) + 1;
  const rec = { ...c, class: 'B', rule, count: counts[rule], ...extra };
  log('decisions.jsonl', rec);
  put('VIOLATION', JSON.stringify({ t: now(), kind: rule, ...rec }) + '\n');
  summary();
  setTimeout(() => process.exit(3), 50);
}
function block(rule: string, c: Ctx, res: ServerResponse | null, code: number) {
  counts[rule] = (counts[rule] ?? 0) + 1; aTotal++;
  log('decisions.jsonl', { ...c, class: 'A', rule, count: counts[rule] });
  log('requests.jsonl', { host: c.host, path: c.path_raw, status: code, bytes: 0, denied: rule });
  summary();
  if (res) { res.writeHead(code); res.end(); }
  if (aTotal > co.aClassMax) terminate('a-class-threshold', c, { aTotal });
}

// Controlled DNS stub; each lookup consumes the next answer set (to simulate rebinding).
const answerIdx: Record<string, number> = {};
const pins = new Map<string, string>();
function pinned(c: Ctx): string | null {
  const have = pins.get(c.host); if (have) return have;
  const seq = cfg.dns[c.host]; if (!seq) return null;
  const i = answerIdx[c.host] ?? 0; answerIdx[c.host] = i + 1;
  const ans: string[] = seq[Math.min(i, seq.length - 1)].split(',');
  log('dns.jsonl', { host: c.host, lookup: i + 1, answers: ans });
  if (!ans.every(publicAddress)) { terminate('private-ip', c, { answers: ans }); return null; }
  pins.set(c.host, ans[0]); return ans[0];
}

// Token bucket with a bounded queue: wait up to queueMs, queue at most 2*burst per host; otherwise 429 (A-class).
const buckets = new Map<string, { tokens: number; at: number; waiting: number }>();
async function takeToken(host: string): Promise<boolean> {
  const b = buckets.get(host) ?? { tokens: cfg.rate.burst, at: Date.now(), waiting: 0 }; buckets.set(host, b);
  const refill = () => { b.tokens = Math.min(cfg.rate.burst, b.tokens + (Date.now() - b.at) / 1000 * cfg.rate.perSecond); b.at = Date.now(); };
  refill(); if (b.tokens >= 1) { b.tokens -= 1; return true; }
  if (b.waiting >= 2 * cfg.rate.burst) return false;
  b.waiting++; const until = Date.now() + cfg.rate.queueMs;
  try {
    while (Date.now() < until && !dead) { await new Promise(r => setTimeout(r, 100)); refill(); if (b.tokens >= 1) { b.tokens -= 1; return true; } }
    return false;
  } finally { b.waiting--; }
}

const SAFE_HEADERS = ['content-type', 'cache-control', 'content-language', 'last-modified', 'etag'];
function upstream(ip: string, host: string, path: string): Promise<{ status: number; body: Buffer; headers: IncomingMessage['headers'] }> {
  const [target, port] = String(cfg.route[ip]).split(':'); // simulated internet: virtual public IP -> fixture (loopback in the proxy's netns)
  return new Promise((resolve, reject) => {
    const r = request({ host: target, port: Number(port ?? 80), path, method: 'GET', headers: { host, 'user-agent': UA }, timeout: 10_000 }, res => {
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', ch => { n += ch.length; if (n > co.bodyCapBytes) r.destroy(new Error('body-cap')); else chunks.push(ch); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    r.on('socket', s => s.on('connect', () => { if (s.remoteAddress !== target) r.destroy(new Error('peer mismatch')); }));
    r.on('timeout', () => r.destroy(new Error('upstream timeout'))); r.on('error', reject); r.end();
  });
}

const robots = new Map<string, Rule[]>();
async function robotsFor(host: string, ip: string): Promise<Rule[]> {
  if (robots.has(host)) return robots.get(host)!;
  let parsed: Robots;
  try {
    const r = await upstream(ip, host, '/robots.txt');
    log('requests.jsonl', { host, ip, path: '/robots.txt', status: r.status, bytes: r.body.length, robots: true });
    parsed = r.status === 200 ? robotsFromBytes(r.body, UA) : r.status >= 400 && r.status < 500 ? { rules: [] } : { rules: [{ allow: false, pattern: '/' }], error: `status-${r.status}` };
  } catch (e) { parsed = { rules: [{ allow: false, pattern: '/' }], error: (e as Error).message === 'body-cap' ? 'body-too-large' : 'unreadable' }; }
  if (parsed.error) log('decisions.jsonl', { host, path_raw: '/robots.txt', dest: 'robots', class: 'info', rule: 'robots-fail-closed', reason: parsed.error });
  robots.set(host, parsed.rules); return parsed.rules;
}
const redirectHops = new Map<string, number>();

const canonHost = (h: string) => h.toLowerCase().replace(/\.$/, '');
const isIpLiteral = (h: string) => isIP(h.replace(/^\[|\]$/g, '')) !== 0;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const t0 = Date.now();
  if (dead) { res.writeHead(503); return res.end(); }
  const target = req.url ?? '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) { log('requests.jsonl', { path: target.slice(0, 200), status: 400, bytes: 0, denied: 'origin-form' }); terminate('origin-form', { path_raw: target.slice(0, 200) }); res.writeHead(400); return res.end(); }
  let url: URL;
  try { url = new URL(target); } catch { terminate('bad-url', { path_raw: target.slice(0, 200) }); res.writeHead(400); return res.end(); }
  const rawAuthority = target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  const host = canonHost(url.hostname);
  if (rawAuthority.includes('%')) return terminate('encoded-host', { host: rawAuthority.slice(0, 100), path_raw: '' }), void res.writeHead(400).end();
  if (url.port !== '') return terminate('port', { host, path_raw: '' }, { port: url.port }), void res.writeHead(403).end();
  if (!req.headers.host) return block('malformed-request', { host, path_raw: '', dest: 'subresource' }, res, 400);
  const rawPath = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/[?#].*$/, '') || '/';
  const isTop = topLevel.has(url.href) || /^text\/html/.test(String(req.headers.accept ?? ''));
  const c: Ctx = { host, path_raw: rawPath, dest: isTop ? 'top-level' : 'subresource' };
  if (url.username || url.password) return terminate('userinfo', c), void res.writeHead(400).end();
  if (isIpLiteral(url.hostname)) return terminate('ip-literal', c), void res.writeHead(403).end();
  if (url.protocol !== 'http:') return terminate('scheme', c), void res.writeHead(403).end();
  const hdrHost = canonHost(String(req.headers.host ?? '').replace(/:\d+$/, ''));
  if (hdrHost && hdrHost !== host) return terminate('host-header-mismatch', c, { header: hdrHost.slice(0, 100) }), void res.writeHead(400).end();
  if (!cfg.allow.includes(host)) {
    if (isTop || co.offListSubresource !== 'block') return terminate('off-list-host', c), void res.writeHead(403).end();
    const w = (offListSeen.get(host) ?? []).filter(t => t > Date.now() - co.sameOffListWindowMs); w.push(Date.now()); offListSeen.set(host, w);
    block('off-list-subresource', c, res, 403);
    if (w.length > co.sameOffListHostMax) terminate('off-list-repeat', c, { attempts: w.length });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return isTop ? (terminate('method', c, { method: req.method }), void res.writeHead(405).end()) : block('method', c, res, 405);
  const n = normalisePath(rawPath);
  if ('bypass' in n) return terminate('encoded-path-' + n.bypass, c), void res.writeHead(403).end();
  c.path_norm = n.path;
  if (n.encodedSlash) {
    const mode = co.encodedSlash ?? 'block';
    if (mode === 'terminate') return terminate('encoded-slash', c), void res.writeHead(403).end();
    if (mode !== 'allow') return block('encoded-slash', c, res, 403);
  }
  const ip = pinned(c); if (!ip) { if (!dead) block('dns-nxdomain', c, res, 502); else { res.writeHead(403); res.end(); } return; }
  if (!(await takeToken(host))) return block('rate', c, res, 429);
  const rules = await robotsFor(host, ip);
  const decodedHit = disallowed(rules, n.path), rawHit = disallowed(rules, rawPath);
  if (decodedHit === 'budget' || rawHit === 'budget') return block('robots-match-budget', c, res, 403); // fail closed
  if (decodedHit && !rawHit) return terminate('encoded-path-robots-bypass', c), void res.writeHead(403).end();
  if (decodedHit) {
    if (isTop && ++robotsTopStreak >= co.topLevelRobotsConsecutive) { counts['robots'] = (counts['robots'] ?? 0) + 1; return terminate('robots-top-level-repeat', c), void res.writeHead(403).end(); }
    return block('robots', c, res, 403);
  }
  if (isTop) robotsTopStreak = 0;
  try {
    const r = await upstream(ip, host, url.pathname + url.search);
    const headers: Record<string, string> = {};
    for (const h of SAFE_HEADERS) if (r.headers[h]) headers[h] = String(r.headers[h]);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      let loc: URL; try { loc = new URL(String(r.headers.location), url); } catch { return block('redirect-bad-location', c, res, 502); }
      const lh = canonHost(loc.hostname);
      const hops = (redirectHops.get(url.href) ?? 0) + 1;
      if (hops > (co.maxRedirects ?? 10)) return block('redirect-loop', c, res, 508);
      redirectHops.set(loc.href, Math.max(redirectHops.get(loc.href) ?? 0, hops));
      const ok = loc.protocol === 'http:' && !isIpLiteral(loc.hostname) && !loc.username && !loc.password && loc.port === '' && cfg.allow.includes(lh);
      log('decisions.jsonl', { ...c, class: ok ? 'ok' : isTop ? 'B' : 'A', rule: 'redirect', location: loc.href.slice(0, 300) });
      if (!ok) return isTop ? (terminate('redirect-off-list', c, { location: loc.href.slice(0, 300) }), void res.writeHead(403).end()) : block('redirect-off-list', c, res, 403);
      if (isTop) topLevel.add(loc.href);
      headers.location = loc.href;
    }
    log('requests.jsonl', { host, ip, path: url.pathname, status: r.status, bytes: r.body.length, ms: Date.now() - t0, dest: c.dest });
    res.writeHead(r.status, headers); res.end(req.method === 'HEAD' ? undefined : r.body);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'body-cap' && ++bodyCaps > co.bodyCapOccasions) return terminate('body-cap-repeat', c), void res.writeHead(502).end();
    block(msg === 'body-cap' ? 'body-cap' : 'upstream-error', c, res, 502);
  }
}

const server = createServer((req, res) => { handle(req, res).catch(e => { try { res.writeHead(500); res.end(); } catch {} ; log('requests.jsonl', { error: String(e).slice(0, 200) }); }); });
server.on('connect', (req, socket) => { terminate('connect-tunnel', { host: String(req.url).slice(0, 200), path_raw: '' }); log('requests.jsonl', { connect: String(req.url).slice(0, 200), status: 405, denied: 'connect-tunnel' }); socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); });
server.on('clientError', (e, socket) => { if (!dead) block('malformed-request', { host: '', path_raw: '', dest: 'subresource' }, null, 400); log('requests.jsonl', { status: 400, denied: 'malformed-request', code: (e as any).code }); socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
try { rmSync(SOCK, { force: true }); } catch {}
summary();
server.listen(SOCK, () => console.log('proxy listening on unix socket'));
