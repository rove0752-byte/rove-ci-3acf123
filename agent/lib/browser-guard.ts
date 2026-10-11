import { defineState } from 'eve/context';

export const PAGE_LIMIT = 3;
export type BrowserAccess = { host: string | null; count: number };
export type BrowserDecision =
  | { type: 'allow'; host: string; count: number }
  | { type: 'approve' }
  | { type: 'deny'; reason: string };

function hostOf(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

// The first host is kept after a cross-host approval, so a later page on that other host asks again.
export function decideBrowserAccess(state: BrowserAccess, rawUrl: string, limit = PAGE_LIMIT): BrowserDecision {
  const host = hostOf(rawUrl);
  if (!host) return { type: 'deny', reason: 'Only public HTTP(S) URLs on standard ports are supported.' };
  if (state.count >= limit) return { type: 'deny', reason: 'Page limit reached for this session.' };
  if (state.host && state.host !== host) return { type: 'approve' };
  return { type: 'allow', host: state.host ?? host, count: state.count + 1 };
}

export function recordBrowserFetch(state: BrowserAccess, rawUrl: string, limit = PAGE_LIMIT): BrowserAccess {
  const decision = decideBrowserAccess(state, rawUrl, limit);
  if (decision.type === 'deny') throw new Error(decision.reason);
  if (decision.type === 'approve') return { host: state.host, count: state.count + 1 };
  return { host: decision.host, count: decision.count };
}

export function approvalDecision(state: BrowserAccess, rawUrl: string | undefined) {
  const decision = decideBrowserAccess(state, rawUrl ?? '');
  if (decision.type === 'deny') return { type: 'denied' as const, reason: decision.reason };
  if (decision.type === 'approve') return 'user-approval' as const;
  return 'not-applicable' as const;
}

export type BrowserClaim = { key: string; url: string; status: 'pending' | 'consumed' };
export type GateState = BrowserAccess & { claims?: BrowserClaim[] };
export type BrowserStore = {
  get: (sessionId: string) => GateState;
  update: (sessionId: string, fn: (state: GateState) => GateState) => void;
};
export type BrowserApproval = 'not-applicable' | 'user-approval' | { type: 'denied'; reason: string };

const CLAIM_LIMIT = 24;

function claimKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

function claimsOf(state: GateState): BrowserClaim[] {
  return Array.isArray(state.claims) ? state.claims : [];
}

// An abandoned pending claim still consumes its page slot. Dropping one makes a later
// reserve count again, which fails closed against the three-page cap.
function remember(claims: readonly BrowserClaim[], claim: BrowserClaim): BrowserClaim[] {
  const next = [...claims, claim];
  if (next.length <= CLAIM_LIMIT) return next;
  const consumed = next.findIndex(item => item.status === 'consumed');
  if (consumed < 0) return next.slice(next.length - CLAIM_LIMIT);
  const trimmed = next.slice();
  trimmed.splice(consumed, 1);
  return trimmed;
}

// Approval used to read the counter and execute wrote it later. Parallel approvals could
// both observe an empty host. The gate writes the allow inside one serialized turn and
// reserve consumes that claim instead of incrementing a second time.
export function createSerializedBrowserGate(store: BrowserStore) {
  let chain: Promise<void> = Promise.resolve();
  function exclusive<T>(work: () => T): Promise<T> {
    const run = chain.then(() => work());
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function decide(rawUrl: string | undefined, callId: string, sessionId: string): Promise<BrowserApproval> {
    return exclusive(() => {
      if (!callId || !sessionId) return { type: 'denied', reason: 'Browser page reservation requires a session.' };
      const key = claimKey(sessionId, callId);
      const url = rawUrl ?? '';
      let result: BrowserApproval = { type: 'denied', reason: 'Only public HTTP(S) URLs on standard ports are supported.' };
      store.update(sessionId, state => {
        const claims = claimsOf(state);
        const existing = claims.find(claim => claim.key === key);
        if (existing) {
          result = existing.url === url ? 'not-applicable' : { type: 'denied', reason: 'Reserved document does not match the approved URL.' };
          return state;
        }
        const decision = decideBrowserAccess(state, url);
        if (decision.type === 'deny') {
          result = { type: 'denied', reason: decision.reason };
          return state;
        }
        if (decision.type === 'approve') {
          result = 'user-approval';
          return state;
        }
        result = 'not-applicable';
        return { host: decision.host, count: decision.count, claims: remember(claims, { key, url, status: 'pending' }) };
      });
      return result;
    });
  }

  function reserve(rawUrl: string, callId: string, sessionId: string): Promise<void> {
    return exclusive(() => {
      if (!callId || !sessionId) throw new Error('Browser page reservation requires a session.');
      const key = claimKey(sessionId, callId);
      let denied: Error | undefined;
      store.update(sessionId, state => {
        const claims = claimsOf(state);
        const existing = claims.find(claim => claim.key === key);
        if (existing) {
          if (existing.url !== rawUrl) {
            denied = new Error('Reserved document does not match the approved URL.');
            return state;
          }
          if (existing.status === 'consumed') return state;
          return { host: state.host, count: state.count, claims: claims.map(claim => claim.key === key ? { ...claim, status: 'consumed' as const } : claim) };
        }
        try {
          const next = recordBrowserFetch(state, rawUrl);
          return { host: next.host, count: next.count, claims: remember(claims, { key, url: rawUrl, status: 'consumed' }) };
        } catch (error) {
          denied = error instanceof Error ? error : new Error('Page limit reached for this session.');
          return state;
        }
      });
      if (denied) throw denied;
    });
  }

  return { decide, reserve, read: (sessionId: string) => store.get(sessionId) };
}

export const browserPages = defineState('rove.browser.pages', (): GateState => ({ host: null, count: 0, claims: [] }));

const browserGate = createSerializedBrowserGate({
  get: () => browserPages.get(),
  update: (_sessionId, fn) => { browserPages.update(fn); },
});

export function approvalForBrowser(rawUrl: string | undefined, callId: string, sessionId: string) {
  return browserGate.decide(rawUrl, callId, sessionId);
}

export function reserveBrowserPage(rawUrl: string, callId: string, sessionId: string) {
  return browserGate.reserve(rawUrl, callId, sessionId);
}
