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
 *   RUNWARE_IMAGE_MODEL — default `bfl:5@1` (FLUX.2 [pro] — switched from
 *                          FLUX.2 [dev]/`runware:400@1` 2026-08-02 per direct
 *                          user testing: better output quality. Unlike [dev],
 *                          [pro] documents `inputs.referenceImages` support
 *                          (confirmed against Runware's own docs,
 *                          runware.ai/docs/models/bfl-flux-2-pro, 2026-08-02)
 *                          — same request shape as the Nano Banana tiers
 *                          below — so `generateImageWithRunware` now takes a
 *                          reference-images param and provider.ts no longer
 *                          has to skip FLUX entirely for greybox-conditioned
 *                          rooms, which is most of them. [pro]'s docs list no
 *                          `negativePrompt` parameter (unlike [dev], which
 *                          does support it) — sent conditionally, see below.
 *   RUNWARE_EDIT_MODEL  — default `google:4@2` (Nano Banana Pro, reference-image
 *                          editing — see the "Nano Banana via Runware" section
 *                          below for why this replaced FLUX Fill as the lasso
 *                          edit's primary model, 2026-07-30)
 *   RUNWARE_VIDEO_MODEL — default `alibaba:wan@2.7` (Wan 2.7, image-to-video)
 *   RUNWARE_FALLBACK_IMAGE_MODEL — default `google:4@3` (Nano Banana 2) — the
 *                          second-tier fallback for BOTH generateImage and
 *                          editImage when the primary Runware model fails
 *                          (see provider.ts's chained fallback); a third tier,
 *                          the direct Google Gemini API key path, is provider.ts's
 *                          own responsibility, not this file's.
 *
 * Nano Banana via Runware (google:4@2 "Pro", google:4@3 "2") — confirmed via
 * live schema lookups (2026-07-30) to be REFERENCE-IMAGE editors, same as
 * FLUX.2: `inputs.referenceImages` (1-14 images), no `maskImage`/mask concept
 * at all. So the lasso edit's crop → edit → composite-back pipeline (already
 * built for the direct-Google-API Nano Banana path, see
 * `render/gemini-image.ts`'s `planCropEdit`/`compositeCrop`) is REUSED here
 * rather than reinvented — `editImageWithRunwareGemini` below calls those
 * same two functions, swapping only the actual "edit this crop" HTTP call.
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
import { planCropEdit, compositeCrop, parseDataUri } from "@/lib/render/gemini-image";
import type { DesignStyle } from "@/lib/types";

const API_BASE = "https://api.runware.ai/v1";

const IMAGE_MODEL = process.env.RUNWARE_IMAGE_MODEL?.trim() || "bfl:5@1";
/**
 * Black Forest Labs' own hosted tiers (bfl:*, e.g. FLUX.2 [pro]) reject both
 * `negativePrompt` (undocumented, assumed unsupported per their docs) AND
 * `steps` — the latter confirmed live, 2026-08-02: every real generation
 * 400'd with `unsupportedArchitectureSteps` ("Parameter 'steps' is not
 * supported for the selected model configuration") until this was added.
 * Runware's self-hosted `runware:*` tiers (e.g. the old FLUX.2 [dev]
 * default) DO support both. Gated per-model rather than sent
 * unconditionally — an unsupported param 400s outright on this API (see this
 * file's header comment for the established pattern).
 */
const isBflModel = (model: string) => model.startsWith("bfl:");
const EDIT_MODEL = process.env.RUNWARE_EDIT_MODEL?.trim() || "google:4@2";
const VIDEO_MODEL = process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7";
/** Nano Banana 2 — second-tier fallback, used for both generation and editing. */
const FALLBACK_IMAGE_MODEL = process.env.RUNWARE_FALLBACK_IMAGE_MODEL?.trim() || "google:4@3";
/** FLUX Fill [dev] — no longer the default edit model (see header comment),
 * kept only so `RUNWARE_EDIT_MODEL` can still be pointed back at it. */
const FLUX_FILL_MODEL = "runware:102@1";

function resolutionTier(): "sd" | "hd" {
  return process.env.RUNWARE_IMAGE_RESOLUTION?.trim().toLowerCase() === "hd" ? "hd" : "sd";
}

// Runware's `negativePrompt` field (unlike Gemini, which has no separate
// negative channel and has to fold everything into one prompt string) —
// static, not room-specific, so it's set here rather than threaded through
// the whole provider abstraction. Targets the "looks AI-generated" complaint
// directly: CGI/render/illustration tells, plastic-smooth surfaces, flat
// studio lighting, and low-detail/blurry output.
const REALISM_NEGATIVE_PROMPT =
  "3D render, CGI, illustration, cartoon, painting, plastic-looking surfaces, artificial studio lighting, " +
  "overexposed highlights, flat lighting, blurry, soft focus, low detail, low resolution, watermark, text, " +
  "logo, distorted geometry, warped proportions, impossible architecture";

const IMAGE_DIMENSIONS = { sd: { width: 1280, height: 704 }, hd: { width: 1920, height: 1088 } } as const;
const VIDEO_DIMENSIONS = { sd: { width: 1280, height: 720 }, hd: { width: 1920, height: 1080 } } as const;
/**
 * Nano Banana (google:4@x) rejects arbitrary width/height outright —
 * confirmed live via "unsupportedDimensions" 400s using FLUX's own
 * 64-divisible IMAGE_DIMENSIONS above — it validates against a fixed enum of
 * preset dimensions per aspect-ratio + size-tier instead. These are the exact
 * 16:9 members of that enum (1K and 2K tiers), used by
 * `generateImageWithRunwareGemini` below.
 */
const GEMINI_IMAGE_DIMENSIONS = { sd: { width: 1376, height: 768 }, hd: { width: 2752, height: 1536 } } as const;

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

/**
 * Text-to-image via FLUX.2 — reference-conditioned (a greybox render) when
 * `referenceImages` is given, plain text-to-image otherwise. Synchronous —
 * Runware returns the imageURL directly.
 */
export async function generateImageWithRunware(
  prompt: string,
  referenceImages?: string[],
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const { width, height } = IMAGE_DIMENSIONS[resolutionTier()];
  const bfl = isBflModel(IMAGE_MODEL);
  // No separate negativePrompt channel on this model (see isBflModel's
  // comment) — fold the same realism guidance into the positive prompt as an
  // explicit "avoid" clause instead of silently dropping it.
  const positivePrompt = bfl ? `${prompt}\n\nAvoid: ${REALISM_NEGATIVE_PROMPT}.` : prompt;
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: IMAGE_MODEL,
      positivePrompt,
      ...(bfl ? {} : { negativePrompt: REALISM_NEGATIVE_PROMPT }),
      ...(referenceImages?.length ? { inputs: { referenceImages } } : {}),
      // `steps` is rejected outright on bfl:* tiers (see isBflModel's
      // comment) — Runware's self-hosted tiers DO take it, and raising it is
      // the most direct, lowest-risk lever for "sharper, more detailed"
      // output there (documented valid range 1-50). CFGScale is left unset
      // to keep Runware's own documented default (4), already reasonable.
      ...(bfl ? {} : { steps: 35 }),
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
 * DISABLED — kept aside, not deleted, per this repo's convention for retired
 * models (matches `src/lib/pipeline/opencv.ts`'s style). No longer called
 * from `provider.ts` as of 2026-07-30 — replaced by `editImageWithRunwareGemini`
 * below (Nano Banana Pro/2), per the user's explicit "the output from lasso
 * is still not good, change it" after the steps/CFGScale tuning below was
 * already live-verified to help but apparently not enough. Masked region
 * edit via FLUX Fill. `maskDataUri` follows this codebase's existing
 * convention (see api/edit-room-image/route.ts): white = edit this region,
 * black = leave untouched — no crop/composite step needed (unlike the Gemini
 * path), since FLUX Fill does masked inpainting natively.
 *
 * `seedImage`/`maskImage` stay TOP-LEVEL, not nested under `inputs`. The
 * user-supplied FLUX.1 Fill [dev] OpenAPI schema doc (2026-07-30) shows them
 * nested under `inputs` — but two separate live 400s proved the doc doesn't
 * match this model's actual deployed validation: nesting under `inputs`
 * gets `missingMaskImage` ("Model is of type Inpainting and requires a mask
 * image to be provided" — the validator doesn't see it there), and the same
 * doc's `maskMargin` field gets `unsupportedArchitectureMaskMargin` ("Mask
 * margin is not supported in this model architecture") outright. Top-level
 * seedImage/maskImage with no maskMargin is what actually works, confirmed
 * by a real successful edit. Don't "fix" this back to match the doc without
 * re-confirming live first, if this is ever revived.
 *
 * A live A/B test (real bedroom seed image, masked region, "add a large
 * bright red vase with flowers") showed the edit lands roughly in the right
 * region (seedImage/maskImage ARE respected) but the un-tuned result looked
 * flat/pasted-on rather than a lit, integrated 3D object — matching the
 * user's "output but not good" complaint. Explicit `steps`/`CFGScale` (both
 * undocumented-default, i.e. Runware's own defaults for this model are
 * unknown/possibly low) fixed that specific problem — a second live A/B
 * confirmed a real, well-integrated result — but the user still wasn't
 * satisfied and asked to move to Nano Banana Pro regardless.
 */
export async function editImageWithRunwareFluxFill(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  // Without an explicit width/height, Runware infers dimensions from
  // `seedImage`'s own pixel size, which isn't guaranteed to be a multiple of
  // 64 between 128-2048 (FLUX Fill's hard requirement) — confirmed live via
  // "invalidWidth" 400s on the lasso edit path. Pin to the same locked
  // resolution-tier constants `generateImageWithRunware` uses, which are
  // always valid, instead of trusting the seed image's actual dimensions.
  const { width, height } = IMAGE_DIMENSIONS[resolutionTier()];
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: FLUX_FILL_MODEL,
      positivePrompt: instruction,
      negativePrompt: REALISM_NEGATIVE_PROMPT,
      seedImage: baseDataUri,
      maskImage: maskDataUri,
      steps: 38,
      CFGScale: 7,
      width,
      height,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware FLUX Fill returned no imageURL");
  return finishDownload(result.imageURL, "image/", "image/png", result.cost);
}

/**
 * Region edit via Nano Banana (Pro or 2) on Runware — reuses the SAME crop /
 * generous-pad / prompt-build / feathered-composite pipeline as the direct
 * Google API path (`gemini-image.ts`'s `planCropEdit`/`compositeCrop`), only
 * swapping which HTTP call actually performs the "edit this crop" step.
 * Neither Nano Banana model has a mask parameter — both are reference-image
 * editors (`inputs.referenceImages`), confirmed against their live Runware
 * schemas (2026-07-30) — hence needing the crop+composite trick at all,
 * unlike FLUX Fill's native masked inpainting.
 *
 * `resolution: "1K"` is passed instead of explicit `width`/`height` — the
 * docs state `referenceImages` requires `resolution` (not width/height) and
 * that the model then auto-matches the input's aspect ratio, which sidesteps
 * having to guess whether an arbitrary crop size falls inside Nano Banana's
 * documented-but-unverified per-tier dimension ranges. `compositeCrop`
 * already resizes whatever comes back to the exact crop size regardless, so
 * the returned image's exact pixel dimensions don't need to match anything.
 */
export async function editImageWithRunwareGemini(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  tier: "primary" | "fallback" = "primary",
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const plan = await planCropEdit(baseDataUri, maskDataUri, instruction, style);
  if (!plan) throw new ProviderError("ValidationError", "lasso selection is empty");
  const crop = parseDataUri(plan.cropDataUri);

  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: tier === "primary" ? EDIT_MODEL : FALLBACK_IMAGE_MODEL,
      positivePrompt: plan.prompt,
      inputs: { referenceImages: [`data:${crop.mime};base64,${crop.data}`] },
      resolution: "1K",
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware Nano Banana returned no imageURL");
  const edited = await download(result.imageURL);
  const composited = await compositeCrop(plan.baseBuf, edited.bytes, plan.bx, plan.by, plan.bw, plan.bh);
  return { ...composited, costUsd: result.cost };
}

/**
 * Text-to-image via Nano Banana 2 — the generation fallback tier (see
 * `provider.ts`'s chained fallback: FLUX first, this second, direct Google
 * API third).
 *
 * Two request shapes, depending on whether reference images are supplied:
 *
 * - WITHOUT references: plain `width`/`height`, which must be one of this
 *   model's own preset enum values, NOT FLUX's 64-divisible range (see
 *   GEMINI_IMAGE_DIMENSIONS).
 * - WITH references: `resolution` INSTEAD of width/height — the docs tie that
 *   enum to `referenceImages` being present, and the model then matches the
 *   reference's own aspect ratio. That is exactly what a greybox reference
 *   needs, since the greybox is rendered at the target framing already (see
 *   docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md).
 *   Same shape `editImageWithRunwareGemini` above already uses successfully.
 */
export async function generateImageWithRunwareGemini(
  prompt: string,
  referenceImages?: string[],
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const tier = resolutionTier();
  const { width, height } = GEMINI_IMAGE_DIMENSIONS[tier];
  const hasRefs = !!referenceImages?.length;
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: FALLBACK_IMAGE_MODEL,
      positivePrompt: prompt,
      ...(hasRefs
        ? { inputs: { referenceImages }, resolution: tier === "hd" ? "2K" : "1K" }
        : { width, height }),
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware Nano Banana returned no imageURL");
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
