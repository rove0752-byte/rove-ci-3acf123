// robots.txt: groups, most-specific user-agent group, Allow/Disallow longest match (Allow wins ties), * and $.
export type Rule = { allow: boolean; pattern: string };
export function parseRobots(text: string, agent: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null; let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(); const val = line.slice(i + 1).trim();
    if (key === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur) continue;
    if ((key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', pattern: val });
  }
  const a = agent.toLowerCase();
  const specific = groups.filter(g => g.agents.some(x => x !== '*' && a.includes(x)));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  return chosen.flatMap(g => g.rules);
}
function toRegex(p: string): RegExp {
  const end = p.endsWith('$'); const body = (end ? p.slice(0, -1) : p).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (end ? '$' : ''));
}
export function disallowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) if (toRegex(r.pattern).test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  return !!best && !best.allow;
}
// Single decode + normalisation check. Returns the decoded path, or a bypass reason.
export function normalisePath(raw: string): { path: string } | { bypass: string } {
  if (/%25/i.test(raw)) return { bypass: 'double-encoding' };
  if (/%2f|%5c|%2e/i.test(raw) || raw.includes('\\')) return { bypass: 'encoded-separator' };
  let path: string; try { path = decodeURIComponent(raw); } catch { return { bypass: 'decode-failure' }; }
  if (path.split('/').some(s => s === '.' || s === '..')) return { bypass: 'dot-segment' };
  return { path };
}
