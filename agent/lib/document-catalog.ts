export type Heading = { level: 'h1' | 'h2' | 'h3'; text: string };
export type DocumentLink = { text: string; url: string };
export type DocumentMetadata = {
  language: string;
  description: string;
  canonical: string;
  robots: string;
  ogTitle: string;
};
export type CompletenessReason = 'link-cap' | 'heading-cap' | 'section-skipped' | 'text-cap' | 'overlong-link' | 'timeout';
export type TimeoutStage = 'deadline' | 'navigation' | 'fetch' | 'catalog';
export type ExtractionCompleteness = {
  complete: boolean;
  reasons: CompletenessReason[];
  headingsKept: number;
  headingsOmitted: number;
  linksKept: number;
  linksOmitted: number;
  sectionsSkipped: number;
  overlongLinks: number;
  timedOut: boolean;
  timeoutStage: TimeoutStage | null;
};
export type DocumentCatalog = {
  title: string;
  headings: Heading[];
  links: DocumentLink[];
  metadata: DocumentMetadata;
  completeness: ExtractionCompleteness;
};
export type CatalogMismatch = { field: string; detail: string };
export type CatalogOptions = { timedOut?: boolean; timeoutStage?: TimeoutStage };
export type ExtractionVerification = {
  pass: boolean;
  complete: boolean;
  countsMatch: boolean;
  linkIntegrity: boolean;
  reasons: CompletenessReason[];
  mismatches: CatalogMismatch[];
};

export const HEADING_LIMIT = 20;
// The reviewed docs.python.org/3/ page has more than 60 eligible links. Stopping there dropped the footer.
export const LINK_LIMIT = 500;
export const LINK_URL_LIMIT = 2048;
const TEXT_LIMIT = 300;
const LINK_TEXT_LIMIT = 150;
const META_LIMIT = 1000;

export function extractionBounds() {
  return {
    linkLimit: LINK_LIMIT,
    headingLimit: HEADING_LIMIT,
    linkUrlLimit: LINK_URL_LIMIT,
    linkTextLimit: LINK_TEXT_LIMIT,
    textLimit: TEXT_LIMIT,
    metaLimit: META_LIMIT,
  };
}

export function timeoutFailure(stage: TimeoutStage) {
  return { complete: false as const, failed: true as const, reason: 'timeout' as const, stage, timedOut: true as const };
}

export function buildCompleteness(counts: {
  headingsKept: number;
  headingsOmitted: number;
  linksKept: number;
  linksOmitted: number;
  sectionsSkipped: number;
  textCapped: boolean;
  overlongLinks: number;
  timedOut?: boolean;
  timeoutStage?: TimeoutStage | null;
}): ExtractionCompleteness {
  const reasons: CompletenessReason[] = [];
  if (counts.linksOmitted > 0) reasons.push('link-cap');
  if (counts.headingsOmitted > 0) reasons.push('heading-cap');
  if (counts.sectionsSkipped > 0) reasons.push('section-skipped');
  if (counts.textCapped) reasons.push('text-cap');
  if (counts.overlongLinks > 0) reasons.push('overlong-link');
  const timedOut = counts.timedOut === true;
  if (timedOut) reasons.push('timeout');
  return {
    complete: reasons.length === 0,
    reasons,
    headingsKept: counts.headingsKept,
    headingsOmitted: counts.headingsOmitted,
    linksKept: counts.linksKept,
    linksOmitted: counts.linksOmitted,
    sectionsSkipped: counts.sectionsSkipped,
    overlongLinks: counts.overlongLinks,
    timedOut,
    timeoutStage: timedOut ? (counts.timeoutStage ?? 'catalog') : null,
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

type Truncation = { text: boolean };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function clean(value: string, max: number, truncation?: Truncation): string {
  const text = decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (truncation && text.length > max) truncation.text = true;
  return text.slice(0, max);
}

function attributes(openTag: string): Map<string, string> {
  const found = new Map<string, string>();
  const body = openTag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  for (const match of body.matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]?.toLowerCase();
    if (!name || found.has(name)) continue;
    found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return found;
}

function pageBase(pageUrl: string, html: string): URL {
  const page = new URL(pageUrl);
  const base = /<base\b[^>]*>/i.exec(html);
  if (!base) return page;
  const href = attributes(base[0]).get('href');
  if (!href) return page;
  try {
    const resolved = new URL(href, page);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved;
  } catch { /* An unusable base leaves the document URL in place. */ }
  return page;
}

function acceptedLink(href: string, base: URL): { url: string } | { overlong: true } | null {
  if (!href || href.startsWith('#') || /[\r\n\0]/.test(href)) return null;
  if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(href) && !/^https?:/i.test(href)) return null;
  if (href.length > LINK_URL_LIMIT) return { overlong: true };
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    if (url.href.length > LINK_URL_LIMIT) return { overlong: true };
    return { url: url.href };
  } catch {
    return null;
  }
}

