/**
 * Minimal in-memory per-key rate limiter (revamp plan, "Security" section) —
 * an abuse/cost-control safeguard for AI-triggering routes. Deliberately
 * dependency-free: a Map keyed by e.g. `${route}:${userId}`, holding recent
 * request timestamps. Resets on server restart and isn't shared across
 * instances in a multi-process deploy — both acceptable for MVP scale per the
 * plan's own "lightweight" framing.
 */
const hits = new Map<string, number[]>(); // key -> timestamps (ms) within the current window

/** Returns true if the request should be allowed, false if the caller is over the limit. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= limit) {
    hits.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}
