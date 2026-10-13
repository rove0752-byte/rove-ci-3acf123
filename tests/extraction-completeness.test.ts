import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStructures, createBrowserTools } from '../agent/lib/browser.ts';
import { buildCompleteness } from '../agent/lib/document-catalog.ts';

const JSON_LD_LIMIT = 20_000;
const bounds = { metaLimit: 1000 };

type FakeNode = {
  tag: string;
  text: string | null;
  attrs: Record<string, string>;
  children: FakeNode[];
};

function el(tag: string, text: string | null = null, children: FakeNode[] = [], attrs: Record<string, string> = {}): FakeNode {
  return { tag, text, attrs, children };
}

function matches(node: FakeNode, selector: string): boolean {
  if (selector === 'table') return node.tag === 'table';
  if (selector === 'tr') return node.tag === 'tr';
  if (selector === 'th, td') return node.tag === 'th' || node.tag === 'td';
  if (selector === 'script[type="application/ld+json"]') return node.tag === 'script' && node.attrs.type === 'application/ld+json';
  if (selector === 'meta[name="description" i]') return node.tag === 'meta' && (node.attrs.name ?? '').toLowerCase() === 'description';
  throw new Error(`unexpected selector ${selector}`);
}

function descendants(node: FakeNode, selector: string): FakeNode[] {
  const found: FakeNode[] = [];
  for (const child of node.children) {
    if (matches(child, selector)) found.push(child);
    found.push(...descendants(child, selector));
  }
  return found;
}

function rootOf(node: FakeNode) {
  const adapt = (current: FakeNode): {
    textContent: string | null;
    getAttribute(name: string): string | null;
    querySelector(selector: string): ReturnType<typeof adapt> | null;
    querySelectorAll(selector: string): Array<ReturnType<typeof adapt>>;
  } => ({
    textContent: current.text,
    getAttribute(name: string) { return current.attrs[name] ?? null; },
    querySelector(selector: string) {
      const found = descendants(current, selector)[0];
      return found ? adapt(found) : null;
    },
    querySelectorAll(selector: string) {
      return descendants(current, selector).map(adapt);
    },
  });
  return adapt(node);
}

function jsonBlock(length: number, fill = 'x'): string {
  const head = '{"k":"';
  const tail = '"}';
  assert.ok(length >= head.length + tail.length);
  return head + fill.repeat(length - head.length - tail.length) + tail;
}

function script(text: string): FakeNode {
  return el('script', text, [], { type: 'application/ld+json' });
}

function table(rows: string[][]): FakeNode {
  return el('table', null, rows.map(cells => el('tr', null, cells.map(text => el('td', text)))));
}

function structures(children: FakeNode[]) {
  return collectStructures(rootOf(el('html', null, children)), bounds);
}

function completenessFor(result: ReturnType<typeof structures>) {
  return buildCompleteness({
    headingsKept: 0,
    headingsOmitted: 0,
    linksKept: 0,
    linksOmitted: 0,
    sectionsSkipped: 0,
    textCapped: result.textCapped,
    overlongLinks: 0,
    jsonLdKept: result.jsonLdKept,
    jsonLdOmitted: result.jsonLdOmitted,
    jsonLdInvalid: result.jsonLdInvalid,
    rowsKept: result.rowsKept,
    rowsOmitted: result.rowsOmitted,
    cellsKept: result.cellsKept,
    cellsOmitted: result.cellsOmitted,
  });
}

const catalogCounts = {
  headingsKept: 1,
  headingsOmitted: 0,
  linksKept: 1,
  linksOmitted: 0,
  sectionsSkipped: 0,
  textCapped: false,
  overlongLinks: 0,
};

test('a JSON-LD block exactly at 20000 characters stays complete and is stored', () => {
  const exact = jsonBlock(JSON_LD_LIMIT);
  assert.equal(exact.length, JSON_LD_LIMIT);
  const result = structures([script(`\n${exact}\n`), script('{"ok":true}')]);
  assert.equal(result.jsonLdKept, 2);
  assert.equal(result.jsonLdOmitted, 0);
  assert.equal(JSON.stringify(result.jsonLd[0]).length, JSON_LD_LIMIT);
  assert.deepEqual(result.jsonLd[1], { ok: true });
  const completeness = completenessFor(result);
  assert.equal(completeness.complete, true);
  assert.deepEqual(completeness.reasons, []);
  assert.equal(completeness.jsonLdKept, 2);
  assert.equal(completeness.jsonLdOmitted, 0);
});