type Region = { kind: string; open: string; body: string; attrs: Map<string, string>; at: number };

function navigationRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const stack: { name: string; nav: boolean; from: number }[] = [];
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const openEnd = html.indexOf('>', start);
    if (openEnd < 0) break;
    const open = html.slice(start, openEnd + 1);
    const named = /^<\/?([a-zA-Z][\w:-]*)/.exec(open);
    const name = named?.[1]?.toLowerCase();
    if (!name) {
      index = openEnd + 1;
      continue;
    }
    if (open.startsWith('</')) {
      for (let frame = stack.length - 1; frame >= 0; frame -= 1) {
        if (stack[frame]?.name !== name) continue;
        const closed = stack[frame];
        if (closed?.nav) ranges.push([closed.from, openEnd + 1]);
        stack.length = frame;
        break;
      }
      index = openEnd + 1;
      continue;
    }
    if (name === 'script' || name === 'style') {
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(openEnd + 1));
      index = close ? openEnd + 1 + close.index + close[0].length : html.length;
      continue;
    }
    const role = (attributes(open).get('role') ?? '').toLowerCase().split(/\s+/);
    const nav = name === 'nav' || role.includes('navigation');
    if (!open.endsWith('/>') && !VOID_TAGS.has(name)) stack.push({ name, nav, from: start });
    index = openEnd + 1;
  }
  for (const frame of stack) {
    if (frame.nav) ranges.push([frame.from, html.length]);
  }
  return ranges;
}

function insideNavigation(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function regions(html: string): Region[] {
  const found: Region[] = [];
  const interesting = new Set(['title', 'h1', 'h2', 'h3', 'a', 'meta', 'link']);
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const openEnd = html.indexOf('>', start);
    if (openEnd < 0) break;
    const open = html.slice(start, openEnd + 1);
    const named = /^<\/?([a-zA-Z][\w:-]*)/.exec(open);
    const name = named?.[1]?.toLowerCase();
    if (!name || open.startsWith('</')) {
      index = openEnd + 1;
      continue;
    }
    if (name === 'script' || name === 'style') {
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(openEnd + 1));
      index = close ? openEnd + 1 + close.index + close[0].length : html.length;
      continue;
    }
    if (interesting.has(name)) {
      const voidTag = name === 'meta' || name === 'link' || open.endsWith('/>');
      if (voidTag) found.push({ kind: name, open, body: '', attrs: attributes(open), at: start });
      else {
        const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(openEnd + 1));
        if (close) {
          found.push({
            kind: name,
            open,
            body: html.slice(openEnd + 1, openEnd + 1 + close.index),
            attrs: attributes(open),
            at: start,
          });
        }
      }
    }
    index = openEnd + 1;
  }
  return found;
}

function visibleDocument(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, ' ');
}

function skippedRegionCount(html: string): number {
  const visible = visibleDocument(html);
  let skipped = 0;
  for (const tag of ['h1', 'h2', 'h3', 'a']) {
    const opens = visible.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))?.length ?? 0;
    const closes = visible.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0;
    if (opens > closes) skipped += opens - closes;
  }
  return skipped;
}

function considerHeading(headings: Heading[], seenNav: Set<string>, level: Heading['level'], text: string, inNav: boolean): number {
  if (!text) return 0;
  if (inNav) {
    const key = `${level}\0${text}`;
    if (seenNav.has(key)) return 0;
    seenNav.add(key);
  }
  if (headings.length >= HEADING_LIMIT) return 1;
  headings.push({ level, text });
  return 0;
}

function considerLink(links: DocumentLink[], text: string, url: string): number {
  if (links.length >= LINK_LIMIT) return 1;
  links.push({ text, url });
  return 0;
}

