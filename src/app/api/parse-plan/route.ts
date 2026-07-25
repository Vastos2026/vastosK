import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { inngest } from "@/lib/inngest/client";
import {
  completeJob,
  createJob,
  failJob,
  getJob,
  setStage,
} from "@/lib/pipeline/job-store";
import { runPipeline } from "@/lib/pipeline/pipeline";
import { putObject } from "@/lib/pipeline/storage";
import type { PipelineMode } from "@/lib/pipeline/types";

/**
 * Upscale small plan uploads BEFORE anything sees them. Users often upload a
 * screenshot of a CAD plan (a real one arrived at 332×615 px — the printed
 * "12'3\"X9'1\"" room sizes were ~5 px tall): OCR reads zero tokens, vision
 * misreads names ("Uvino & Dining"), the accurate printed dimensions are never
 * found, and most furniture symbols are invisible. Lanczos-upscaling the raster
 * ~3-4× makes that text/symbology legible to OCR + vision. Deterministic — no
 * invented detail, just legibility.
 *
 * Runs at INGEST so the stored object, every pipeline stage, and later
 * per-room crops (meta.storageKey + the px transform) all see the SAME image.
 */
const MIN_LONG_SIDE = 1400;
async function normalizePlanImage(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string; note?: string }> {
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
    const note = `upscaled ${w}×${h} → ${w * factor}×${h * factor} (×${factor}) for OCR/vision legibility`;
    console.log(`[parse] ${note}`);
    return { bytes: out, mimeType: "image/png", note };
  } catch {
    return { bytes, mimeType }; // unreadable metadata — let the pipeline try as-is
  }
}

// We spawn a Python child process and touch the filesystem → Node runtime,
// never the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Async (Inngest) mode is opt-in: it needs `npx inngest-cli dev` running. When
// off, the same pipeline runs synchronously inline so the app works with zero
// extra infrastructure.
const inngestEnabled = process.env.INNGEST_ENABLED === "1";

/**
 * POST — accept a floor-plan image, store it (S3 / local), and kick off the
 * pipeline. Returns either `{ jobId, mode:"inngest" }` (poll GET) or
 * `{ jobId, mode:"sync", result }` (already complete).
 */
export async function POST(request: Request) {
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

    // Optional caller-supplied calibration: an explicit feet-per-pixel scale or
    // the plan's known longest side in feet (keeps dimensions accurate).
    const scaleParam = form.get("scale");
    const longestParam = form.get("longestSideFt");
    const scale = scaleParam && Number(scaleParam) > 0 ? Number(scaleParam) : undefined;
    const longestSideFt =
      longestParam && Number(longestParam) > 0 ? Number(longestParam) : undefined;

    // Local-first project id (recorded on the job; not a Supabase FK yet).
    const projectIdParam = form.get("projectId");
    const appProjectId = typeof projectIdParam === "string" ? projectIdParam : undefined;

    // Small screenshots are upscaled BEFORE storage so the stored object, the
    // pipeline, and later per-room crops all measure the same pixels.
    const { bytes, mimeType } = await normalizePlanImage(
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );
    const jobId = randomUUID();
    const storageKey = `plans/${jobId}/${file.name}`;

    // Stage 1 — AWS S3 (or transparent local fallback).
    const storage = await putObject(storageKey, bytes, mimeType);
    createJob(jobId, {
      appProjectId,
      fileName: file.name,
      mimeType,
      storage,
    });

    if (inngestEnabled) {
      // Async path: hand off to Inngest; the client polls GET ?jobId.
      await inngest.send({
        name: "plan/uploaded",
        data: {
          jobId,
          storageKey: storage.key,
          storageBackend: storage.backend,
          fileName: file.name,
          mimeType,
          scale,
          longestSideFt,
        },
      });
      return Response.json({ jobId, mode: "inngest" satisfies PipelineMode });
    }

    // Sync fallback: run the same pipeline inline and return the full result.
    try {
      const result = await runPipeline(
        { bytes, fileName: file.name, mimeType, storage, scale, longestSideFt },
        (stage) => setStage(jobId, stage),
      );
      completeJob(jobId, result);
      return Response.json({ jobId, mode: "sync" satisfies PipelineMode, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Pipeline failed";
      failJob(jobId, message);
      return Response.json({ error: message, jobId }, { status: 500 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Parsing failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** GET ?jobId — poll job status/result (used by the async Inngest path). */
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "jobId required" }, { status: 400 });
  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  return Response.json(job);
}
