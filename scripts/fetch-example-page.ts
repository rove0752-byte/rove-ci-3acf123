import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { externalAccepts } from '../agent/lib/container-egress.ts';
import { startIsolatedNetwork } from '../agent/lib/egress-proxy.ts';
import { publicAddress } from '../agent/lib/public-address.ts';

type Policy = {
  enforced: boolean;
  pilot: string;
  publicBrowserPilot: boolean;
  localFixture: boolean;
  exampleRead: { host: string; address: string; port: number; answers: string[] } | null;
  ipv4: string;
  ipv6: string;
};

const started = Date.now();
const evidence = '/evidence';
mkdirSync(evidence, { recursive: true });

function event(name: string, outcome: string, error = ''): void {
  const line = `${new Date().toISOString()} ${name} example.com ${outcome}${error ? ` ${error}` : ''}\n`;
  appendFileSync(`${evidence}/events.log`, line);
}

const policy = JSON.parse(readFileSync('/run/rove/egress-policy.json', 'utf8')) as Policy;
const pin = policy.exampleRead;
const rules = `${policy.ipv4}\n${policy.ipv6}`;
const accepts = externalAccepts(rules);
if (!policy.enforced || policy.pilot !== 'off' || policy.publicBrowserPilot || policy.localFixture || !pin ||
  pin.host !== 'example.com' || pin.port !== 443 || !publicAddress(pin.address) ||
  accepts.length !== 2 || accepts.some(line => !line.includes(pin.address) || !line.includes('-p tcp') || !line.includes('443'))) {
  event('policy', 'violation', 'pin');
  throw new Error('Example read pin was not installed.');
}
const family = isIP(pin.address);
if (family !== 4 && family !== 6) throw new Error('Example read pin was not installed.');
event('policy', 'pass', pin.address);

const network = await startIsolatedNetwork();
const fetchStarted = Date.now();
try {
  const document = await network.request({
    op: 'fetch',
    address: pin.address,
    family,
    port: 443,
    https: true,
    servername: 'example.com',
    hostHeader: 'example.com',
    path: '/',
    timeoutMs: 20_000,
  });
  const fetchMs = Date.now() - fetchStarted;
  const html = document.body.toString('utf8');
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  const result = {
    url: 'https://example.com/',
    address: pin.address,
    family,
    status: document.status,
    title,
    text,
    bytes: document.body.length,
    sha256: createHash('sha256').update(document.body).digest('hex'),
    timingMs: { total: Date.now() - started, fetch: fetchMs },
    dials: network.dials,
    policy: { pilot: policy.pilot, publicBrowserPilot: false, accepts: accepts.length },
  };
  writeFileSync(`${evidence}/result.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${evidence}/plan.json`, JSON.stringify({
    decision: document.status === 200 && title ? 'captured' : 'failed',
    url: result.url,
    address: pin.address,
    readOnly: true,
    prohibited: ['click', 'form', 'authentication', 'purchase', 'customer-access', 'deploy', 'paid-api'],
  }, null, 2));
  if (document.status !== 200 || !title || network.dials.length !== 1 || network.dials[0]?.address !== pin.address || network.dials[0]?.port !== 443) {
    event('fetch', 'fail', `status=${document.status}`);
    process.exit(1);
  }
  event('fetch', 'pass', `status=${document.status}`);
  process.stdout.write('Example page fetch passed\n');
} catch (error) {
  event('fetch', 'fail', error instanceof Error ? error.message : 'fetch');
  throw error;
} finally {
  await network.close();
}