test('a JSON-LD block over 20000 characters is omitted and its content is not stored', () => {
  const over = jsonBlock(JSON_LD_LIMIT + 1, 'Q');
  assert.equal(over.length, JSON_LD_LIMIT + 1);
  const kept = Array.from({ length: 5 }, (_, index) => script(`{"n":${index}}`));
  const result = structures([script(''), script('   '), script('not-json'), script(over), ...kept]);
  assert.equal(result.jsonLdKept, 5);
  assert.equal(result.jsonLdOmitted, 1);
  assert.deepEqual(result.jsonLd, [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  assert.equal(JSON.stringify(result.jsonLd).includes('Q'), false);
  const completeness = completenessFor(result);
  assert.equal(completeness.complete, false);
  // 'not-json' is invalid, the two empty blocks are not counted.
  assert.deepEqual(completeness.reasons, ['jsonld-cap', 'jsonld-invalid']);
  assert.equal(completeness.jsonLdKept, 5);
  assert.equal(completeness.jsonLdOmitted, 1);
  assert.equal(completeness.jsonLdInvalid, 1);
});

test('a sixth JSON-LD block is omitted without raising the five-block cap', () => {
  const result = structures(Array.from({ length: 6 }, (_, index) => script(`{"n":${index}}`)));
  assert.equal(result.jsonLdKept, 5);
  assert.equal(result.jsonLdOmitted, 1);
  assert.deepEqual(result.jsonLd, [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  assert.deepEqual(completenessFor(result).reasons, ['jsonld-cap']);
  const exact = structures(Array.from({ length: 5 }, (_, index) => script(`{"n":${index}}`)));
  assert.equal(exact.jsonLdKept, 5);
  assert.equal(exact.jsonLdOmitted, 0);
  assert.equal(completenessFor(exact).complete, true);
});

test('table rows and cells exactly at the limit stay complete', () => {
  const rows = Array.from({ length: 20 }, (_, row) => Array.from({ length: 10 }, (_, cell) => `r${row}c${cell}`));
  const result = structures([table(rows)]);
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0]?.length, 20);
  assert.equal(result.tables[0]?.[0]?.length, 10);
  assert.equal(result.tables[0]?.[19]?.[9], 'r19c9');
  assert.equal(result.rowsKept, 20);
  assert.equal(result.rowsOmitted, 0);
  assert.equal(result.cellsKept, 200);
  assert.equal(result.cellsOmitted, 0);
  assert.equal(completenessFor(result).complete, true);
  assert.deepEqual(completenessFor(result).reasons, []);
});

test('table rows and cells over the limit are counted and their text is not stored', () => {
  const wide = Array.from({ length: 11 }, (_, cell) => cell === 10 ? 'omit-cell' : `c${cell}`);
  const tall = Array.from({ length: 21 }, (_, row) => [row === 20 ? 'omit-row' : `r${row}`]);
  const result = structures([table(tall), table([wide])]);
  assert.equal(result.rowsKept, 21);
  assert.equal(result.rowsOmitted, 1);
  assert.equal(result.cellsKept, 30);
  assert.equal(result.cellsOmitted, 2);
  assert.equal(result.tables[0]?.length, 20);
  assert.equal(result.tables[1]?.[0]?.length, 10);
  const stored = JSON.stringify(result.tables);
  assert.equal(stored.includes('omit-row'), false);
  assert.equal(stored.includes('omit-cell'), false);
  assert.equal(stored.includes('r19'), true);
  assert.equal(stored.includes('c9'), true);
  const completeness = completenessFor(result);
  assert.equal(completeness.complete, false);
  assert.deepEqual(completeness.reasons, ['table-cap']);
  assert.equal(completeness.rowsKept, 21);
  assert.equal(completeness.rowsOmitted, 1);
  assert.equal(completeness.cellsKept, 30);
  assert.equal(completeness.cellsOmitted, 2);
});

test('a sixth table is omitted without raising the five-table cap', () => {
  const tables = Array.from({ length: 6 }, (_, index) => table([[index === 5 ? 'omit-table' : `t${index}`]]));
  const result = structures(tables);
  assert.equal(result.tables.length, 5);
  assert.equal(result.rowsKept, 5);
  assert.equal(result.rowsOmitted, 1);
  assert.equal(result.cellsKept, 5);
  assert.equal(result.cellsOmitted, 1);
  assert.equal(JSON.stringify(result.tables).includes('omit-table'), false);
  assert.deepEqual(completenessFor(result).reasons, ['table-cap']);
  const exact = structures(Array.from({ length: 5 }, (_, index) => table([[`t${index}`]])));
  assert.equal(exact.tables.length, 5);
  assert.equal(exact.rowsOmitted, 0);
  assert.equal(exact.cellsOmitted, 0);
  assert.equal(completenessFor(exact).complete, true);
});

test('cell text over 200 characters is sliced and is not an omitted cell', () => {
  const result = structures([table([['Z'.repeat(201)]])]);
  assert.equal(result.cellsKept, 1);
  assert.equal(result.cellsOmitted, 0);
  assert.equal(result.rowsOmitted, 0);
  assert.equal(result.tables[0]?.[0]?.[0], 'Z'.repeat(200));
  assert.equal(completenessFor(result).complete, true);
});

test('catalog completeness stays unchanged when JSON-LD and table counts are absent', () => {
  const catalog = buildCompleteness(catalogCounts);
  for (const key of ['jsonLdKept', 'jsonLdOmitted', 'jsonLdInvalid', 'rowsKept', 'rowsOmitted', 'cellsKept', 'cellsOmitted']) {
    assert.equal(Object.hasOwn(catalog, key), false);
  }
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.reasons, []);
  const both = buildCompleteness({ ...catalogCounts, jsonLdKept: 1, jsonLdOmitted: 1, rowsKept: 20, rowsOmitted: 1, cellsKept: 10, cellsOmitted: 1 });
  assert.equal(both.complete, false);
  assert.deepEqual(both.reasons, ['jsonld-cap', 'table-cap']);
  assert.equal(both.jsonLdKept, 1);
  assert.equal(both.rowsKept, 20);
  assert.equal(both.cellsKept, 10);
});

test('inspect reports omitted JSON-LD and table rows without storing them', async () => {
  const exact = jsonBlock(JSON_LD_LIMIT);
  const over = jsonBlock(JSON_LD_LIMIT + 1, 'Q');
  const rows = Array.from({ length: 21 }, (_, row) => [row === 20 ? 'omit-row' : `r${row}`]);
  const root = rootOf(el('html', null, [script(exact), script(over), table(rows)]));
  let screenshots = 0;
  const page = {
    on() {},
    url: () => 'http://127.0.0.1/structures',
    async goto() { return { status: () => 200 }; },
    async title() { return 'Structures'; },
    async content() { return '<title>Structures</title><h1>Hello</h1>'; },
    async screenshot() { screenshots += 1; return Buffer.from('png'); },
    locator() {
      return {
        async innerText() { return 'Hello'; },
        async evaluateAll() { return { links: [], linksOmitted: 0, overlongLinks: 0, textCapped: false }; },
        async evaluate(fn: (node: unknown, passed: { metaLimit: number }) => unknown, passed: { metaLimit: number }) {
          return fn(root, passed);
        },
      };
    },
    getByRole() {
      return { async count() { return 0; }, nth() { throw new Error('no controls'); } };
    },
  };
  const browser = {
    on() {},
    async newContext() {
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async route() {}, async newPage() { return page; } };
    },
    async close() {},
  };
  const tools = createBrowserTools({
    launch: async () => browser as never,
    validate: async raw => new URL(raw),
    resolve: async () => [{ address: '127.0.0.1', family: 4 as const }],
  });
  const result = await tools.inspectPage('http://127.0.0.1/structures');
  assert.equal(screenshots, 1);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.timedOut, false);
  assert.deepEqual(result.completeness.reasons, ['jsonld-cap', 'table-cap']);
  assert.equal(result.completeness.jsonLdKept, 1);
  assert.equal(result.completeness.jsonLdOmitted, 1);
  assert.equal(result.completeness.rowsKept, 20);
  assert.equal(result.completeness.rowsOmitted, 1);
  assert.equal(result.completeness.cellsKept, 20);
  assert.equal(result.completeness.cellsOmitted, 1);
  assert.equal(result.structured.jsonLd.length, 1);
  assert.equal(JSON.stringify(result.structured.jsonLd[0]).length, JSON_LD_LIMIT);
  assert.equal(JSON.stringify(result.structured.jsonLd).includes('Q'), false);
  assert.equal(result.structured.tables.length, 1);
  assert.equal(result.structured.tables[0]?.length, 20);
  assert.equal(JSON.stringify(result.structured.tables).includes('omit-row'), false);
  assert.equal(result.structured.completeness.complete, false);
});

