/**
 * Same-origin check for state-changing API routes (revamp plan, "Security"
 * section) — this app is cookie-session-based, so a same-origin Origin/
 * Referer check is meaningful defense-in-depth against CSRF even without a
 * dedicated token. Not the only layer (Supabase's cookie handling and the
 * per-route auth check matter too) — just one more.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // some non-browser/same-origin clients omit Origin; don't over-block
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
