/** PRD §31, §41: process-local abuse budgets. A generic request-counting plugin
 * cannot count only 401s or exempt known sessions from the address bucket.
 * Fixed windows give exact whole-second retries, unlike fractional token refill.
 * ponytail: one API process; distributed limits require shared atomic counters.
 * Windows can admit 2N across a boundary. Calls here are synchronous. An unknown
 * admission holds an in-flight slot in its address bucket until the caller's
 * release(), so completed failures plus in-flight unknown authentications never
 * exceed the address budget. A failure keeps its slot until the window ends; a
 * success or a thrown authentication frees it. A new session's concurrent first
 * requests stay unknown until one authenticates, so they overshoot its session
 * budget by at most the address budget. pending holds only addresses with an
 * authentication in flight, so concurrent requests bound it and it needs no key
 * cap. No credential plaintext is held.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_KEYS = 10_000;
export interface RateLimitSettings {
  readonly perSessionPerMinute: number;
  readonly authFailuresPerAddressPerMinute: number;
}
export const DEFAULT_RATE_LIMITS: RateLimitSettings = Object.freeze({
  perSessionPerMinute: 600, authFailuresPerAddressPerMinute: 30,
});
export type RateLimitBucket = 'session' | 'authentication';
export type RateLimitVerdict =
  | { kind: 'refused'; bucket: RateLimitBucket; retryAfterSeconds: number }
  | { kind: 'counted' } | { kind: 'unknown' };

export function parseRateLimit(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(value) || value.trim() !== value) throw new Error('CONFIG_INVALID:' + name);
  return Number(value);
}

export function createRateLimiter(settings: RateLimitSettings, clock: () => number = Date.now) {
  const known = new Set<string>(), sessions = new Map<string, number>(), failures = new Map<string, number>();
  // In-flight unknown authentications per address. Never window-scoped: a call still runs after the window turns.
  const pending = new Map<string, number>();
  let window = -1;
  function refresh() {
    const now = clock(), next = Math.floor(now / RATE_LIMIT_WINDOW_MS);
    if (next !== window) { window = next; sessions.clear(); failures.clear(); }
    return Math.max(1, Math.ceil(((window + 1) * RATE_LIMIT_WINDOW_MS - now) / 1000));
  }
  function admit(hash: string | null, address: string): RateLimitVerdict {
    const retryAfterSeconds = refresh();
    if (hash !== null && known.has(hash)) {
      const count = sessions.get(hash) ?? 0;
      if (count >= settings.perSessionPerMinute) return { kind: 'refused', bucket: 'session', retryAfterSeconds };
      sessions.set(hash, count + 1);
      return { kind: 'counted' };
    }
    const inFlight = pending.get(address) ?? 0;
    if ((failures.get(address) ?? 0) + inFlight >= settings.authFailuresPerAddressPerMinute ||
        (failures.size >= RATE_LIMIT_MAX_KEYS && !failures.has(address))) {
      return { kind: 'refused', bucket: 'authentication', retryAfterSeconds };
    }
    pending.set(address, inFlight + 1);
    return { kind: 'unknown' };
  }
  /** Frees the slot of one {kind:'unknown'} admission once its authentication settles. */
  function release(address: string) {
    const inFlight = pending.get(address);
    if (inFlight === undefined) return;
    if (inFlight <= 1) pending.delete(address); else pending.set(address, inFlight - 1);
  }
  function authenticated(hash: string | null) {
    refresh();
    if (hash === null) return;
    // Bound session counts too: repeated cache turnover must not accumulate keys.
    if (!known.has(hash) && (known.size >= RATE_LIMIT_MAX_KEYS || sessions.size >= RATE_LIMIT_MAX_KEYS)) {
      known.clear(); sessions.clear();
    }
    known.add(hash);
    sessions.set(hash, (sessions.get(hash) ?? 0) + 1);
  }
  function failed(hash: string | null, address: string) {
    refresh();
    if (hash !== null) known.delete(hash);
    // In-flight authentications may finish after the address map filled.
    if (failures.has(address) || failures.size < RATE_LIMIT_MAX_KEYS) failures.set(address, (failures.get(address) ?? 0) + 1);
  }
  return { admit, authenticated, failed, release };
}
