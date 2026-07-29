/**
 * Runware.ai REST client (https://runware.ai/docs) — raw fetch, no SDK,
 * matching this codebase's existing pattern for Gemini/Veo
 * (render/gemini-image.ts, render/veo-client.ts).
 *
 * One HTTP endpoint for every task type: POST an ARRAY of task objects to
 * `https://api.runware.ai/v1`, get back `{ data: [...] }` (or `{ errors: [...] }`).
 * Image inference responds synchronously; video inference is long-running, so
 * video requests set `deliveryMethod: "async"` and are polled via a
 * `getResponse` task keyed by `taskUUID` until `status` is `"success"` or
 * `"error"`.
 *
 * Model choice is env-overridable so a slug can be pinned/swapped without a
 * code change, same convention as `GEMINI_IMAGE_MODEL`/`GEMINI_VIDEO_MODEL`:
 *   RUNWARE_IMAGE_MODEL — default `runware:400@1` (FLUX.2 [dev], text-to-image)
 *   RUNWARE_EDIT_MODEL  — default `runware:102@1` (FLUX Fill, masked inpainting —
 *                          purpose-built for the lasso edit's seed+mask shape,
 *                          unlike FLUX.2 [dev]'s generic reference-image editing)
 *   RUNWARE_VIDEO_MODEL — default `alibaba:wan@2.7` (Wan 2.7, image-to-video)
 *
 * Output resolution is env-overridable in two tiers, RUNWARE_IMAGE_RESOLUTION:
 *   sd (default) — 1280x704 image, 1280x720 video, ~720p 16:9. Verified live
 *     cost (`includeCost:true` against the real API, 2026-07-28): $0.0077/image
 *     — CHEAPER than the old hardcoded 1024x1024 ($0.009) and correct 16:9,
 *     so this is the default per "try 1080p, else lock at 720p if pricier".
 *   hd — 1920x1088 image, 1920x1080 video, ~1080p 16:9. Verified live cost:
 *     $0.016/image — ~2.1x the sd tier and ~78% more than the old baseline,
 *     so it's opt-in, not the default; flip RUNWARE_IMAGE_RESOLUTION=hd once
 *     that tradeoff is accepted.
 *
 * Image and video use DIFFERENT pixel values for the same tier. FLUX.2
 * (imageInference) requires width/height divisible by 64, so 1088/704 stand in
 * for 1080/720. Wan 2.7 (videoInference) instead validates width/height
 * against a fixed ENUM of preset dimensions and rejects 1280x704/1920x1088
 * outright (`unsupportedDimensions`, confirmed against a live 400 response,
 * 2026-07-28: "Supported values are: '1280*720', '720*1280', '960*960',
 * '1088*832', '832*1088', '1920*1080', '1080*1920', '1440*1440', '1632*1248',
 * '1248*1632'") — 1280x720/1920x1080 are themselves in that enum, so video
 * uses the exact values instead of the 64-divisible ones.
 */

import { randomUUID } from "node:crypto";
import { sleep, ProviderError } from "@/lib/ai/errors";

const API_BASE = "https://api.runware.ai/v1";

const IMAGE_MODEL = process.env.RUNWARE_IMAGE_MODEL?.trim() || "runware:400@1";
const EDIT_MODEL = process.env.RUNWARE_EDIT_MODEL?.trim() || "runware:102@1";
const VIDEO_MODEL = process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7";

function resolutionTier(): "sd" | "hd" {
  return process.env.RUNWARE_IMAGE_RESOLUTION?.trim().toLowerCase() === "hd" ? "hd" : "sd";
}

const IMAGE_DIMENSIONS = { sd: { width: 1280, height: 704 }, hd: { width: 1920, height: 1088 } } as const;
const VIDEO_DIMENSIONS = { sd: { width: 1280, height: 720 }, hd: { width: 1920, height: 1080 } } as const;

export function runwareConfigured(): boolean {
  return !!process.env.RUNWARE_API_KEY?.trim();
}

function apiKey(): string {
  const key = process.env.RUNWARE_API_KEY?.trim();
  if (!key) throw new Error("RUNWARE_API_KEY is not configured");
  return key;
}

interface RunwareTaskResult {
  taskType?: string;
  taskUUID?: string;
  status?: "processing" | "success" | "error";
  imageURL?: string;
  videoURL?: string;
  errorMessage?: string;
  /** USD cost of this task — only present when the task was submitted with `includeCost: true`. */
  cost?: number;
  [key: string]: unknown;
}

interface RunwareResponse {
  data?: RunwareTaskResult[];
  errors?: { message?: string; taskUUID?: string }[];
}

/**
 * POST one or more task objects, return the `data` array.
 *
 * Throws a `ProviderError` with the RIGHT category, not a plain `Error` —
 * `provider.ts`'s `runOnProvider` only preserves a caught error's category
 * when it's already a `ProviderError`; anything else gets coerced to
 * `AiProviderError`, which the retry policy (`ai/errors.ts`) treats as
 * transient and retries up to `MAX_RETRIES` times. A 4xx response (bad
 * params, unsupported dimensions/model — exactly the kind of error this
 * file's own header comment documents hitting live) is DETERMINISTIC:
 * retrying just fails again, 2-3x over, at real billed cost each time
 * (found in review). Only 5xx/network-shaped failures are genuinely worth
 * a retry.
 */
