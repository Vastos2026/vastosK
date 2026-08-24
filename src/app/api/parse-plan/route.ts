import sharp from "sharp";
import { runPlanExtraction } from "@/lib/pipeline/extract-plan";
import { putObject } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { toErrorResponse } from "@/lib/ai/errors";
import { recordGeneration } from "@/lib/supabase/generations";
import { requireOwnedProject } from "@/lib/supabase/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extraction is TWO Gemini vision calls back to back (rooms, then opening
// geometry). At 60s a dense plan could not fit both even on a healthy
// network — the second call was routinely what pushed the request over and
// produced the gateway 504 — so the ceiling is raised and the calls are given
// an explicit budget inside it (below) rather than being left unbounded.
export const maxDuration = 120;

/**
 * How long extraction's two Gemini calls may take between them, leaving
 * headroom inside `maxDuration` for the work either side (form parse, sharp
 * normalise, putObject, recordGeneration) plus the platform's own overhead.
 *
 * This is what stops a bad network minute becoming a gateway 504: the Gemini
 * ladder is otherwise unbounded (see gemini-client's DEFAULT_DEADLINE_MS),
 * so it would happily still be retrying long after the platform had killed
 * the request and shown the user "Extraction returned 504". Running out of
 * budget now produces `readable: false` instead, which the upload page
 * already handles — it routes to manual room entry.
 *
 * Keep it in step with `maxDuration` above if that ever changes.
 */
const EXTRACTION_BUDGET_MS = 100_000;

const MIN_LONG_SIDE = 1400;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Strip path separators/traversal sequences and cap length before using a client-supplied filename in a storage key. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/]/g, "_").replace(/\.\./g, "_");
  return cleaned.slice(-100) || "upload";
}

/** Upscale small plan uploads so printed text/dimensions are legible to Gemini vision — deterministic, no invented detail, just legibility. */
async function normalizePlanImage(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(bytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const long = Math.max(w, h);
    if (!long || long >= MIN_LONG_SIDE) return { bytes, mimeType };
    const factor = Math.min(4, Math.ceil(MIN_LONG_SIDE / long));
    const out = await sharp(bytes)
      .resize(w * factor, h * factor, { kernel: "lanczos3" })
      .png()
      .toBuffer();
    return { bytes: out, mimeType: "image/png" };
  } catch {
    return { bytes, mimeType };
  }
}

/**
 * POST — accept a floor-plan image, store it, extract its rooms in one
 * Gemini vision call. Always returns a plan: `readable: false` means the
 * model couldn't make sense of the image, and the caller routes to manual
 * entry rather than treating this as an error.
 */
export async function POST(request: Request) {
  // Floor-plan extraction is one Gemini vision call per upload.
  const guard = await assertAllowed(request, {
    rateLimit: { key: "parse-plan", limit: 10, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file uploaded" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return Response.json(
        { error: "Only raster images (PNG/JPG) can be parsed. Export PDFs to PNG." },
        { status: 415 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "File too large (max 20MB)" }, { status: 400 });
    }

    const projectIdParam = form.get("projectId");
    const projectId = typeof projectIdParam === "string" && projectIdParam ? projectIdParam : null;

    // Without this check, an authenticated caller could pass ANY other
    // project's id and have this upload's storage key plus a `generations`
    // row recorded against it below — a cross-tenant write, the same class
    // of bug already guarded against in /api/generate-room-image and
    // /api/upload-greybox. Skipped when no projectId was sent at all,
    // matching the existing optional-projectId contract this route already
    // has for the recordGeneration call further down (older client).
    if (projectId) {
      const owned = await requireOwnedProject(guard.id, projectId);
      if (owned instanceof Response) return owned;
    }

    const roomTypeHintsParam = form.get("roomTypeHints");
    const roomTypeHints =
      typeof roomTypeHintsParam === "string" && roomTypeHintsParam
        ? roomTypeHintsParam.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    const { bytes, mimeType } = await normalizePlanImage(
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );

    const storageKey = `plans/${crypto.randomUUID()}/${sanitizeFileName(file.name)}`;
    await putObject(storageKey, bytes, mimeType);

    // Written synchronously, in this same request — same fix as the
    // `renders/...` image-load race (recordGeneration's doc comment): the
    // Plan Editor's <img> used to request this key immediately on
    // navigation, but the client-side project_snapshots sync that would
    // otherwise be the only proof of ownership is debounced 800ms, so the
    // very first load 403'd and got stuck on "No plan image" until a manual
    // refresh gave the debounced sync time to land (reported bug). Skipped
    // when no projectId was sent (older client) — falls back to the
    // pre-existing debounced-snapshot check, same as before this fix.
    if (projectId) {
      await recordGeneration({
        projectId,
        userId: guard.id,
        type: "plan",
        storageUrl: `/api/render?key=${encodeURIComponent(storageKey)}`,
      });
    }

    const result = await runPlanExtraction({
      bytes,
      mimeType,
      fileName: file.name,
      roomTypeHints,
      ctx: { userId: guard.id },
      deadlineMs: EXTRACTION_BUDGET_MS,
    });

    // Thread the original upload's storage key onto the plan so a later PDF
    // export (see /api/export-pdf's "Floor plan page") can embed the actual
    // uploaded drawing, not just the extracted room boxes — extract-plan.ts
    // doesn't know this key itself (it only handles the Gemini call), and
    // this route already has it right here from the putObject call above.
    if (result.readable) {
      result.plan.meta = { ...result.plan.meta, source: result.plan.meta?.source ?? "manual", storageKey };
    }

    return Response.json(result);
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Extraction");
    return Response.json(body, { status });
  }
}
