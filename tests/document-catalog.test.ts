import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCatalog, catalogDocument, type DocumentCatalog } from '../agent/lib/document-catalog.ts';

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
};

test('catalog fields match the retrieved document', () => {
  const catalog = catalogDocument(page, 'https://docs.example/start');
  assert.deepEqual(catalog, expected);
  const audit = auditCatalog(page, 'https://docs.example/start', catalog);
  assert.equal(audit.pass, true);
  assert.deepEqual(audit.mismatches, []);
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
  }
});

test('relative links use the document URL when no base is declared', () => {
  const html = '<title>Plain</title><h1>Only</h1><a href="local.html">Local</a><a href="mailto:a@example.com">Mail</a>';
  const catalog = catalogDocument(html, 'https://docs.example/dir/page');
  assert.deepEqual(catalog.links, [{ text: 'Local', url: 'https://docs.example/dir/local.html' }]);
  assert.equal(auditCatalog(html, 'https://docs.example/dir/page', catalog).pass, true);
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
});

test('long title text is bounded and still matches the document', () => {
  const title = 'T'.repeat(400);
  const html = `<title>${title}</title>`;
  const catalog = catalogDocument(html, 'https://docs.example/');
  assert.equal(catalog.title, title.slice(0, 300));
  assert.equal(auditCatalog(html, 'https://docs.example/', catalog).pass, true);
});
