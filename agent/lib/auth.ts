import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthResult = { ok: true; principal: string } | { ok: false; status: 401 };
type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True only for a loopback socket peer address. Never consult Host or forwarding headers. */
export function isLoopbackAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK.has(ip.replace(/^\[|\]$/g, '').toLowerCase());
}

/** Stable, non-reversible principal id for a credential. */
export function principalFor(key: string): string {
  return 'key:' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Decide whether a request may use the API.
 * - With ROVE_API_KEY set: constant-time Bearer comparison only.
 * - Without it: deny, unless ROVE_DEV_NO_AUTH=1, NODE_ENV is not production,
 *   and the socket peer (requestIp) is loopback. The Host header is ignored.
 */
export function authorize(req: Request, requestIp: string | null, env: Env = process.env): AuthResult {
  const key = env.ROVE_API_KEY;
  if (key) {
    const actual = Buffer.from(req.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${key}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? { ok: true, principal: principalFor(key) }
      : { ok: false, status: 401 };
  }
  if (env.NODE_ENV === 'production') return { ok: false, status: 401 };
  if (env.ROVE_DEV_NO_AUTH === '1' && isLoopbackAddress(requestIp)) return { ok: true, principal: 'dev:loopback' };
  return { ok: false, status: 401 };
}

/**
 * Records which principal created each session. In-memory: ownership is lost on
 * restart and is not shared across instances; unknown sessions are rejected (fail closed).
 */
export class SessionOwners {
  #owners = new Map<string, string>();
  #max: number;
  constructor(max = 10_000) { this.#max = max; }
  bind(sessionId: string, principal: string): void {
    if (this.#owners.size >= this.#max) this.#owners.delete(this.#owners.keys().next().value as string);
    this.#owners.set(sessionId, principal);
  }
  /** 'ok' if owned by principal, otherwise 'forbidden' (including unknown sessions). */
  check(sessionId: string, principal: string): 'ok' | 'forbidden' {
    return this.#owners.get(sessionId) === principal ? 'ok' : 'forbidden';
  }
}
