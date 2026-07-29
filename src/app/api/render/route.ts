/**
 * Serves generated images/video back to the browser by storage key. Every
 * generation route (design-plan images, edits, walkthrough clips) stores
 * bytes under "renders/<projectId>/..." via the shared storage layer and
 * points the client here instead of depending on a provider's short-lived
 * output URL.
 *
 *   GET /api/render?key=renders/...
 */

import { getObject, servedStorageResponse } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Requires a valid session, but not yet per-asset ownership (this route
  // doesn't check that the requesting user's project owns this key) — that
  // needs the real projects/generations ownership wiring, out of scope here.
  // No same-origin/rate-limit check: a GET with no state change, and images
  // are legitimately requested via <img src> from any same-session tab.
  const guard = await assertAllowed(request, { checkOrigin: false });
  if (guard instanceof Response) return guard;

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "key required" }, { status: 400 });
  if (!key.startsWith("renders/")) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  try {
    const bytes = await getObject(key);
    return servedStorageResponse(bytes, key);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
