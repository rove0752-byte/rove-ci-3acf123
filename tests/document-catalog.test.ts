import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HEADING_LIMIT,
  LINK_LIMIT,
  LINK_URL_LIMIT,
  auditCatalog,
  buildCompleteness,
  catalogDocument,
  extractionBounds,
  timeoutFailure,
  verifyExtraction,
  type DocumentCatalog,
} from '../agent/lib/document-catalog.ts';

const page = `<!doctype html>
<html lang="en">
<head>
<base href="https://docs.example/guide/">
<meta name="description" content="A small &amp; precise page">
<meta name="robots" content="noindex">
<meta property="og:title" content="Guide">
<link rel="canonical" href="https://docs.example/guide/">
<title>Guide &amp; Notes</title>
</head>
<body>
<h1>Start <em>here</em></h1>
<h2>Details</h2>
<script>const heading = "<h1>not a heading</h1>";</script>
<style>h1 { content: "styled" }</style>
<!-- <h1>hidden</h1> <a href="https://hidden.example/">Hidden</a> -->
<a href="/intro">Intro</a>
<a href="next.html">Next</a>
<a href="https://other.example/a">Other</a>
<a href="javascript:alert(1)">Bad</a>
<h3> </h3>
</body>
</html>`;

const expected: DocumentCatalog = {
  title: 'Guide & Notes',
  headings: [
    { level: 'h1', text: 'Start here' },
    { level: 'h2', text: 'Details' },
  ],
  links: [
    { text: 'Intro', url: 'https://docs.example/intro' },
    { text: 'Next', url: 'https://docs.example/guide/next.html' },
    { text: 'Other', url: 'https://other.example/a' },
  ],
  metadata: {
    language: 'en',
    description: 'A small & precise page',
    canonical: 'https://docs.example/guide/',
    robots: 'noindex',
    ogTitle: 'Guide',
  },
  completeness: {
    complete: true,
    reasons: [],
    headingsKept: 2,
    headingsOmitted: 0,
    linksKept: 3,
    linksOmitted: 0,
    sectionsSkipped: 0,
    overlongLinks: 0,
    timedOut: false,
    timeoutStage: null,
  },
};

test('catalog fields match the retrieved document', () => {
  const catalog = catalogDocument(page, 'https://docs.example/start');
  assert.deepEqual(catalog, expected);
  const audit = auditCatalog(page, 'https://docs.example/start', catalog);
  assert.equal(audit.pass, true);
  assert.deepEqual(audit.mismatches, []);
  const check = verifyExtraction(page, 'https://docs.example/start', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, true);
  assert.equal(check.countsMatch, true);
  assert.equal(check.linkIntegrity, true);
});

test('a catalog that adds or drops document fields fails the audit', () => {
  const catalog = catalogDocument(page, 'https://docs.example/start');
  const invented = { ...catalog, title: 'Invented title' };
  const missing = { ...catalog, headings: catalog.headings.slice(1) };
  const foreignLink = { ...catalog, links: [...catalog.links, { text: 'Extra', url: 'https://extra.example/' }] };
  for (const altered of [invented, missing, foreignLink]) {
    const audit = auditCatalog(page, 'https://docs.example/start', altered);
    assert.equal(audit.pass, false);
    assert.ok(audit.mismatches.length > 0);
    assert.equal(verifyExtraction(page, 'https://docs.example/start', altered).pass, false);
  }
});

test('relative links use the document URL when no base is declared', () => {
  const html = '<title>Plain</title><h1>Only</h1><a href="local.html">Local</a><a href="mailto:a@example.com">Mail</a>';
  const catalog = catalogDocument(html, 'https://docs.example/dir/page');
  assert.deepEqual(catalog.links, [{ text: 'Local', url: 'https://docs.example/dir/local.html' }]);
  assert.equal(auditCatalog(html, 'https://docs.example/dir/page', catalog).pass, true);
  assert.equal(catalog.completeness.complete, true);
});

