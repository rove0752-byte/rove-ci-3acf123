import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEADING_LIMIT, LINK_LIMIT, auditCatalog, catalogDocument, type DocumentCatalog } from '../agent/lib/document-catalog.ts';
import { createStructuredNetwork, readEvidence, resolveStructuredHost, runStructuredContainer } from './structured-container.ts';
import { STRUCTURED_DOCUMENT_URL, acceptStructuredCapture } from './structured-document.ts';

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(root, 'reports/readonly-pilot/structured');
const resultPath = resolve(reportDir, 'result.json');
if (existsSync(resultPath)) {
  const prior = JSON.parse(readFileSync(resultPath, 'utf8')) as { status?: number; dials?: unknown[] };
  if (prior.status || (prior.dials?.length ?? 0) > 0) {
    throw new Error('Structured document GET already attempted. Refusing another request.');
  }
}

const pinPath = resolve(reportDir, 'pin.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as {
  address?: string;
  documentRequested?: boolean;
  tls?: { open?: boolean; authorized?: boolean; pythonDocsName?: boolean };
};
const host = await resolveStructuredHost();
if (!pin.address || !host.answers.includes(pin.address) || pin.documentRequested !== false ||
  pin.tls?.open !== true || pin.tls.authorized !== true || pin.tls.pythonDocsName !== true) {
  throw new Error('Fresh structured pin is not a current verified public address.');
}

const id = `rove-doc-${process.pid}`;
const network = createStructuredNetwork(id);
process.stdout.write(`Structured document network ipv6=${network.ipv6} pin=${pin.address}\n`);
let failed = true;
try {
  const run = runStructuredContainer(reportDir, id, 'structured-fetch', pin.address);
  process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (!existsSync(resolve(reportDir, 'document.html')) || !existsSync(resolve(reportDir, 'catalog.json'))) {
    throw new Error('Structured document fetch failed before a document was saved.');
  }
  const result = readEvidence(reportDir, 'result.json') as {
    address?: string;
    status?: number;
    sha256?: string;
    request?: { path?: string; servername?: string; hostHeader?: string };
    dials?: { address?: string; port?: number }[];
    location?: string;
  };
  const html = readFileSync(resolve(reportDir, 'document.html'));
  const catalog = readEvidence(reportDir, 'catalog.json') as DocumentCatalog;
  const containerReliability = readEvidence(reportDir, 'reliability.json') as { pass?: boolean; sha256?: string };
  const decoded = html.toString('utf8');
  const hostAudit = auditCatalog(decoded, STRUCTURED_DOCUMENT_URL, catalog);
  const rebuilt = catalogDocument(decoded, STRUCTURED_DOCUMENT_URL);
  const sha256 = createHash('sha256').update(html).digest('hex');
  const catalogMatchesWalker = JSON.stringify(rebuilt) === JSON.stringify(catalog);
  const independent = hostAudit.pass && catalogMatchesWalker && sha256 === result.sha256 &&
    sha256 === containerReliability.sha256 && containerReliability.pass === true &&
    acceptStructuredCapture({
      status: result.status ?? 0,
      address: pin.address,
      dials: result.dials ?? [],
      auditPass: true,
      location: result.location,
    }) && result.address === pin.address && result.request?.path === '/3/' &&
    result.request.servername === 'docs.python.org' && result.request.hostHeader === 'docs.python.org' &&
    host.answers.includes(result.address);
  const reliability = {
    pass: independent,
    mismatches: hostAudit.mismatches,
    independent: true,
    containerPass: containerReliability.pass === true,
    hostPass: hostAudit.pass,
    catalogMatchesWalker,
    sha256,
    headings: rebuilt.headings.length,
    links: rebuilt.links.length,
    headingLimit: HEADING_LIMIT,
    linkLimit: LINK_LIMIT,
    atHeadingLimit: rebuilt.headings.length >= HEADING_LIMIT,
    atLinkLimit: rebuilt.links.length >= LINK_LIMIT,
  };
  writeFileSync(resolve(reportDir, 'reliability.json'), JSON.stringify(reliability, null, 2));
  if (run.status !== 0 || !run.stdout.includes('Structured document fetch passed') || !independent) {
    throw new Error('Structured document fetch failed independent verification.');
  }
  failed = false;
  process.stdout.write(`Structured document verified ${result.address} ${result.status} ${rebuilt.title}\n`);
} finally {
  spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
  if (failed) process.exitCode = 1;
}