function finishCatalog(
  title: string,
  headings: Heading[],
  links: DocumentLink[],
  metadata: DocumentMetadata,
  counts: { headingsOmitted: number; linksOmitted: number; sectionsSkipped: number; text: boolean; overlongLinks: number },
  options?: CatalogOptions,
): DocumentCatalog {
  return {
    title,
    headings,
    links,
    metadata,
    completeness: buildCompleteness({
      headingsKept: headings.length,
      headingsOmitted: counts.headingsOmitted,
      linksKept: links.length,
      linksOmitted: counts.linksOmitted,
      sectionsSkipped: counts.sectionsSkipped,
      textCapped: counts.text,
      overlongLinks: counts.overlongLinks,
      timedOut: options?.timedOut === true,
      timeoutStage: options?.timeoutStage,
    }),
  };
}

function scanDocument(html: string, pageUrl: string, options?: CatalogOptions): DocumentCatalog {
  const visible = visibleDocument(html);
  const base = pageBase(pageUrl, visible);
  const ranges = navigationRanges(visible);
  const truncation: Truncation = { text: false };
  const title = clean(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(visible)?.[1] ?? '', TEXT_LIMIT, truncation);
  const headings: Heading[] = [];
  const seenNav = new Set<string>();
  let headingsOmitted = 0;
  for (const match of visible.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const level = match[1] === '1' ? 'h1' : match[1] === '2' ? 'h2' : 'h3';
    const text = clean(match[2] ?? '', TEXT_LIMIT, truncation);
    headingsOmitted += considerHeading(headings, seenNav, level, text, insideNavigation(ranges, match.index ?? 0));
  }
  const links: DocumentLink[] = [];
  let linksOmitted = 0;
  let overlongLinks = 0;
  for (const match of visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const decision = acceptedLink(attributes(`<a${match[1] ?? ''}>`).get('href') ?? '', base);
    if (!decision) continue;
    if ('overlong' in decision) { overlongLinks += 1; continue; }
    linksOmitted += considerLink(links, clean(match[2] ?? '', LINK_TEXT_LIMIT, truncation), decision.url);
  }
  const tags: Region[] = [];
  for (const match of visible.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    tags.push({ kind: match[1]?.toLowerCase() ?? '', open: match[0], body: '', attrs: attributes(match[0]), at: match.index ?? 0 });
  }
  return finishCatalog(title, headings, links, metadataFrom(tags, visible, truncation), {
    headingsOmitted,
    linksOmitted,
    sectionsSkipped: skippedRegionCount(html),
    text: truncation.text,
    overlongLinks,
  }, options);
}

function metadataFrom(regionsFound: Region[], html: string, truncation?: Truncation): DocumentMetadata {
  const metadata: DocumentMetadata = { language: '', description: '', canonical: '', robots: '', ogTitle: '' };
  const root = /<html\b[^>]*>/i.exec(html);
  metadata.language = clean(root ? attributes(root[0]).get('lang') ?? '' : '', 40, truncation);
  for (const region of regionsFound) {
    if (region.kind === 'meta') {
      const content = clean(region.attrs.get('content') ?? '', META_LIMIT, truncation);
      const name = (region.attrs.get('name') ?? '').toLowerCase();
      const property = (region.attrs.get('property') ?? '').toLowerCase();
      if (name === 'description' && !metadata.description) metadata.description = content;
      if (name === 'robots' && !metadata.robots) metadata.robots = content;
      if (property === 'og:title' && !metadata.ogTitle) metadata.ogTitle = content;
    }
    if (region.kind === 'link' && (region.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical') && !metadata.canonical) {
      metadata.canonical = clean(region.attrs.get('href') ?? '', META_LIMIT, truncation);
    }
  }
  return metadata;
}

function catalogFrom(html: string, pageUrl: string, source: Region[], options?: CatalogOptions): DocumentCatalog {
  const base = pageBase(pageUrl, html);
  const ranges = navigationRanges(html);
  const truncation: Truncation = { text: false };
  const headings: Heading[] = [];
  const links: DocumentLink[] = [];
  const seenNav = new Set<string>();
  let headingsOmitted = 0;
  let linksOmitted = 0;
  let overlongLinks = 0;
  let title = '';
  for (const region of source) {
    if (region.kind === 'title' && !title) title = clean(region.body, TEXT_LIMIT, truncation);
    if (region.kind === 'h1' || region.kind === 'h2' || region.kind === 'h3') {
      const text = clean(region.body, TEXT_LIMIT, truncation);
      headingsOmitted += considerHeading(headings, seenNav, region.kind, text, insideNavigation(ranges, region.at));
    }
    if (region.kind === 'a') {
      const decision = acceptedLink(region.attrs.get('href') ?? '', base);
      if (!decision) continue;
      if ('overlong' in decision) { overlongLinks += 1; continue; }
      linksOmitted += considerLink(links, clean(region.body, LINK_TEXT_LIMIT, truncation), decision.url);
    }
  }
  return finishCatalog(title, headings, links, metadataFrom(source, html, truncation), {
    headingsOmitted,
    linksOmitted,
    sectionsSkipped: skippedRegionCount(html),
    text: truncation.text,
    overlongLinks,
  }, options);
}

export function catalogDocument(html: string, pageUrl: string, options?: CatalogOptions): DocumentCatalog {
  if (typeof html !== 'string' || typeof pageUrl !== 'string') throw new Error('Document catalog requires the retrieved document.');
  return catalogFrom(html, pageUrl, regions(html), options);
}

// Regex scan is separate from the catalog walker so a shared parsing mistake is not its own proof.
export function auditCatalog(html: string, pageUrl: string, catalog: DocumentCatalog, options?: CatalogOptions): { pass: boolean; mismatches: CatalogMismatch[] } {
  const found = scanDocument(html, pageUrl, options);
  const mismatches: CatalogMismatch[] = [];
  const differ = (field: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ field, detail: `${field} does not match the retrieved document` });
  };
  differ('title', catalog.title, found.title);
  differ('headings', catalog.headings, found.headings);
  differ('links', catalog.links, found.links);
  differ('metadata', catalog.metadata, found.metadata);
  differ('completeness', catalog.completeness, found.completeness);
  return { pass: mismatches.length === 0, mismatches };
}