test('a local stand-in for the reviewed Python docs outline matches its own audit', () => {
  const html = `<!doctype html>
<html lang="en">
<head><title>3.15.0 Documentation</title></head>
<body>
<h1>Python 3.15.0 documentation</h1>
<p>Welcome! This is the official documentation for Python 3.15.0.</p>
<h2>Documentation sections</h2>
<a href="tutorial/index.html">Tutorial</a>
<a href="library/index.html">Library reference</a>
<a href="reference/index.html">Language reference</a>
<h2>Other resources</h2>
<a href="https://devguide.python.org/">Python developer's guide</a>
<a href="https://packaging.python.org/">Python Packaging User Guide</a>
<h2>Indices, glossary, and search</h2>
<a href="py-modindex.html">Global module index</a>
<a href="glossary.html">Glossary</a>
<a href="/license.html">History and License</a>
<script>const heading = "<h1>not a heading</h1>";</script>
<!-- <a href="https://hidden.example/">Hidden</a> -->
<a href="javascript:alert(1)">Bad</a>
</body>
</html>`;
  const page = 'https://docs.python.org/3/';
  const catalog = catalogDocument(html, page);
  assert.equal(catalog.title, '3.15.0 Documentation');
  assert.deepEqual(catalog.headings, [
    { level: 'h1', text: 'Python 3.15.0 documentation' },
    { level: 'h2', text: 'Documentation sections' },
    { level: 'h2', text: 'Other resources' },
    { level: 'h2', text: 'Indices, glossary, and search' },
  ]);
  assert.deepEqual(catalog.links.map(link => link.url), [
    'https://docs.python.org/3/tutorial/index.html',
    'https://docs.python.org/3/library/index.html',
    'https://docs.python.org/3/reference/index.html',
    'https://devguide.python.org/',
    'https://packaging.python.org/',
    'https://docs.python.org/3/py-modindex.html',
    'https://docs.python.org/3/glossary.html',
    'https://docs.python.org/license.html',
  ]);
  assert.deepEqual(catalog.metadata, { language: 'en', description: '', canonical: '', robots: '', ogTitle: '' });
  const audit = auditCatalog(html, page, catalog);
  assert.equal(audit.pass, true);
  assert.deepEqual(audit.mismatches, []);
  const dropped = { ...catalog, links: catalog.links.filter(link => link.url !== 'https://devguide.python.org/') };
  const mismatch = auditCatalog(html, page, dropped);
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.mismatches.some(item => item.field === 'links'), true);
  assert.equal(verifyExtraction(html, page, catalog).pass, true);
  assert.equal(verifyExtraction(html, page, dropped).pass, false);
});

test('long title text is bounded and still matches the document', () => {
  const title = 'T'.repeat(400);
  const html = `<title>${title}</title>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.equal(catalog.title, title.slice(0, 300));
  assert.equal(catalog.completeness.complete, false);
  assert.deepEqual(catalog.completeness.reasons, ['text-cap']);
  assert.equal(auditCatalog(html, 'https://docs.example/', catalog).pass, true);
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
});

test('long link urls are kept whole', () => {
  const path = `/path/${'a'.repeat(180)}`;
  const html = `<title>U</title><a href="${path}">Go</a>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.equal(catalog.links[0]?.url, `https://docs.example${path}`);
  assert.equal(catalog.completeness.complete, true);
  assert.equal(verifyExtraction(html, 'https://docs.example/', catalog).linkIntegrity, true);
});

test('links past the safety cap are reported as omitted', () => {
  const count = LINK_LIMIT + 3;
  const anchors = Array.from({ length: count }, (_, index) => `<a href="https://docs.example/p/${index}">P${index}</a>`).join('');
  const html = `<title>Many</title><h1>Many</h1>${anchors}`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.equal(catalog.links.length, LINK_LIMIT);
  assert.equal(catalog.completeness.linksKept, LINK_LIMIT);
  assert.equal(catalog.completeness.linksOmitted, 3);
  assert.equal(catalog.completeness.complete, false);
  assert.deepEqual(catalog.completeness.reasons, ['link-cap']);
  assert.equal(catalog.links[0]?.url, 'https://docs.example/p/0');
  assert.equal(catalog.links.at(-1)?.url, `https://docs.example/p/${LINK_LIMIT - 1}`);
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
  assert.equal(check.countsMatch, true);
  assert.equal(check.linkIntegrity, true);
  const hidden = {
    ...catalog,
    links: catalog.links.slice(0, 10),
    completeness: { ...catalog.completeness, complete: true, reasons: [], linksKept: 10, linksOmitted: 0 },
  };
  assert.equal(verifyExtraction(html, 'https://docs.example/', hidden).pass, false);
});

test('headings past the safety cap are reported as omitted', () => {
  const count = HEADING_LIMIT + 2;
  const blocks = Array.from({ length: count }, (_, index) => `<h2>Part ${index}</h2>`).join('');
  const html = `<title>Outline</title>${blocks}`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.equal(catalog.headings.length, HEADING_LIMIT);
  assert.equal(catalog.completeness.headingsOmitted, 2);
  assert.equal(catalog.completeness.complete, false);
  assert.ok(catalog.completeness.reasons.includes('heading-cap'));
  assert.equal(catalog.headings.at(-1)?.text, `Part ${HEADING_LIMIT - 1}`);
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
});

