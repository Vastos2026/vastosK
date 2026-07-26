import "server-only";
/**
 * AI provider layer (revamp Workstream 4) — the ONLY module allowed to call a
 * Gemini SDK/endpoint directly for the NEW pipeline (Universal Input →
 * Prompt Builder → this layer). Every other module (API routes, the Prompt
 * Builder, future frontend flow) calls these five functions instead of
 * touching a provider client or REST endpoint itself.
 *
 * Each call: applies the retry policy from ./errors, times itself, normalizes
 * failures to an ErrorCategory, and writes one ai_usage_logs row — all
 * best-effort, so a logging hiccup never breaks a generation.
 *
 * The existing floor-plan pipeline stages (ocr.ts, semantic.ts) and the old
 * 3D-studio render stack (render/gemini-image.ts, render/veo-client.ts,
 * render/flux-client.ts) already existed before this layer and do their own
 * direct Gemini calls — they're deliberately left as-is (the 3D studio is
 * explicitly deprioritized-not-removed, and ripping out its FLUX fallback
 * before Workstream 8 replaces it with the new flow would break the only
 * currently-working generation path). runOCR/runSemantic below wrap them so
 * the *new* pipeline entry points go through this layer; generateImage/
 * editImage/generateVideo are net-new for the new flow's room-image and
 * walkthrough generation.
 */

import { extractText } from "@/lib/pipeline/ocr";
import { understandPlan } from "@/lib/pipeline/semantic";
import { generateJson, type GeminiPart } from "@/lib/pipeline/gemini-client";
import { downscaleForGemini } from "@/lib/pipeline/image-utils";
import { editImageWithGemini } from "@/lib/render/gemini-image";
import { generateVideoFromImage } from "@/lib/render/veo-client";
import type { OcrResult, SemanticPlan } from "@/lib/pipeline/types";
import type { DesignStyle } from "@/lib/types";
import { ProviderError, RETRYABLE_CATEGORIES, MAX_RETRIES, backoffMs, sleep } from "./errors";
import { logUsage } from "./usage-log";

export interface CallContext {
  userId?: string | null;
  projectId?: string | null;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

function classify(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return new ProviderError("TimeoutError", msg);
  return new ProviderError("AiProviderError", msg);
}

/** Retry wrapper: retries only AiProviderError/TimeoutError, capped backoff. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: ProviderError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = classify(e);
      lastErr = err;
      if (!RETRYABLE_CATEGORIES.has(err.category) || attempt === MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt + 1));
    }
  }
  throw lastErr ?? new ProviderError("InternalError", "retry loop exited without a result");
}

/** Wraps a provider call: retry, time it, log it, normalize the thrown error. */
async function instrumented<T>(
  feature: "ocr" | "semantic" | "planning" | "image" | "edit" | "video",
  model: string,
  ctx: CallContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await withRetry(fn);
    void logUsage({
      userId: ctx?.userId,
      projectId: ctx?.projectId,
      feature,
      model,
      success: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (e) {
    const err = classify(e);
    void logUsage({
      userId: ctx?.userId,
      projectId: ctx?.projectId,
      feature,
      model,
      success: false,
      durationMs: Date.now() - started,
      errorCategory: err.category,
    });
    throw err;
  }
}

export interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
}

export interface RawOpening {
  kind: "door" | "window";
  side: "north" | "south" | "east" | "west";
  /** another room's name, "exterior", or omitted if the model couldn't tell */
  connectsTo?: string;
}

export interface RawExtractedRoom {
  /** verbatim as printed/labeled on the plan — never normalized */
  name: string;
  /** classified type, ideally one of the caller's roomTypeHints */
  type?: string;
  widthFt?: number;
  heightFt?: number;
  openings: RawOpening[];
}

export interface RawExtraction {
  rooms: RawExtractedRoom[];
  /** 0..1 overall extraction confidence, the model's own self-assessment */
  confidence: number;
  /** false when the model could not make sense of this as a floor plan at all */
  readable: boolean;
}

const PLAN_EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    readable: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    rooms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          type: { type: "STRING" },
          widthFt: { type: "NUMBER" },
          heightFt: { type: "NUMBER" },
          openings: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                kind: { type: "STRING", enum: ["door", "window"] },
                side: { type: "STRING", enum: ["north", "south", "east", "west"] },
                connectsTo: { type: "STRING" },
              },
              required: ["kind", "side"],
            },
          },
        },
        required: ["name", "openings"],
      },
    },
  },
  required: ["readable", "confidence", "rooms"],
} as const;

