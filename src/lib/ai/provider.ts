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
  feature: "ocr" | "semantic" | "image" | "edit" | "video",
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

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
  }[];
}