function countsMatch(catalog: DocumentCatalog): boolean {
  const completeness = catalog.completeness;
  if (!completeness || !Array.isArray(completeness.reasons)) return false;
  const expected: CompletenessReason[] = [];
  if (completeness.linksOmitted > 0) expected.push('link-cap');
  if (completeness.headingsOmitted > 0) expected.push('heading-cap');
  if (completeness.sectionsSkipped > 0) expected.push('section-skipped');
  if (completeness.reasons.includes('text-cap')) expected.push('text-cap');
  if (completeness.overlongLinks > 0) expected.push('overlong-link');
  if (completeness.timedOut) expected.push('timeout');
  const sameReasons = completeness.reasons.length === expected.length
    && completeness.reasons.every((reason, index) => reason === expected[index]);
  const stageOk = completeness.timedOut
    ? typeof completeness.timeoutStage === 'string' && completeness.timeoutStage.length > 0
    : completeness.timeoutStage === null;
  return completeness.headingsKept === catalog.headings.length
    && completeness.linksKept === catalog.links.length
    && Number.isInteger(completeness.headingsOmitted) && completeness.headingsOmitted >= 0
    && Number.isInteger(completeness.linksOmitted) && completeness.linksOmitted >= 0
    && Number.isInteger(completeness.sectionsSkipped) && completeness.sectionsSkipped >= 0
    && Number.isInteger(completeness.overlongLinks) && completeness.overlongLinks >= 0
    && completeness.complete === (expected.length === 0)
    && completeness.timedOut === expected.includes('timeout')
    && stageOk
    && sameReasons;
}

function linksHold(links: DocumentLink[]): boolean {
  return links.every(link => {
    if (typeof link.text !== 'string' || typeof link.url !== 'string') return false;
    if (link.text.length > LINK_TEXT_LIMIT || link.url.length > LINK_URL_LIMIT || /[\s#]/.test(link.url)) return false;
    try {
      const url = new URL(link.url);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hash === '' && url.href === link.url;
    } catch {
      return false;
    }
  });
}

export function verifyExtraction(html: string, pageUrl: string, catalog: DocumentCatalog, options?: CatalogOptions): ExtractionVerification {
  const audit = auditCatalog(html, pageUrl, catalog, options);
  const fresh = catalogDocument(html, pageUrl, options);
  const integrity = linksHold(catalog.links) && JSON.stringify(fresh.links) === JSON.stringify(catalog.links);
  const counts = countsMatch(catalog);
  const reasons = catalog.completeness?.reasons ?? [];
  return {
    pass: audit.pass && counts && integrity && fresh.completeness.complete === catalog.completeness?.complete,
    complete: catalog.completeness?.complete === true,
    countsMatch: counts,
    linkIntegrity: integrity,
    reasons,
    mismatches: audit.mismatches,
  };
}