interface RawExtractionResponse {
  readable?: boolean;
  confidence?: number;
  rooms?: {
    name?: string;
    type?: string;
    widthFt?: number;
    heightFt?: number;
    openings?: { kind?: string; side?: string; connectsTo?: string }[];
  }[];
}

/**
 * Single-call floor-plan extraction — replaces the old OCR + OpenCV geometry +
 * semantic + merge pipeline. Reads room names verbatim, classifies each into a
 * type (preferring roomTypeHints when the project's category has a fixed
 * list), reads printed dimensions where legible, and reports door/window
 * presence per room with a rough side and connection. `readable: false` is
 * the model's own signal that this image doesn't look like a floor plan it
 * can extract from — callers route that to manual entry, never a fabricated
 * result.
 */
export async function extractFloorPlan(
  bytes: Buffer,
  mimeType: string,
  roomTypeHints: string[],
  ctx?: CallContext,
): Promise<RawExtraction> {
  const img = await downscaleForGemini(bytes);
  const hints = roomTypeHints.length
    ? `Prefer one of these types when it fits: ${roomTypeHints.join(", ")}. If none fit, use your own best short label.`
    : `This project type has no fixed room-type list — use your own best short label (e.g. "Bedroom", "Kitchen").`;

  const prompt = `You are reading an architectural floor plan image to extract its rooms.

For each room you can identify, return:
- "name": the room's label EXACTLY as printed on the plan (e.g. "KIDS", "Hall", "M. Bedroom"). Never invent a name if none is printed — use a short generic description instead (e.g. "Unlabeled room").
- "type": a classification of what kind of room this is, based on its printed name and typical layout position. ${hints}
- "widthFt"/"heightFt": only if a dimension is actually printed near the room (e.g. "12'3\"X9'1\""), converted to decimal feet. Omit both if nothing is legible — never estimate or guess a size.
- "openings": every door and window you can see on this room's walls. For each: "kind" (door or window), "side" (which wall of the room it's on: north/south/east/west, using the plan's own up-is-north orientation), "connectsTo" (the name of the room on the other side of a door, or "exterior" for an outer wall or a window). Omit anything you can't confidently see.

Also return:
- "confidence": your own 0 to 1 confidence that this extraction is accurate and complete.
- "readable": false if this image does not look like a floor plan you can meaningfully extract rooms from at all (e.g. it's blank, unrelated, or too unclear to read), true otherwise.

Return only rooms you can actually identify. Never fabricate a room, dimension, or opening that isn't legible in the image.`;

  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: prompt },
  ];

  return instrumented("planning", process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash", ctx, async () => {
    const raw = await generateJson<RawExtractionResponse>(parts, {
      temperature: 0.1,
      responseSchema: PLAN_EXTRACTION_SCHEMA,
    });
    if (!raw) throw new ProviderError("AiProviderError", "floor plan extraction failed");

    const sides = new Set(["north", "south", "east", "west"]);
    const rooms: RawExtractedRoom[] = (raw.rooms ?? [])
      .filter((r): r is typeof r & { name: string } => !!r.name?.trim())
      .map((r) => ({
        name: r.name.trim(),
        type: r.type?.trim() || undefined,
        widthFt: typeof r.widthFt === "number" && r.widthFt > 0 ? r.widthFt : undefined,
        heightFt: typeof r.heightFt === "number" && r.heightFt > 0 ? r.heightFt : undefined,
        openings: (r.openings ?? [])
          .filter((o) => (o.kind === "door" || o.kind === "window") && sides.has(o.side ?? ""))
          .map((o) => ({
            kind: o.kind as "door" | "window",
            side: o.side as "north" | "south" | "east" | "west",
            connectsTo: o.connectsTo?.trim() || undefined,
          })),
      }));

    return {
      rooms,
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      readable: raw.readable !== false && rooms.length > 0,
    };
  });
}