test('an ld+json block that fails to parse is counted as jsonld-invalid and its text is not stored', () => {
  const result = structures([script('{"@type": "Thing", broken SECRET-INVALID')]);
  assert.equal(result.jsonLdKept, 0);
  assert.equal(result.jsonLdOmitted, 0);
  assert.equal(result.jsonLdInvalid, 1);
  assert.equal(JSON.stringify(result).includes('SECRET-INVALID'), false);
  const completeness = completenessFor(result);
  assert.equal(completeness.complete, false);
  assert.deepEqual(completeness.reasons, ['jsonld-invalid']);
  assert.equal(completeness.jsonLdInvalid, 1);
});

test('valid and invalid ld+json blocks mixed: valid kept, invalid counted separately from the cap', () => {
  const blocks = [script('{"n":0}'), script('{bad'), script('{"n":1}'), script('[1,2'), ...Array.from({ length: 4 }, (_, index) => script(`{"n":${index + 2}}`))];
  const result = structures(blocks);
  assert.deepEqual(result.jsonLd, [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  assert.equal(result.jsonLdKept, 5);
  assert.equal(result.jsonLdOmitted, 1);
  assert.equal(result.jsonLdInvalid, 2);
  assert.deepEqual(completenessFor(result).reasons, ['jsonld-cap', 'jsonld-invalid']);
});

test('empty or whitespace-only ld+json blocks carry no data and are not counted', () => {
  const result = structures([script(''), script('   \n\t '), script('{"ok":true}')]);
  assert.equal(result.jsonLdKept, 1);
  assert.equal(result.jsonLdOmitted, 0);
  assert.equal(result.jsonLdInvalid, 0);
  assert.equal(completenessFor(result).complete, true);
});
