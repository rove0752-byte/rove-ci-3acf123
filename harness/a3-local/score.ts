// Scores A3-local evidence against hand-checked golden files. Exit 1 if any threshold fails.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2];
const T = { headings: 0.95, links: 0.98, title: 1, jsonLd: 1, tables: 1 };
type Golden = { title: string; headings: string[]; linkCount: number; mustLinks: string[]; jsonLd?: { parsed: number; invalid: number }; tableRows?: number };
const rows: Record<string, unknown>[] = [];
let pass = true;
for (const file of readdirSync(join(here, 'golden')).filter(f => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  const g = JSON.parse(readFileSync(join(here, 'golden', file), 'utf8')) as Golden;
  const r = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
  const heads: string[] = (r.structured?.headings ?? []).map((h: { text: string }) => h.text);
  const urls: string[] = (r.links ?? []).map((l: { url: string }) => new URL(l.url).pathname);
  const headingRecall = g.headings.length ? g.headings.filter(h => heads.includes(h)).length / g.headings.length : 1;
  const headingExact = JSON.stringify(heads) === JSON.stringify(g.headings);
  const linkRecall = g.linkCount ? Math.min(urls.length, g.linkCount) / g.linkCount : (urls.length === 0 ? 1 : 0);
  const mustOk = g.mustLinks.every(p => urls.includes(p));
  const titleOk = r.title === g.title ? 1 : 0;
  let jsonLdOk = 1;
  if (g.jsonLd) {
    const parsed = (r.structured?.jsonLd ?? []).length;
    const invalid = r.completeness?.jsonLdInvalid ?? -1;
    jsonLdOk = parsed === g.jsonLd.parsed && invalid === g.jsonLd.invalid ? 1 : 0;
  }
  let tableOk = 1;
  if (g.tableRows !== undefined) {
    const t = r.structured?.tables?.[0];
    const kept = Array.isArray(t) ? t.length : (t?.rows?.length ?? 0);
    const omitted = r.completeness?.rowsOmitted ?? 0;
    tableOk = kept + omitted === g.tableRows ? 1 : 0;
  }
  const ok = headingRecall >= T.headings && linkRecall >= T.links && mustOk && titleOk >= T.title && jsonLdOk >= T.jsonLd && tableOk >= T.tables && !r.error;
  if (!ok) pass = false;
  rows.push({ page: name, headingRecall, headingExact, linkRecall, mustLinks: mustOk, title: titleOk, jsonLd: jsonLdOk, table: tableOk, pass: ok, error: r.error ?? null });
}
const report = { thresholds: T, pages: rows, pass };
writeFileSync(join(OUT, 'score.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
