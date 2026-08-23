/**
 * Approve → Enhance — one-shot whole-image enhance of an approved room photo.
 * Image-to-image (the entire photograph as a single reference image), NOT a
 * masked/cropped edit like `/api/edit-room-image` — material/lighting quality
 * is raised and the room's finishing layer (rug, cushions, art, plants, etc.)
 * is filled in, while camera, proportions, wall/opening positions, wall
 * colour and every existing furniture piece stay pixel-identical (enforced
 * by the prompt itself — see `provider.ts`'s `buildEnhancePrompt`).
 *
 * Modeled closely on `/api/edit-room-image/route.ts`: same `assertAllowed`
 * guard shape, same rate-limit style, same ownership check on
 * `baseImageKey` (`requireOwnedProject` + `allProjectStorageKeys`), same
 * `toErrorResponse` handling, same storage write + response shape.
 *
 *   POST /api/enhance-room-image
 *     { projectId, baseImageKey, styleId? }
 *     → { imageUrl, key }
 */

import { randomUUID } from "node:crypto";
import { enhanceImage } from "@/lib/ai/provider";
import { toErrorResponse } from "@/lib/ai/errors";
import { getObject, putObject } from "@/lib/pipeline/storage";
import { STYLE_BY_ID } from "@/lib/data";
import { recordGeneration } from "@/lib/supabase/generations";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedProject } from "@/lib/supabase/projects";
import { allProjectStorageKeys } from "@/lib/projects/approved-rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

interface Body {
  projectId?: string;
  baseImageKey?: string;
  styleId?: string;
}

export async function POST(request: Request) {
  // A single paid whole-image call per request — same rate-limit shape as
  // edit-room-image's per-region cost (up to 2 calls there vs. exactly 1 here).
  const guard = await assertAllowed(request, {
    rateLimit: { key: "enhance-room-image", limit: 8, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId, baseImageKey, styleId } = body;
  if (!projectId || !baseImageKey) {
    return Response.json({ error: "projectId and baseImageKey are required" }, { status: 400 });
  }
  if (!baseImageKey.startsWith("renders/")) {
    return Response.json({ error: "Invalid baseImageKey" }, { status: 400 });
  }

  const owned = await requireOwnedProject(guard.id, projectId);
  if (owned instanceof Response) return owned;
  if (owned && !allProjectStorageKeys(owned).has(baseImageKey)) {
    return Response.json({ error: "Image not found or not owned by you" }, { status: 403 });
  }

  // Unlike edit-room-image, an unresolved style is left `undefined` here
  // (not defaulted to STYLES[0]) — buildEnhancePrompt only appends the style
  // clause when a style actually resolved, per that function's own contract.
  const style = styleId ? STYLE_BY_ID[styleId] : undefined;

  try {
    const baseBytes = await getObject(baseImageKey);
    const baseDataUri = `data:image/png;base64,${baseBytes.toString("base64")}`;

    const enhanced = await enhanceImage(baseDataUri, style, { projectId, userId: guard.id });

    const key = `renders/${projectId}/${randomUUID()}.png`;
    await putObject(key, enhanced.bytes, "image/png");
    const imageUrl = `/api/render?key=${encodeURIComponent(key)}`;
    // Awaited, not fire-and-forget — see edit-room-image/route.ts's identical
    // comment: /api/render's ownership check reads this row to authorize a
    // just-created image immediately, instead of waiting on the client's
    // debounced project-snapshot sync.
    //
    // Recorded as type "edit" — ai/usage-log.ts and the `generations` table
    // have no dedicated "enhance" value, and this is the same edit-shaped
    // operation family as the lasso edit.
    await recordGeneration({ projectId, userId: guard.id, type: "edit", storageUrl: imageUrl });
    return Response.json({ imageUrl, key });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Enhance");
    return Response.json(body, { status });
  }
}
