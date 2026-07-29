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
 * The old 3D-studio render stack (render/gemini-image.ts, render/veo-client.ts,
 * render/flux-client.ts) already existed before this layer and does its own
 * direct Gemini calls — it's deliberately left as-is (the 3D studio is
 * explicitly deprioritized-not-removed, and ripping out its FLUX fallback
 * before Workstream 8 replaces it with the new flow would break the only
 * currently-working generation path). generateImage/editImage/generateVideo
 * wrap it so that stack goes through this layer too; extractFloorPlan below
 * is the new pipeline's single-call extraction entry point (see
 * src/lib/pipeline/extract-plan.ts).
 */

import { generateJson, geminiConfigured, type GeminiPart } from "@/lib/pipeline/gemini-client";
import { downscaleForGemini } from "@/lib/pipeline/image-utils";
import { editImageWithGemini } from "@/lib/render/gemini-image";
import { generateVideoFromImage } from "@/lib/render/veo-client";
import type { DesignStyle } from "@/lib/types";
import { ProviderError, RETRYABLE_CATEGORIES, MAX_RETRIES, backoffMs, sleep } from "./errors";
import { logUsage } from "./usage-log";
import {
  runwareConfigured,
  generateImageWithRunware,
  editImageWithRunware,
  generateVideoWithRunware,
} from "@/lib/render/runware-client";