async function submit(tasks: Record<string, unknown>[]): Promise<RunwareTaskResult[]> {
  let res: Response;
  try {
    res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(tasks),
    });
  } catch (e) {
    throw new ProviderError("AiProviderError", `Runware request failed: ${(e as Error).message}`);
  }
  const payload = (await res.json().catch(() => null)) as RunwareResponse | null;
  if (!res.ok || !payload) {
    const body = payload ? JSON.stringify(payload) : await res.text().catch(() => "");
    const category = res.status >= 400 && res.status < 500 ? "ValidationError" : "AiProviderError";
    throw new ProviderError(category, `Runware ${res.status}: ${body}`);
  }
  if (payload.errors?.length) {
    // A 200 OK carrying a task-level error array (e.g. "unsupportedDimensions",
    // "unsupportedParameter") is just as deterministic as an HTTP 4xx would
    // have been — same non-retryable category.
    throw new ProviderError("ValidationError", `Runware error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data ?? [];
}

/**
 * Poll `getResponse` for `taskUUID` until the task reports success/error, or
 * `maxWaitMs` elapses. Exponential-ish backoff starting at 2s, capped at 8s.
 */
async function pollUntilDone(taskUUID: string, maxWaitMs: number): Promise<RunwareTaskResult> {
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < maxWaitMs) {
    await sleep(delay);
    delay = Math.min(delay + 1000, 8000);
    const [result] = await submit([{ taskType: "getResponse", taskUUID }]);
    if (!result) continue;
    if (result.status === "success") return result;
    if (result.status === "error") {
      throw new Error(`Runware task ${taskUUID} failed: ${result.errorMessage ?? "unknown error"}`);
    }
  }
  throw new Error(`Runware task ${taskUUID} timed out after ${maxWaitMs}ms`);
}

/** Download a Runware output URL into bytes (their URLs are unauthenticated, time-limited). */
async function download(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Runware output download → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

/**
 * Shared tail end of every Runware call: download the result URL and
 * normalize its content-type. Runware's own content-type header is sometimes
 * missing/generic, so a mime-prefix check with a hardcoded fallback is more
 * reliable than trusting it outright.
 */
async function finishDownload(
  url: string,
  mimePrefix: "image/" | "video/",
  fallback: string,
  costUsd?: number,
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const out = await download(url);
  return {
    bytes: out.bytes,
    contentType: out.contentType.startsWith(mimePrefix) ? out.contentType : fallback,
    costUsd,
  };
}

/** Text-to-image via FLUX.2. Synchronous — Runware returns the imageURL directly. */
export async function generateImageWithRunware(
  prompt: string,
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const { width, height } = IMAGE_DIMENSIONS[resolutionTier()];
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: IMAGE_MODEL,
      positivePrompt: prompt,
      width,
      height,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware imageInference returned no imageURL");
  return finishDownload(result.imageURL, "image/", "image/png", result.cost);
}

/**
 * Masked region edit via FLUX Fill. `maskDataUri` follows this codebase's
 * existing convention (see api/edit-room-image/route.ts): white = edit this
 * region, black = leave untouched — passed straight through as `maskImage`,
 * no crop/composite step needed (unlike the Gemini path), since FLUX Fill
 * does masked inpainting natively.
 */
export async function editImageWithRunware(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: EDIT_MODEL,
      positivePrompt: instruction,
      seedImage: baseDataUri,
      maskImage: maskDataUri,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware FLUX Fill returned no imageURL");
  return finishDownload(result.imageURL, "image/", "image/png", result.cost);
}

/** Image-to-video via Wan 2.7. Async — submits, then polls `getResponse` until done. */
export async function generateVideoWithRunware(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; maxWaitMs?: number } = {},
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const { width, height } = VIDEO_DIMENSIONS[resolutionTier()];
  const [submitted] = await submit([
    {
      taskType: "videoInference",
      taskUUID: randomUUID(),
      model: VIDEO_MODEL,
      positivePrompt: prompt,
      // `frameImages` (image-to-video seed) must be nested under `inputs` —
      // Runware rejects it as a top-level field ("unsupportedParameter",
      // confirmed against a live 400 response, 2026-07-28).
      inputs: { frameImages: [imageDataUri] },
      // Wan 2.7 validates width/height against a fixed enum of preset
      // dimensions rather than a 64-divisible range (see the file header) —
      // these values are exact members of that enum, not derived by rounding.
      width,
      height,
      ...(opts.durationSeconds ? { duration: opts.durationSeconds } : {}),
      outputType: "URL",
      outputFormat: "MP4",
      deliveryMethod: "async",
      includeCost: true,
    },
  ]);
  if (!submitted?.taskUUID) throw new Error("Runware videoInference returned no taskUUID");

  const done =
    submitted.status === "success" && submitted.videoURL
      ? submitted
      : await pollUntilDone(submitted.taskUUID, opts.maxWaitMs ?? 4 * 60_000);
  if (!done.videoURL) throw new Error("Runware video generation finished without a videoURL");
  return finishDownload(done.videoURL, "video/", "video/mp4", done.cost);
}