/**
 * Plain text-to-image generation for the new flow's room images — the Prompt
 * Builder hands this a fully-assembled natural-language prompt; this layer
 * never sees or constructs prompt structure itself.
 */
export async function generateImage(
  prompt: string,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("AiProviderError", "GEMINI_API_KEY is not configured");
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");

  return instrumented("image", IMAGE_MODEL, ctx, async () => {
    const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      });
    } catch (e) {
      throw new ProviderError("AiProviderError", `request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError("AiProviderError", `${IMAGE_MODEL} ${res.status}: ${body}`);
    }
    const payload = (await res.json().catch(() => null)) as GeminiImageResponse | null;
    const b64 = payload?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    if (!b64) throw new ProviderError("AiProviderError", `${IMAGE_MODEL} returned no image part`);
    return { bytes: Buffer.from(b64, "base64"), contentType: "image/png" };
  });
}

/**
 * Lasso-region edit — delegates to the existing crop/composite implementation
 * (render/gemini-image.ts), which already does exactly this for the old
 * studio flow and is reused unchanged for the new flow's step 7.
 */
export async function editImage(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!instruction.trim()) throw new ProviderError("ValidationError", "instruction is empty");
  return instrumented("edit", IMAGE_MODEL, ctx, async () => {
    const out = await editImageWithGemini(baseDataUri, maskDataUri, instruction, style);
    if (!out) throw new ProviderError("AiProviderError", "edit produced no image");
    return out;
  });
}

export interface GeneratedVideo {
  bytes: Buffer;
  contentType: string;
}

/** Image-to-video (walkthrough clips) — delegates to render/veo-client.ts. */
export async function generateVideo(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; aspectRatio?: string } = {},
  ctx?: CallContext,
): Promise<GeneratedVideo> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  return instrumented("video", "veo", ctx, async () => {
    const out = await generateVideoFromImage(imageDataUri, prompt, opts);
    if (!out) throw new ProviderError("AiProviderError", "video generation failed");
    return { bytes: out.bytes, contentType: out.contentType };
  });
}

/** OCR stage — delegates to pipeline/ocr.ts, the new pipeline's entry point. */
export async function runOCR(
  bytes: Buffer,
  mimeType: string,
  ctx?: CallContext,
): Promise<OcrResult> {
  return instrumented("ocr", "gemini-vision", ctx, () => extractText(bytes, mimeType));
}

/** Semantic understanding stage — delegates to pipeline/semantic.ts. */
export async function runSemantic(
  ocr: OcrResult | (() => Promise<OcrResult>),
  bytes?: Buffer,
  mimeType?: string,
  ctx?: CallContext,
): Promise<SemanticPlan> {
  return instrumented("semantic", "gemini-flash", ctx, () => understandPlan(ocr, bytes, mimeType));
}

/**
 * One structured Gemini call, constrained to `schema` — the Design Planning
 * Layer (Workstream 5) uses this to turn a Universal Input into a Design
 * Specification JSON. Generic (not tied to that shape) so any future
 * structured-JSON planning call goes through this layer too, instead of a
 * caller reaching for pipeline/gemini-client.ts directly.
 */
export async function generateStructured<T>(
  prompt: string,
  schema: object,
  ctx?: CallContext,
): Promise<T> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  return instrumented("planning", model, ctx, async () => {
    const parts: GeminiPart[] = [{ text: prompt }];
    const out = await generateJson<T>(parts, { temperature: 0.4, responseSchema: schema });
    if (out === null) throw new ProviderError("AiProviderError", "structured generation failed");
    return out;
  });
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
  }[];
}
