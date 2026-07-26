import sharp from "sharp";
import { runPlanExtraction } from "@/lib/pipeline/extract-plan";
import { putObject } from "@/lib/pipeline/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_LONG_SIDE = 1400;

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

    const roomTypeHintsParam = form.get("roomTypeHints");
    const roomTypeHints =
      typeof roomTypeHintsParam === "string" && roomTypeHintsParam
        ? roomTypeHintsParam.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    const { bytes, mimeType } = await normalizePlanImage(
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );

    const storageKey = `plans/${crypto.randomUUID()}/${file.name}`;
    await putObject(storageKey, bytes, mimeType);

    const result = await runPlanExtraction({
      bytes,
      mimeType,
      fileName: file.name,
      roomTypeHints,
    });

    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Extraction failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
