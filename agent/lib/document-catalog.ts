export type Heading = { level: 'h1' | 'h2' | 'h3'; text: string };
export type DocumentLink = { text: string; url: string };
export type DocumentMetadata = {
  language: string;
  description: string;
  canonical: string;
  robots: string;
  ogTitle: string;
};
export type DocumentCatalog = {
  title: string;
  headings: Heading[];
  links: DocumentLink[];
  metadata: DocumentMetadata;
};
export type CatalogMismatch = { field: string; detail: string };

export const HEADING_LIMIT = 20;
export const LINK_LIMIT = 60;
const TEXT_LIMIT = 300;
const META_LIMIT = 1000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

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

function clean(value: string, max: number): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);
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

function absoluteHttp(href: string, base: URL): string | null {
  if (!href || href.length > 2048 || /[\r\n\0]/.test(href) || href.startsWith('#')) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

type Region = { kind: string; open: string; body: string; attrs: Map<string, string> };

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
      if (voidTag) found.push({ kind: name, open, body: '', attrs: attributes(open) });
      else {
        const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(openEnd + 1));
        if (close) {
          found.push({
            kind: name,
            open,
            body: html.slice(openEnd + 1, openEnd + 1 + close.index),
            attrs: attributes(open),
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

function scanDocument(html: string, pageUrl: string): DocumentCatalog {
  const visible = visibleDocument(html);
  const base = pageBase(pageUrl, visible);
  const title = clean(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(visible)?.[1] ?? '', TEXT_LIMIT);
  const headings: Heading[] = [];
  for (const match of visible.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    if (headings.length >= HEADING_LIMIT) break;
    const level = match[1] === '1' ? 'h1' : match[1] === '2' ? 'h2' : 'h3';
    const text = clean(match[2] ?? '', TEXT_LIMIT);
    if (text) headings.push({ level, text });
  }
  const links: DocumentLink[] = [];
  for (const match of visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (links.length >= LINK_LIMIT) break;
    const url = absoluteHttp(attributes(`<a${match[1] ?? ''}>`).get('href') ?? '', base);
    if (!url) continue;
    links.push({ text: clean(match[2] ?? '', 150), url });
  }
  const tags: Region[] = [];
  for (const match of visible.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    tags.push({ kind: match[1]?.toLowerCase() ?? '', open: match[0], body: '', attrs: attributes(match[0]) });
  }
  return { title, headings, links, metadata: metadataFrom(tags, visible) };
}

function metadataFrom(regionsFound: Region[], html: string): DocumentMetadata {
  const metadata: DocumentMetadata = { language: '', description: '', canonical: '', robots: '', ogTitle: '' };
  const root = /<html\b[^>]*>/i.exec(html);
  metadata.language = clean(root ? attributes(root[0]).get('lang') ?? '' : '', 40);
  for (const region of regionsFound) {
    if (region.kind === 'meta') {
      const content = clean(region.attrs.get('content') ?? '', META_LIMIT);
      const name = (region.attrs.get('name') ?? '').toLowerCase();
      const property = (region.attrs.get('property') ?? '').toLowerCase();
      if (name === 'description' && !metadata.description) metadata.description = content;
      if (name === 'robots' && !metadata.robots) metadata.robots = content;
      if (property === 'og:title' && !metadata.ogTitle) metadata.ogTitle = content;
    }
    if (region.kind === 'link' && (region.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical') && !metadata.canonical) {
      metadata.canonical = clean(region.attrs.get('href') ?? '', META_LIMIT);
    }
  }
  return metadata;
}

function catalogFrom(html: string, pageUrl: string, source: Region[]): DocumentCatalog {
  const base = pageBase(pageUrl, html);
  const headings: Heading[] = [];
  const links: DocumentLink[] = [];
  let title = '';
  for (const region of source) {
    if (region.kind === 'title' && !title) title = clean(region.body, TEXT_LIMIT);
    if ((region.kind === 'h1' || region.kind === 'h2' || region.kind === 'h3') && headings.length < HEADING_LIMIT) {
      const text = clean(region.body, TEXT_LIMIT);
      if (text) headings.push({ level: region.kind, text });
    }
    if (region.kind === 'a' && links.length < LINK_LIMIT) {
      const url = absoluteHttp(region.attrs.get('href') ?? '', base);
      if (!url) continue;
      links.push({ text: clean(region.body, 150), url });
    }
  }
  return { title, headings, links, metadata: metadataFrom(source, html) };
}

export function catalogDocument(html: string, pageUrl: string): DocumentCatalog {
  if (typeof html !== 'string' || typeof pageUrl !== 'string') throw new Error('Document catalog requires the retrieved document.');
  return catalogFrom(html, pageUrl, regions(html));
}

// Regex scan is separate from the catalog walker so a shared parsing mistake is not its own proof.
export function auditCatalog(html: string, pageUrl: string, catalog: DocumentCatalog): { pass: boolean; mismatches: CatalogMismatch[] } {
  const found = scanDocument(html, pageUrl);
  const mismatches: CatalogMismatch[] = [];
  const differ = (field: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ field, detail: `${field} does not match the retrieved document` });
  };
  differ('title', catalog.title, found.title);
  differ('headings', catalog.headings, found.headings);
  differ('links', catalog.links, found.links);
  differ('metadata', catalog.metadata, found.metadata);
  return { pass: mismatches.length === 0, mismatches };
}
