// robots.txt (RFC 9309) — linear-time, fail-closed.
// - Lines split on CRLF, CR or LF. Groups: consecutive user-agent lines; the group whose product token equals ours
//   (case-insensitive, exact token) wins, else '*'. Allow/Disallow longest match; Allow wins ties; '*' and '$'.
// - Patterns are percent-decoded with the same normalisation as request paths.
// - Caps: body 500 KB, 1000 rules, 512 chars/pattern, 2048 chars/path, and a per-match step budget. Any parse
//   error or cap breach = disallow-all for that host, with the reason returned for logging.
export type Rule = { allow: boolean; pattern: string };
export type Robots = { rules: Rule[]; error?: string };
export const LIMITS = { bodyBytes: 500_000, rules: 1000, patternChars: 512, pathChars: 2048, matchSteps: 200_000 };
const DENY_ALL = (error: string): Robots => ({ rules: [{ allow: false, pattern: '/' }], error });

// Bytes -> rules. Ambiguous/unsupported input fails closed (t27u): invalid UTF-8, NUL bytes, or a body that looks
// like HTML instead of robots.txt. A UTF-8 BOM is stripped.
export function robotsFromBytes(body: Buffer, agent: string): Robots {
  if (body.length > LIMITS.bodyBytes) return DENY_ALL('body-too-large');
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) return DENY_ALL('invalid-utf8');
  if (text.includes('\u0000')) return DENY_ALL('nul-byte');
  const t = text.replace(/^\uFEFF/, '');
  if (/^\s*<(!doctype|html|head|body)\b/i.test(t)) return DENY_ALL('html-not-robots');
  return parseRobots(t, agent);
}

export function productToken(ua: string): string { return ua.split('/')[0].trim().toLowerCase(); }

export function parseRobots(text: string, agent: string): Robots {
  if (Buffer.byteLength(text) > LIMITS.bodyBytes) return DENY_ALL('body-too-large');
  const token = productToken(agent);
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null; let lastWasAgent = false; let total = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue; // RFC 9309: unparseable lines are ignored
    const key = line.slice(0, i).trim().toLowerCase(); const val = line.slice(i + 1).trim();
    if (key === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur || (key !== 'allow' && key !== 'disallow') || !val) continue;
    if (val.length > LIMITS.patternChars) return DENY_ALL('pattern-too-long');
    if (++total > LIMITS.rules) return DENY_ALL('too-many-rules');
    const n = normalisePattern(val); if (n === null) return DENY_ALL('pattern-decode-failure');
    cur.rules.push({ allow: key === 'allow', pattern: n });
  }
  const specific = groups.filter(g => g.agents.includes(token));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  return { rules: chosen.flatMap(g => g.rules) };
}

function normalisePattern(p: string): string | null {
  // Keep an encoded '/' encoded (it is not a separator); decode everything else once.
  try { return p.split(/%2f/i).map(decodeURIComponent).join('%2F'); } catch { return null; }
}

// Linear wildcard matcher (greedy two-pointer with single backtrack point). '*' = any run, trailing '$' = end anchor.
// Worst case O(|p|*|s|) bounded by caps and a step budget; returns null when the budget is exceeded.
export function wildcardMatch(pattern: string, s: string, budget = LIMITS.matchSteps): boolean | null {
  const anchored = pattern.endsWith('$'); const p = anchored ? pattern.slice(0, -1) : pattern;
  let pi = 0, si = 0, star = -1, mark = 0, steps = 0;
  while (si < s.length) {
    if (++steps > budget) return null;
    if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; continue; }
    if (pi === p.length && !anchored) return true; // prefix match
    if (pi < p.length && p[pi] === s[si]) { pi++; si++; continue; }
    if (star >= 0) { pi = star + 1; si = ++mark; continue; }
    return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// Returns true (disallowed), false (allowed) or 'budget' when matching exceeded its budget (caller fails closed).
export function disallowed(rules: Rule[], path: string): boolean | 'budget' {
  if (path.length > LIMITS.pathChars) return 'budget';
  let best: Rule | null = null;
  for (const r of rules) {
    const m = wildcardMatch(r.pattern, path); if (m === null) return 'budget';
    if (m && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return !!best && !best.allow;
}

// Request path: single decode + checks. '%2F' handled separately by policy (N6).
export type PathResult = { path: string; encodedSlash: boolean } | { bypass: string };
export function normalisePath(raw: string): PathResult {
  if (/%25/i.test(raw)) return { bypass: 'double-encoding' };
  if (/%5c|%2e/i.test(raw) || raw.includes('\\')) return { bypass: 'encoded-separator' };
  const encodedSlash = /%2f/i.test(raw);
  let path: string;
  try { path = raw.split(/%2f/i).map(decodeURIComponent).join('%2F'); } catch { return { bypass: 'decode-failure' }; }
  const segs = encodedSlash ? path.replace(/%2F/g, '/').split('/') : path.split('/');
  if (segs.some(s => s === '.' || s === '..')) return { bypass: 'dot-segment' };
  return { path, encodedSlash };
}
