/**
 * Public, unauthenticated asset proxy for a shared walkthrough (`/s/[token]`).
 *
 *   GET /api/s/[token]/asset?key=renders/...
 *
 * Deliberately the one other place (besides the token lookup itself) that
 * serves storage bytes with no session — `/api/render?key=` requires a login
 * (see that route's comment), which is exactly why links copied out of the
 * app never opened for anyone the builder shared them with. This route
 * doesn't skip auth by accident: it's scoped to exactly the keys the token's
 * OWN project data references (its walkthrough's videoKey, or one of its
 * approved rooms' imageKey) — any other `key` is rejected, so this can't
 * become a general unauthenticated storage-read oracle just because someone
 * guesses/observes a `renders/...` path.
 */

import { getObject, servedStorageResponse } from "@/lib/pipeline/storage";
import { getProjectSnapshotByShareToken } from "@/lib/supabase/projects";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // No session on this route by design, so assertAllowed's per-user limiter
  // doesn't apply here — rate-limit per token instead, generous enough for a
  // page that legitimately loads one video + a handful of room images.
  if (!checkRateLimit(`s-asset:${token}`, 120, 60_000)) {
    return Response.json({ error: "Too many requests, please slow down." }, { status: 429 });
  }

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "key required" }, { status: 400 });

  const snapshot = await getProjectSnapshotByShareToken(token);
  if (!snapshot) return Response.json({ error: "Not found" }, { status: 404 });

  const allowedKeys = allowedAssetKeys(snapshot.data);
  if (!allowedKeys.has(key)) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  try {
    const bytes = await getObject(key);
    return servedStorageResponse(bytes, key);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

/** Every storage key this token's project is allowed to read — the allow-list itself. */
function allowedAssetKeys(project: Project): Set<string> {
  const keys = new Set<string>();
  if (project.walkthrough?.videoKey) keys.add(project.walkthrough.videoKey);
  for (const card of project.roomCards) {
    if (!card.included || !card.approvedId) continue;
    const gen = card.generations.find((g) => g.id === card.approvedId);
    if (gen?.imageKey) keys.add(gen.imageKey);
  }
  return keys;
}
