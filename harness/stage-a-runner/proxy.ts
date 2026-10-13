// Allow-list egress proxy with a controlled DNS stub, pinning, rebinding defence, per-host rate limit,
// robots.txt enforcement, per-request and DNS logs. Any policy violation writes VIOLATION and exits non-zero,
// which the supervisor (run.sh) treats as an auto-terminate signal for the whole run.
import { createServer, request } from 'node:http';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { publicAddress } from '/app/agent/lib/public-address.ts';

const OUT = process.env.OUT ?? '/evidence';
const cfg = JSON.parse(readFileSync('/cfg/policy.json', 'utf8')) as {
  allow: string[]; rate: { perSecond: number; burst: number }; dns: Record<string, string[]>; route: Record<string, string>;
};
const now = () => new Date().toISOString();
const log = (file: string, rec: object) => appendFileSync(`${OUT}/${file}`, JSON.stringify({ t: now(), ...rec }) + '\n', { mode: 0o600 });
let dead = false;
function violation(kind: string, detail: object) {
  if (dead) return; dead = true;
  writeFileSync(`${OUT}/VIOLATION`, JSON.stringify({ t: now(), kind, ...detail }) + '\n', { mode: 0o600 });
  log('requests.jsonl', { violation: kind, ...detail });
  setTimeout(() => process.exit(3), 50);
}

// Controlled DNS stub: answers come from policy; each lookup consumes the next answer set (so rebinding can be simulated).
const answerIdx: Record<string, number> = {};
function stubResolve(host: string): string[] {
  const seq = cfg.dns[host]; if (!seq) return [];
  const i = answerIdx[host] ?? 0; answerIdx[host] = i + 1;
  const ans = seq[Math.min(i, seq.length - 1)].split(',');
  log('dns.jsonl', { host, lookup: i + 1, answers: ans });
  return ans;
}
const pins = new Map<string, string>();
function pinned(host: string): string | null {
  const have = pins.get(host); if (have) return have;
  const ans = stubResolve(host);
  if (ans.length === 0) return null;
  if (!ans.every(publicAddress)) { violation('private-ip', { host, answers: ans }); return null; }
  pins.set(host, ans[0]); return ans[0];
}

const buckets = new Map<string, { tokens: number; at: number }>();
function rateOk(host: string): boolean {
  const b = buckets.get(host) ?? { tokens: cfg.rate.burst, at: Date.now() };
  b.tokens = Math.min(cfg.rate.burst, b.tokens + (Date.now() - b.at) / 1000 * cfg.rate.perSecond); b.at = Date.now();
  buckets.set(host, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}

function upstream(ip: string, host: string, path: string): Promise<{ status: number; body: Buffer; headers: Record<string, any>; peer: string }> {
  const target = cfg.route[ip]; // simulated internet: virtual public IP -> fixture container on the upstream network
  return new Promise((resolve, reject) => {
    const r = request({ host: target, port: 80, path, method: 'GET', headers: { host, 'user-agent': 'RoveStageA/0.1' }, timeout: 10_000 }, res => {
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 5_000_000) r.destroy(new Error('body cap')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers, peer: ip }));
    });
    r.on('socket', s => s.on('connect', () => { if (s.remoteAddress !== target) r.destroy(new Error('peer mismatch')); }));
    r.on('timeout', () => r.destroy(new Error('upstream timeout'))); r.on('error', reject); r.end();
  });
}

const robots = new Map<string, string[]>();
async function robotsDisallow(host: string, ip: string): Promise<string[]> {
  if (robots.has(host)) return robots.get(host)!;
  let rules: string[] = [];
  try {
    const r = await upstream(ip, host, '/robots.txt');
    log('requests.jsonl', { host, ip, path: '/robots.txt', status: r.status, bytes: r.body.length, robots: true });
    if (r.status === 200) {
      let applies = false;
      for (const raw of r.body.toString('utf8').split('\n')) {
        const [k, ...v] = raw.split(':'); const key = k.trim().toLowerCase(); const val = v.join(':').trim();
        if (key === 'user-agent') applies = val === '*' || /rove/i.test(val);
        else if (key === 'disallow' && applies && val) rules.push(val);
      }
    }
  } catch { rules = ['/']; } // unreadable robots -> fail closed
  robots.set(host, rules); return rules;
}

createServer(async (req, res) => {
  const t0 = Date.now();
  if (dead) { res.writeHead(503); return res.end(); }
  let url: URL;
  try { url = new URL(req.url!); } catch { res.writeHead(400); return res.end(); }
  const host = url.hostname;
  const deny = (code: number, why: string) => { log('requests.jsonl', { host, path: url.pathname, status: code, bytes: 0, ms: Date.now() - t0, denied: why }); res.writeHead(code); res.end(); };
  if (req.method !== 'GET' || url.protocol !== 'http:') { violation('method-or-scheme', { host, method: req.method }); return deny(405, 'method'); }
  if (!cfg.allow.includes(host)) { violation('off-list-host', { host, path: url.pathname }); return deny(403, 'off-list'); }
  const ip = pinned(host); if (!ip) return deny(502, 'dns');
  if (!rateOk(host)) { violation('rate-exceeded', { host }); return deny(429, 'rate'); }
  const dis = await robotsDisallow(host, ip);
  if (dis.some(p => url.pathname.startsWith(p))) { violation('robots-disallow', { host, path: url.pathname }); return deny(403, 'robots'); }
  try {
    const r = await upstream(ip, host, url.pathname + url.search);
    log('requests.jsonl', { host, ip, path: url.pathname, status: r.status, bytes: r.body.length, ms: Date.now() - t0 });
    res.writeHead(r.status, { 'content-type': r.headers['content-type'] ?? 'application/octet-stream' }); res.end(r.body);
  } catch (e) { deny(502, (e as Error).message); }
}).listen(8080, () => console.log('proxy listening'));