export interface CallContext {
  userId?: string | null;
  projectId?: string | null;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

/**
 * Provider toggle — flip back to Gemini any time by setting the env var to
 * "gemini" (or unsetting RUNWARE_API_KEY, which forces the Gemini path
 * regardless of the env var, so a half-configured Runware setup never
 * silently breaks generation). Documented in CLAUDE.md's "Env vars" section
 * and .env.example. Defaults to Runware — this is a deliberate temporary
 * testing setup, not a permanent architecture decision (see context.md).
 */
function resolveProvider(envValue: string | undefined): "gemini" | "runware" {
  const wanted = (envValue?.trim().toLowerCase() || "runware") as "gemini" | "runware";
  return wanted === "runware" && runwareConfigured() ? "runware" : "gemini";
}

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

/**
 * Wraps a provider call: retry, time it, log it, normalize the thrown error.
 * `fn` gets a `setCost` callback so a Runware caller can report the real
 * per-call USD cost (`includeCost: true`'s `cost` field) into the usage log —
 * callers that have no such number (the Gemini path) simply never call it,
 * leaving `estimated_cost` null rather than a fabricated figure.
 */
async function instrumented<T>(
  feature: "planning" | "image" | "edit" | "video",
  model: string,
  ctx: CallContext | undefined,
  fn: (setCost: (costUsd: number | null | undefined) => void) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let costUsd: number | null | undefined;
  const setCost = (c: number | null | undefined) => {
    costUsd = c;
  };
  try {
    const result = await withRetry(() => fn(setCost));
    void logUsage({
      userId: ctx?.userId,
      projectId: ctx?.projectId,
      feature,
      model,
      success: true,
      durationMs: Date.now() - started,
      estimatedCost: costUsd,
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
      estimatedCost: costUsd,
    });
    throw err;
  }
}

/**
 * Runs whichever provider's call is active and normalizes the thrown error —
 * shared by generateImage/editImage/generateVideo so a Runware-side
 * ProviderError (e.g. ValidationError) keeps its real category instead of
 * being flattened to AiProviderError just because it crossed this boundary.
 */
async function runOnProvider<T>(
  provider: "gemini" | "runware",
  runwareFn: () => Promise<T>,
  geminiFn: () => Promise<T>,
): Promise<T> {
  try {
    return provider === "runware" ? await runwareFn() : await geminiFn();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("AiProviderError", (e as Error).message);
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

/**
 * Builds the response schema for one extraction call. When the caller has a
 * fixed room-type list (every project category except Custom), the "type"
 * field is constrained to an ENUM of exactly that list — Gemini's
 * constrained decoding then cannot return a type outside it, which is a
 * stronger hallucination guard than prompt wording alone. Custom projects
 * pass an empty list by design (config/project-types/custom.json), so "type"
 * stays free-text there — there is no fixed list to constrain it to.
 */
function buildExtractionSchema(roomTypeHints: string[]) {
  return {
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
            type: roomTypeHints.length
              ? { type: "STRING", enum: roomTypeHints }
              : { type: "STRING" },
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
}

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
  if (!geminiConfigured()) {
    throw new ProviderError("ValidationError", "GEMINI_API_KEY is not configured");
  }
  const img = await downscaleForGemini(bytes);
  const hints = roomTypeHints.length
    ? `"type" MUST be exactly one value from this fixed list, chosen by the room's printed name and its position in the layout: ${roomTypeHints.join(", ")}. Pick the closest match even if imperfect — never a value outside this list.`
    : `"type" is a short room-category label (e.g. "Bedroom", "Kitchen") — this project has no fixed list, infer the best short label from the room's printed name.`;

  const prompt = `You are reading an architectural floor plan image to extract its rooms. Be conservative: if you are not confident about a detail, omit it rather than guess.

Per room:
- "name": EXACTLY as printed on the plan (e.g. "KIDS", "Hall", "M. Bedroom"). Never invent one — if nothing is printed, use a short factual description (e.g. "Unlabeled room").
- ${hints}
- "widthFt"/"heightFt": only if a dimension is actually printed near the room (e.g. "12'3\"X9'1\""), converted to decimal feet. Omit both if nothing is legible.
- "openings": every door/window you can see on this room's walls. "kind" (door|window), "side" (north/south/east/west of this room, plan's up-is-north), "connectsTo" (the room on the other side of a door, or "exterior" for an outer wall or a window). Omit anything not clearly visible.

Also: "confidence" (0-1, your own accuracy estimate) and "readable" (false only if this image isn't a floor plan you can meaningfully read at all).

Report only what you can actually see. Never fabricate a room, dimension, or opening.`;

  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: prompt },
  ];

  return instrumented("planning", process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest", ctx, async () => {
    const raw = await generateJson<RawExtractionResponse>(parts, {
      temperature: 0.1,
      thinkingBudget: 0,
      // Dense plans (many rooms, each with a full opening list) were hitting
      // MAX_TOKENS and getting truncated/salvaged instead of returning every
      // room. Extraction correctness matters more than output-token cost —
      // this cap exists only to bound a runaway generation, not to save
      // tokens, so it's set high enough that a real plan should never hit it.
      maxOutputTokens: 65536,
      responseSchema: buildExtractionSchema(roomTypeHints),
    });
    if (!raw) throw new ProviderError("AiProviderError", "floor plan extraction failed");

    // Belt and suspenders: the schema's enum already constrains `type` when
    // roomTypeHints is non-empty, but a stray out-of-list value is dropped
    // here too rather than trusted, in case a fallback model ignores the
    // schema.
    const validTypes = roomTypeHints.length ? new Set(roomTypeHints) : null;
    const sides = new Set(["north", "south", "east", "west"]);
    const rooms: RawExtractedRoom[] = (raw.rooms ?? [])
      .filter((r): r is typeof r & { name: string } => !!r.name?.trim())
      .map((r) => ({
        name: r.name.trim(),
        type:
          r.type?.trim() && (!validTypes || validTypes.has(r.type.trim()))
            ? r.type.trim()
            : undefined,
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
/**
 * The original Gemini text-to-image call — kept as its own function so the
 * Runware branch can sit next to it without touching this logic. `imageConfig.
 * aspectRatio` is a real, documented Gemini image-gen parameter (verified
 * against Google's docs, 2026-07-28: gemini-2.5-flash-image's generateContent
 * accepts `generationConfig.imageConfig.aspectRatio`, one of "1:1", "2:3",
 * "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9" — it otherwise
 * defaults to 1:1), so this is set to "16:9" to match the Runware path rather
 * than left at the model's square default.
 */
async function generateImageWithGemini(prompt: string): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("AiProviderError", "GEMINI_API_KEY is not configured");

  const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
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
}

/**
 * Plain text-to-image generation for the new flow's room images — the Prompt
 * Builder hands this a fully-assembled natural-language prompt; this layer
 * never sees or constructs prompt structure itself.
 *
 * Routes to Gemini or Runware per `IMAGE_PROVIDER` (see `resolveProvider()`
 * above) — temporary testing setup, toggle back to Gemini any time.
 */
export async function generateImage(
  prompt: string,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const provider = resolveProvider(process.env.IMAGE_PROVIDER);
  const model = provider === "runware" ? process.env.RUNWARE_IMAGE_MODEL?.trim() || "runware:400@1" : IMAGE_MODEL;

  return instrumented("image", model, ctx, async (setCost) => {
    return runOnProvider(
      provider,
      async () => {
        const out = await generateImageWithRunware(prompt);
        setCost(out.costUsd);
        return out;
      },
      () => generateImageWithGemini(prompt),
    );
  });
}

/**
 * Lasso-region edit — delegates to the existing crop/composite implementation
 * (render/gemini-image.ts) for Gemini, or FLUX Fill's native masked
 * inpainting for Runware. Routes per `IMAGE_PROVIDER` — same toggle as
 * `generateImage`.
 */
export async function editImage(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!instruction.trim()) throw new ProviderError("ValidationError", "instruction is empty");
  const provider = resolveProvider(process.env.IMAGE_PROVIDER);
  const model = provider === "runware" ? process.env.RUNWARE_EDIT_MODEL?.trim() || "runware:102@1" : IMAGE_MODEL;

  return instrumented("edit", model, ctx, async (setCost) => {
    return runOnProvider(
      provider,
      async () => {
        const out = await editImageWithRunware(baseDataUri, maskDataUri, instruction);
        setCost(out.costUsd);
        return out;
      },
      async () => {
        const out = await editImageWithGemini(baseDataUri, maskDataUri, instruction, style);
        if (!out) throw new ProviderError("AiProviderError", "edit produced no image");
        return out;
      },
    );
  });
}

export interface GeneratedVideo {
  bytes: Buffer;
  contentType: string;
}

/**
 * Image-to-video (walkthrough clips). Routes per `VIDEO_PROVIDER` —
 * Gemini/Veo (delegates to render/veo-client.ts) or Runware/Wan 2.7
 * (render/runware-client.ts).
 */
export async function generateVideo(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; aspectRatio?: string } = {},
  ctx?: CallContext,
): Promise<GeneratedVideo> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const provider = resolveProvider(process.env.VIDEO_PROVIDER);
  const model = provider === "runware" ? process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7" : "veo";

  return instrumented("video", model, ctx, async (setCost) => {
    return runOnProvider(
      provider,
      async () => {
        const out = await generateVideoWithRunware(imageDataUri, prompt, { durationSeconds: opts.durationSeconds });
        setCost(out.costUsd);
        return out;
      },
      async () => {
        const out = await generateVideoFromImage(imageDataUri, prompt, opts);
        if (!out) throw new ProviderError("AiProviderError", "video generation failed");
        return { bytes: out.bytes, contentType: out.contentType };
      },
    );
  });
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
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  return instrumented("planning", model, ctx, async () => {
    const parts: GeminiPart[] = [{ text: prompt }];
    const out = await generateJson<T>(parts, {
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 8192,
      responseSchema: schema,
    });
    if (out === null) throw new ProviderError("AiProviderError", "structured generation failed");
    return out;
  });
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
  }[];
}
