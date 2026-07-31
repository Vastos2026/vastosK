/**
 * Serves generated images/video back to the browser by storage key. Every
 * generation route (design-plan images, edits, walkthrough clips) stores
 * bytes under "renders/<projectId>/..." via the shared storage layer and
 * points the client here instead of depending on a provider's short-lived
 * output URL.
 *
 * Requires a valid session AND (when Supabase is configured) per-asset
 * ownership — see the `requireOwnedKey` check in GET below, same
 * degrade-gracefully-without-Supabase posture as /api/export-pdf.
 *
 *   GET /api/render?key=renders/...
 */

import { getObject, servedStorageResponse } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedKey } from "@/lib/supabase/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // No same-origin/rate-limit check: a GET with no state change, and images
  // are legitimately requested via <img src> from any same-session tab.
  const guard = await assertAllowed(request, { checkOrigin: false });
  if (guard instanceof Response) return guard;

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "key required" }, { status: 400 });
  // "renders/" = generated room images/video; "plans/" = uploaded floor-plan
  // source images (see /api/parse-plan/route.ts) — the only two prefixes this
  // route ever writes.
  if (!key.startsWith("renders/") && !key.startsWith("plans/")) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  // Per-asset ownership check: without this, any authenticated caller could
  // read ANY other user's images just by supplying their storage key (a real
  // cross-tenant data leak found in review — keys are predictable
  // `renders/<projectId>/<uuid>.<ext>` / `plans/<uuid>/<name>` shapes, and
  // this route only ever received a bare `key`, no `projectId`, to check
  // against). `requireOwnedKey` parses the project id back out of a
  // `renders/<projectId>/...` key for a single targeted lookup (this is the
  // hottest route in the app — every thumbnail/version/preview/video goes
  // through it, so a full scan of every project on every request would be
  // wasteful), falling back to scanning the caller's own project_snapshots
  // rows only for `plans/` keys (no project id embedded in that shape).
  // When Supabase isn't configured there's no persistence layer and thus no
  // cross-user data to leak — degrade to allowing it, matching this app's
  // existing "best-effort, works without Supabase" contract (same as
  // /api/export-pdf's ownership check).
  const owned = await requireOwnedKey(guard.id, key);
  if (owned instanceof Response) return owned;

  try {
    const bytes = await getObject(key);
    return servedStorageResponse(bytes, key);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
