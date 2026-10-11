import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { HEADING_LIMIT, LINK_LIMIT, auditCatalog, catalogDocument } from '../agent/lib/document-catalog.ts';
import { externalAccepts } from '../agent/lib/container-egress.ts';
import { startIsolatedNetwork } from '../agent/lib/egress-proxy.ts';
import { publicAddress } from '../agent/lib/public-address.ts';
import { STRUCTURED_DOCUMENT_URL, acceptStructuredCapture, structuredFetchCommand } from './structured-document.ts';

type Policy = {
  enforced: boolean;
  pilot: string;
  publicBrowserPilot: boolean;
  localFixture: boolean;
  exampleRead: unknown;
  structuredRead: { host: string; address: string; port: number; answers: string[] } | null;
  ipv4: string;
  ipv6: string;
};

const started = Date.now();
const evidence = '/evidence';
mkdirSync(evidence, { recursive: true });

function event(name: string, outcome: string, error = ''): void {
  const line = `${new Date().toISOString()} ${name} docs.python.org ${outcome}${error ? ` ${error}` : ''}\n`;
  appendFileSync(`${evidence}/events.log`, line);
}

const policy = JSON.parse(readFileSync('/run/rove/egress-policy.json', 'utf8')) as Policy;
const pin = policy.structuredRead;
const rules = `${policy.ipv4}\n${policy.ipv6}`;
const accepts = externalAccepts(rules);
if (!policy.enforced || policy.pilot !== 'off' || policy.publicBrowserPilot || policy.localFixture || policy.exampleRead || !pin ||
  pin.host !== 'docs.python.org' || pin.port !== 443 || !publicAddress(pin.address) ||
  !pin.answers.includes(pin.address) || accepts.length !== 2 ||
  accepts.some(line => !line.includes(pin.address) || !line.includes('-p tcp') || !line.includes('443') || !line.includes('rove-structured'))) {
  event('policy', 'violation', 'pin');
  throw new Error('Structured read pin was not installed.');
}
const family = isIP(pin.address);
if (family !== 4 && family !== 6) throw new Error('Structured read pin was not installed.');
if (existsSync(`${evidence}/result.json`)) {
  const prior = JSON.parse(readFileSync(`${evidence}/result.json`, 'utf8')) as { status?: number; dials?: unknown[] };
  if (prior.status || (prior.dials?.length ?? 0) > 0) {
    event('fetch', 'refused', 'already-attempted');
    throw new Error('Structured document GET already attempted.');
  }
}
const command = structuredFetchCommand(pin.address, family);
event('policy', 'pass', pin.address);

const network = await startIsolatedNetwork();
const fetchStarted = Date.now();
try {
  const document = await network.request(command);
  const fetchMs = Date.now() - fetchStarted;
  const html = document.body.toString('utf8');
  const catalog = catalogDocument(html, STRUCTURED_DOCUMENT_URL);
  const audit = auditCatalog(html, STRUCTURED_DOCUMENT_URL, catalog);
  const location = document.headers.location ?? '';
  const captured = acceptStructuredCapture({
    status: document.status,
    address: pin.address,
    dials: network.dials,
    auditPass: audit.pass,
    location,
  });
  const reliability = {
    pass: audit.pass,
    mismatches: audit.mismatches,
    headings: catalog.headings.length,
    links: catalog.links.length,
    headingLimit: HEADING_LIMIT,
    linkLimit: LINK_LIMIT,
    atHeadingLimit: catalog.headings.length >= HEADING_LIMIT,
    atLinkLimit: catalog.links.length >= LINK_LIMIT,
    sha256: createHash('sha256').update(document.body).digest('hex'),
  };
  writeFileSync(`${evidence}/document.html`, document.body);
  writeFileSync(`${evidence}/catalog.json`, JSON.stringify(catalog, null, 2));
  writeFileSync(`${evidence}/reliability.json`, JSON.stringify(reliability, null, 2));
  writeFileSync(`${evidence}/result.json`, JSON.stringify({
    url: STRUCTURED_DOCUMENT_URL,
    address: pin.address,
    family,
    status: document.status,
    contentType: document.headers['content-type'] ?? '',
    location,
    title: catalog.title,
    bytes: document.body.length,
    sha256: reliability.sha256,
    timingMs: { total: Date.now() - started, fetch: fetchMs },
    dials: network.dials,
    request: command,
    policy: { pilot: policy.pilot, publicBrowserPilot: false, accepts: accepts.length },
  }, null, 2));
  writeFileSync(`${evidence}/plan.json`, JSON.stringify({
    decision: captured ? 'captured' : 'failed',
    url: STRUCTURED_DOCUMENT_URL,
    path: command.path,
    address: pin.address,
    readOnly: true,
    requests: network.dials.length,
    prohibited: ['click', 'form', 'authentication', 'purchase', 'customer-access', 'deploy', 'paid-api'],
  }, null, 2));
  if (!captured) {
    event('fetch', 'fail', `status=${document.status} audit=${audit.pass} dials=${network.dials.length}`);
    process.exit(1);
  }
  event('fetch', 'pass', `status=${document.status}`);
  event('audit', 'pass', `headings=${catalog.headings.length} links=${catalog.links.length}`);
  process.stdout.write('Structured document fetch passed\n');
} catch (error) {
  event('fetch', 'fail', error instanceof Error ? error.message : 'fetch');
  throw error;
} finally {
  await network.close();
}
