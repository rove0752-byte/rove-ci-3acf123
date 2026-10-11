import { fileURLToPath } from 'node:url';
import { PUBLIC_BROWSER_PILOT_ENABLED } from '../agent/lib/container-egress.ts';
import { LIVE_PILOT_ENABLED, PILOT_TIMEOUTS } from './readonly-pilot.ts';

export const STRUCTURED_PILOT_ENABLED = false;
export const STRUCTURED_PILOT_CANDIDATE = 'https://docs.python.org/3/';
const DISABLED = 'Structured public pilot is disabled.';

export type StructuredPlan = {
  decision: 'NO-GO';
  reason: string;
  requestedUrl: string | null;
  approvedHost: null;
  execute: false;
  publicBrowserPilot: false;
  structuredPilot: false;
  livePilot: false;
  isolation: 'dedicated-container';
  readOnly: true;
  extracts: readonly ['title', 'headings', 'links', 'metadata'];
  reliability: string;
  prohibited: readonly string[];
  timeouts: typeof PILOT_TIMEOUTS;
  logging: { path: string; fields: readonly string[] };
  evidence: { directory: string; files: readonly string[] };
  failure: { timeout: string; policy: string; network: string; mismatch: string; partial: false };
  candidateUrl: typeof STRUCTURED_PILOT_CANDIDATE;
  documentGet: false;
  pin: {
    host: 'docs.python.org';
    port: 443;
    transport: 'tcp';
    scope: 'one-current-public-address';
    applies: boolean;
  };
  blocker: string;
  approvalsRequired: readonly string[];
};

function requestedUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw !== raw.trim() || /\s/.test(raw)) throw new Error('Structured pilot requires one https URL.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Structured pilot requires one https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) {
    throw new Error('Structured pilot requires one https URL.');
  }
  return url.href;
}

export function prepareStructuredPilot(raw?: string): StructuredPlan {
  if (PUBLIC_BROWSER_PILOT_ENABLED || STRUCTURED_PILOT_ENABLED || LIVE_PILOT_ENABLED) throw new Error(DISABLED);
  const requested = requestedUrl(raw);
  const candidate = requested === STRUCTURED_PILOT_CANDIDATE;
  return {
    decision: 'NO-GO',
    reason: DISABLED,
    requestedUrl: requested,
    approvedHost: null,
    execute: false,
    publicBrowserPilot: false,
    structuredPilot: false,
    livePilot: false,
    isolation: 'dedicated-container',
    readOnly: true,
    extracts: ['title', 'headings', 'links', 'metadata'],
    reliability: 'Compare title, headings, links, and metadata with the retrieved document. A mismatch is a failure.',
    prohibited: ['click', 'form', 'authentication', 'purchase', 'customer-access', 'deploy', 'paid-api'],
    candidateUrl: STRUCTURED_PILOT_CANDIDATE,
    documentGet: false,
    pin: {
      host: 'docs.python.org',
      port: 443,
      transport: 'tcp',
      scope: 'one-current-public-address',
      applies: candidate,
    },
    timeouts: PILOT_TIMEOUTS,
    logging: {
      path: 'reports/readonly-pilot/structured/events.log',
      fields: ['time', 'event', 'host', 'outcome', 'error'],
    },
    evidence: {
      directory: 'reports/readonly-pilot/structured',
      files: ['plan.json', 'events.log', 'result.json', 'catalog.json', 'reliability.json'],
    },
    failure: {
      timeout: 'Browser operation timed out. Record the error and do not report success.',
      policy: 'Reject an unapproved host before navigation and do not report success.',
      network: 'Navigation failed. Record the error and do not report success.',
      mismatch: 'Extracted fields differ from the retrieved document. Record the mismatch and do not report success.',
      partial: false,
    },
    blocker: candidate
      ? 'The docs.python.org TCP/443 pin does not approve a document GET. https://docs.python.org/3/ still needs an explicit read-only approval.'
      : 'No second public host is approved. The example.com pin does not authorize another fetch or another host.',
    approvalsRequired: candidate
      ? [
          'Approve one read-only GET of https://docs.python.org/3/ and no other URL.',
          'Use the reviewed docs.python.org pin: one current public address, TCP/443 only, through scripts/container-egress-launch.sh.',
          'Require the catalog to match an independent audit of that retrieved document before accepting the result.',
        ]
      : [
          'Approve one new https URL for a single read-only fetch.',
          'Approve a new reviewed container pin for that host on TCP/443 only.',
          'Require the catalog to match the retrieved document before accepting the result.',
        ],
  };
}

function main(): void {
  if (process.argv.includes('--execute')) throw new Error(DISABLED);
  const flag = process.argv.indexOf('--url');
  const raw = flag === -1 ? undefined : process.argv[flag + 1];
  const plan = prepareStructuredPilot(raw);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\nstructured pilot prepare passed\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Structured pilot prepare failed.'}\n`);
    process.exit(2);
  }
}