test('repeated nav headings collapse and real headings stay', () => {
  const html = `<!doctype html>
<html><head><title>Outline</title></head><body>
<nav>
  <h3>Download</h3>
  <h3>Docs by version</h3>
</nav>
<h1>Python 3.15.0 documentation</h1>
<h2>Other resources</h2>
<h3>Download</h3>
<h2>Notes</h2>
<h2>Notes</h2>
<div class="sphinxsidebar" role="Navigation">
  <h3>Download</h3>
  <h3>Docs by version</h3>
</div>
<a href="https://docs.example/keep">Keep</a>
</body></html>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.deepEqual(catalog.headings, [
    { level: 'h3', text: 'Download' },
    { level: 'h3', text: 'Docs by version' },
    { level: 'h1', text: 'Python 3.15.0 documentation' },
    { level: 'h2', text: 'Other resources' },
    { level: 'h3', text: 'Download' },
    { level: 'h2', text: 'Notes' },
    { level: 'h2', text: 'Notes' },
  ]);
  assert.deepEqual(catalog.links, [{ text: 'Keep', url: 'https://docs.example/keep' }]);
  assert.equal(catalog.completeness.complete, true);
  assert.equal(catalog.completeness.headingsOmitted, 0);
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, true);
});

test('an unclosed section is incomplete', () => {
  const html = '<title>Cut</title><h1>Kept</h1><a href="https://docs.example/ok">Ok</a><a href="https://docs.example/cut">Cut<h2>Open';
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.deepEqual(catalog.headings, [{ level: 'h1', text: 'Kept' }]);
  assert.deepEqual(catalog.links, [{ text: 'Ok', url: 'https://docs.example/ok' }]);
  assert.ok(catalog.completeness.sectionsSkipped >= 1);
  assert.equal(catalog.completeness.complete, false);
  assert.ok(catalog.completeness.reasons.includes('section-skipped'));
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
});

test('a timeout is recorded on the catalog', () => {
  const catalog = catalogDocument(page, 'https://docs.example/start', { timedOut: true });
  assert.equal(catalog.completeness.timedOut, true);
  assert.equal(catalog.completeness.timeoutStage, 'catalog');
  assert.equal(catalog.completeness.complete, false);
  assert.deepEqual(catalog.completeness.reasons, ['timeout']);
  const staged = catalogDocument(page, 'https://docs.example/start', { timedOut: true, timeoutStage: 'navigation' });
  assert.equal(staged.completeness.timeoutStage, 'navigation');
  assert.equal(staged.completeness.complete, false);
  assert.equal(verifyExtraction(page, 'https://docs.example/start', staged, { timedOut: true, timeoutStage: 'navigation' }).pass, true);
  const check = verifyExtraction(page, 'https://docs.example/start', catalog, { timedOut: true });
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
  assert.equal(verifyExtraction(page, 'https://docs.example/start', catalog).pass, false);
});

test('the saved Python docs page keeps footer links and one copy of each nav heading', () => {
  const html = readFileSync(new URL('../reports/readonly-pilot/structured/document.html', import.meta.url), 'utf8');
  const saved = JSON.parse(readFileSync(new URL('../reports/readonly-pilot/structured/catalog.json', import.meta.url), 'utf8')) as {
    links: { url: string }[];
    headings: { text: string }[];
  };
  const pageUrl = 'https://docs.python.org/3/';
  const catalog = catalogDocument(html, pageUrl);
  assert.equal(saved.links.length, 60);
  assert.equal(saved.links.some(link => link.url === 'https://www.sphinx-doc.org/'), false);
  assert.ok(catalog.links.length > saved.links.length);
  assert.equal(catalog.completeness.linksOmitted, 0);
  assert.equal(catalog.completeness.headingsOmitted, 0);
  for (const url of [
    'https://www.sphinx-doc.org/',
    'https://www.python.org/psf/donations/',
    'https://docs.python.org/license.html',
    'https://docs.python.org/bugs.html',
  ]) {
    assert.equal(catalog.links.some(link => link.url === url), true, url);
  }
  assert.ok(catalog.links.filter(link => link.url === 'https://docs.python.org/3/download.html').length >= 2);
  assert.deepEqual(catalog.headings, [
    { level: 'h3', text: 'Download' },
    { level: 'h3', text: 'Docs by version' },
    { level: 'h3', text: 'Other resources' },
    { level: 'h3', text: 'Navigation' },
    { level: 'h1', text: 'Python 3.15.0 documentation' },
  ]);
  assert.equal(catalog.headings.filter(heading => heading.text === 'Download').length, 1);
  assert.equal(saved.headings.filter(heading => heading.text === 'Download').length, 2);
  const check = verifyExtraction(html, pageUrl, catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, true);
  assert.equal(check.countsMatch, true);
  assert.equal(check.linkIntegrity, true);
  assert.equal(auditCatalog(html, pageUrl, catalog).pass, true);
});

test('links longer than 2048 characters are omitted', () => {
  const href = `https://docs.example/${'a'.repeat(2100)}`;
  const html = `<title>Long</title><a href="${href}">Big</a><a href="https://docs.example/ok">Ok</a>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.deepEqual(catalog.links, [{ text: 'Ok', url: 'https://docs.example/ok' }]);
  assert.equal(catalog.completeness.overlongLinks, 1);
  assert.equal(catalog.completeness.linksOmitted, 0);
  assert.equal(catalog.completeness.complete, false);
  assert.deepEqual(catalog.completeness.reasons, ['overlong-link']);
  const check = verifyExtraction(html, 'https://docs.example/', catalog);
  assert.equal(check.pass, true);
  assert.equal(check.complete, false);
  const resolved = `<title>R</title><a href="/${'b'.repeat(2040)}">P</a>`;
  const expanded = catalogDocument(resolved, 'https://docs.example/base/');
  assert.equal(expanded.links.length, 0);
  assert.equal(expanded.completeness.overlongLinks, 1);
  assert.equal(expanded.completeness.complete, false);
  assert.equal(verifyExtraction(resolved, 'https://docs.example/base/', expanded).pass, true);
  const script = `<title>J</title><a href="javascript:${'a'.repeat(2100)}">X</a><a href="https://docs.example/ok">Ok</a>`;
  const ignored = catalogDocument(script, 'https://docs.example/');
  assert.equal(ignored.completeness.overlongLinks, 0);
  assert.equal(ignored.completeness.complete, true);
  assert.deepEqual(ignored.links, [{ text: 'Ok', url: 'https://docs.example/ok' }]);
});

test('browser inspect and the document catalog share extraction bounds', () => {
  const bounds = extractionBounds();
  assert.equal(bounds.linkLimit, LINK_LIMIT);
  assert.equal(bounds.headingLimit, HEADING_LIMIT);
  assert.equal(bounds.linkUrlLimit, LINK_URL_LIMIT);
  assert.equal(LINK_LIMIT, 500);
  assert.equal(LINK_URL_LIMIT, 2048);
  const browserSource = readFileSync(new URL('../agent/lib/browser.ts', import.meta.url), 'utf8');
  assert.equal(browserSource.includes('extractionBounds('), true);
  assert.equal(browserSource.includes('slice(0, 60)'), false);
  assert.equal(browserSource.includes('overlongLinks'), true);
  assert.equal(browserSource.includes('new ExtractionTimeout('), true);
  const html = `<title>Same</title><h1>One</h1><a href="https://docs.example/a">A</a><a href="https://docs.example/${'c'.repeat(2100)}">C</a>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.deepEqual(catalog.completeness, buildCompleteness({
    headingsKept: catalog.headings.length,
    headingsOmitted: catalog.completeness.headingsOmitted,
    linksKept: catalog.links.length,
    linksOmitted: catalog.completeness.linksOmitted,
    sectionsSkipped: catalog.completeness.sectionsSkipped,
    textCapped: false,
    overlongLinks: catalog.completeness.overlongLinks,
  }));
  assert.equal(catalog.links.length, 1);
  assert.equal(catalog.completeness.complete, false);
  const failure = timeoutFailure('fetch');
  assert.deepEqual(failure, { complete: false, failed: true, reason: 'timeout', stage: 'fetch', timedOut: true });
  const fetchSource = readFileSync(new URL('../scripts/fetch-structured-page.ts', import.meta.url), 'utf8');
  assert.equal(fetchSource.includes('timeoutFailure('), true);
  assert.equal(fetchSource.includes('timeout stage='), true);
});

test('document fetch records extraction verification', () => {
  const fetchSource = readFileSync(new URL('../scripts/fetch-structured-page.ts', import.meta.url), 'utf8');
  const hostSource = readFileSync(new URL('../scripts/run-structured-fetch.ts', import.meta.url), 'utf8');
  assert.equal(fetchSource.includes('verifyExtraction('), true);
  assert.equal(hostSource.includes('verifyExtraction('), true);
  assert.equal(fetchSource.includes('linksOmitted'), true);
  assert.equal(hostSource.includes('linksOmitted'), true);
});
