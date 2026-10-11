import { fileURLToPath } from 'node:url';
import { PUBLIC_BROWSER_PILOT_ENABLED } from '../agent/lib/container-egress.ts';
import { classifyBrowserAction, LIVE_SIDE_EFFECT_ERROR } from '../agent/lib/action-contract.ts';

export const LIVE_PILOT_ENABLED = false;
export const PILOT_CANDIDATE = 'https://example.com/';
const DISABLED = 'Live public-website pilot is disabled.';
const SESSION = '00000000-0000-4000-8000-000000000001';

export const PILOT_TIMEOUTS = {
  launchMs: 10_000,
  navigationMs: 20_000,
  totalMs: 30_000,
  maxRedirects: 5,
  maxDocumentBytes: 1_048_576,
  pages: 1,
} as const;

export type PilotPlan = {
  decision: 'NO-GO';
  reason: typeof DISABLED;
  url: typeof PILOT_CANDIDATE;
  host: 'example.com';
  execute: false;
  publicBrowserPilot: false;
  livePilot: false;
  isolation: 'dedicated-container';
  entrypoint: 'scripts/container-egress-launch.sh';
  readOnly: true;
  prohibited: ['click', 'form', 'authentication', 'purchase', 'customer-access', 'deploy', 'paid-api'];
  timeouts: typeof PILOT_TIMEOUTS;
  logging: { path: string; fields: readonly string[] };
  evidence: { directory: string; files: readonly string[] };
  failure: { timeout: string; policy: string; network: string; partial: false };
  blocker: string;
  approvalsRequired: readonly string[];
};

function assertReadOnly(): void {
  for (const action of ['submit', 'purchase', 'authenticate'] as const) {
    const decision = classifyBrowserAction({ action, sessionId: SESSION });
    if (decision.disposition !== 'approval-required') throw new Error(LIVE_SIDE_EFFECT_ERROR);
  }
}

export function prepareReadonlyPilot(raw: string): PilotPlan {
  if (PUBLIC_BROWSER_PILOT_ENABLED || LIVE_PILOT_ENABLED) throw new Error(DISABLED);
  if (typeof raw !== 'string' || raw !== raw.trim() || /\s/.test(raw)) throw new Error('Pilot candidate must be one https URL.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Pilot candidate must be one https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) {
    throw new Error('Pilot candidate must be one https URL.');
  }
  if (url.href !== PILOT_CANDIDATE) throw new Error('Pilot candidate must be https://example.com/.');
  assertReadOnly();
  return {
    decision: 'NO-GO',
    reason: DISABLED,
    url: PILOT_CANDIDATE,
    host: 'example.com',
    execute: false,
    publicBrowserPilot: false,
    livePilot: false,
    isolation: 'dedicated-container',
    entrypoint: 'scripts/container-egress-launch.sh',
    readOnly: true,
    prohibited: ['click', 'form', 'authentication', 'purchase', 'customer-access', 'deploy', 'paid-api'],
    timeouts: PILOT_TIMEOUTS,
    logging: {
      path: 'reports/readonly-pilot/example.com/events.log',
      fields: ['time', 'event', 'host', 'outcome', 'error'],
    },
    evidence: {
      directory: 'reports/readonly-pilot/example.com',
      files: ['plan.json', 'events.log', 'result.json'],
    },
    failure: {
      timeout: 'Browser operation timed out. Close the browser and record the error.',
      policy: 'Reject the URL before navigation and do not report success.',
      network: 'Navigation failed. Record the error and do not report success.',
      partial: false,
    },
    blocker: 'Container policy refuses a public address. A live fetch needs a separate reviewed TCP/443 pin.',
    approvalsRequired: [
      'Approve a live read-only fetch of https://example.com/ and no other site.',
      'Approve a reviewed container pin for that page on TCP/443 only.',
      'Run the fetch through scripts/container-egress-launch.sh in a dedicated container.',
    ],
  };
}

function main(): void {
  if (process.argv.includes('--execute')) throw new Error(DISABLED);
  const flag = process.argv.indexOf('--url');
  const raw = flag === -1 ? PILOT_CANDIDATE : process.argv[flag + 1] ?? '';
  const plan = prepareReadonlyPilot(raw);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\nreadonly pilot prepare passed\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Pilot prepare failed.'}\n`);
    process.exit(2);
  }
}
