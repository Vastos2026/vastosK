/**
 * Design reference analysis — the Design page's "Upload design reference".
 * Accepts a photo of an interior the user wants their project to look like
 * and returns the six design-look attributes read off it, plus a small
 * thumbnail so the UI can show which reference is active.
 *
 *   POST /api/design-reference  (multipart: file, projectId)
 *     → { attributes, thumbnail, hash }
 *
 * Runs ONCE per uploaded image. The caller caches the response on the project
 * (Project.designReference) and sends `attributes` back with the design plan,
 * so nothing here is re-run per generation — see design-reference.ts.
 *
 * The uploaded bytes are deliberately NOT persisted to object storage. The
 * only thing the app needs afterwards is a small preview of what the user
 * picked, and a stored key would mean a new `renders/<projectId>/...` prefix
 * plus the ownership plumbing that goes with it (requireOwnedKey's
 * generations-row / snapshot-scan pair, and the 800ms-debounced snapshot race
 * that `isRecordedGeneration` exists to work around) for an image no model
 * ever reads again. A downscaled JPEG data URI on the local-first project
 * carries the same information with none of that surface.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { analyseDesignReference } from "@/lib/ai/prompting/design-reference";
import { assertAllowed } from "@/lib/api-guard";
import { toErrorResponse } from "@/lib/ai/errors";
import { requireOwnedProject } from "@/lib/supabase/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same limit /api/parse-plan enforces on its own upload — one number for
// "an image a user may hand this app".
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Preview thumbnail, sized for a localStorage-backed store rather than for
 * looking at closely: 360px long side at JPEG q70 lands in the tens of KB,
 * where the original 20MB upload plainly could not be persisted at all. Best
 * effort — a decode failure here must not lose the analysis that already
 * succeeded and already cost a provider call, so the caller just renders the
 * card without a picture.
 */
async function buildThumbnail(bytes: Buffer): Promise<string | undefined> {
  try {
    const out = await sharp(bytes)
      .resize(360, 360, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  // One Gemini vision call per upload.
  const guard = await assertAllowed(request, {
    rateLimit: { key: "design-reference", limit: 10, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file uploaded" }, { status: 400 });
    }
    // Same validation shape as /api/parse-plan: raster images only, PDFs
    // rejected outright rather than half-handled.
    if (!file.type.startsWith("image/")) {
      return Response.json(
        { error: "Only raster images (PNG/JPG) can be used as a reference. Export PDFs to PNG." },
        { status: 415 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "File too large (max 20MB)" }, { status: 400 });
    }

    const projectIdParam = form.get("projectId");
    const projectId = typeof projectIdParam === "string" && projectIdParam ? projectIdParam : null;
    // Nothing is written against this project here, but it is attached to the
    // ai_usage_logs row below, so a caller must still not be able to bill an
    // analysis to someone else's project id.
    if (projectId) {
      const owned = await requireOwnedProject(guard.id, projectId);
      if (owned instanceof Response) return owned;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const attributes = await analyseDesignReference(bytes, { userId: guard.id, projectId });
    const thumbnail = await buildThumbnail(bytes);
    // Fingerprints the IMAGE, so the Design page's designSignature changes
    // when the reference changes and already-generated rooms are correctly
    // invalidated — exactly as switching style or palette does.
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

    return Response.json({ attributes, thumbnail, hash });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Reference analysis");
    return Response.json(body, { status });
  }
}
