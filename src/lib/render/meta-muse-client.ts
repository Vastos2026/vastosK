/**
 * Meta Model API client for Muse Image (`muse-image-1.0`).
 *
 * Deliberately talks to Meta DIRECTLY (`api.meta.ai/v1`) rather than through a
 * reseller. Checked against all three hosts before choosing (2026-09-12):
 * fal.ai exposes only `prompt`, `image_urls`, `aspect_ratio`, `num_images`,
 * `output_format`, `sync_mode` — no way to disable the built-in web/image
 * search, and aspect only as a named enum. Runware exposes the tool switches
 * but is likewise limited to fixed ~2.5MP preset sizes. Meta direct is the only
 * one that takes `size` as a literal `"WxH"`, which is what lets this pipeline
 * keep its exact greybox aspect (see the `size` note below) instead of
 * migrating every cached greybox to true 16:9.
 *
 * What Muse does NOT have, on ANY host — verified against Meta's own reference,
 * fal's OpenAPI schema and Runware's docs, because a widely-circulated
 * "Muse prompting guide" confidently recommends all four:
 *
 *   strength, guidance_scale, seed, negative_prompt — and no mask parameter.
 *
 * Two consequences worth carrying in your head:
 *
 *  - **No seed means no reproducibility.** The same room, same prompt, gives a
 *    different image every call. That is a real step back from FLUX for a
 *    pipeline whose camera, prompt builder and greybox hash are all
 *    deterministic on purpose. Nothing here can fix it.
 *  - **No mask means Muse cannot do the lasso edit.** `/api/edit-room-image`
 *    stays on Nano Banana. This client is for room GENERATION only.
 *
 * Pricing is a flat $0.01 per generated image regardless of size, reasoning
 * depth or how many tool calls it makes internally — the built-in search is
 * included, not billed on top.
 */

import { ProviderError, looksLikeQuotaExhaustion } from "@/lib/ai/errors";

const API_BASE = process.env.META_API_BASE?.trim() || "https://api.meta.ai/v1";
const MUSE_MODEL = process.env.META_MUSE_MODEL?.trim() || "muse-image-1.0";

/** Flat per-image price. Meta publishes one rate; no size or tool multipliers. */
const MUSE_COST_PER_IMAGE_USD = 0.01;

/**
 * Muse runs web search, image search and a code shell internally, and Meta
 * turns all three ON by default.
 *
 * They are defaulted OFF here, which is a deliberate inversion of the
 * provider's default. Those tools exist to pull real-world references into the
 * image — genuinely useful when the job is a chart, a logo or a real landmark.
 * This pipeline's whole purpose is the opposite: reproduce the geometry the
 * greybox rendered and invent nothing. A model that searches the web for what a
 * bedroom looks like is a new source of exactly the invention the rest of this
 * codebase spends its effort suppressing.
 *
 * Set `META_MUSE_TOOLS=on` to restore Meta's default and judge it against a
 * real render — that comparison is the only way to settle whether the realism
 * the tools buy is worth the fidelity they cost.
 */
const TOOLS_ENABLED = process.env.META_MUSE_TOOLS?.trim().toLowerCase() === "on";

/** `high` (Meta's default) or `low`. Both are priced identically, so there is no cost reason to lower it. */
const REASONING_STRENGTH = process.env.META_MUSE_REASONING?.trim().toLowerCase() === "low" ? "low" : "high";

export function museConfigured(): boolean {
  return !!process.env.META_API_KEY?.trim();
}

function apiKey(): string {
  const key = process.env.META_API_KEY?.trim();
  if (!key) throw new Error("META_API_KEY is not configured");
  return key;
}

interface MuseImage {
  b64_json?: string;
  url?: string;
}

interface MuseResponse {
  data?: MuseImage[];
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Turns a non-2xx or error-bodied Muse response into this codebase's error
 * vocabulary, so `runChain` (provider.ts) can decide whether to retry, fall
 * through to the next tier, or stop.
 *
 * Quota is checked FIRST and against the raw text, for the reason
 * errors.ts documents: a spent balance is not retryable, every tier bills the
 * same account, and `runChain` prefers a QuotaError over whatever the last
 * tier happened to fail with.
 */
function toProviderError(status: number, bodyText: string): ProviderError {
  if (looksLikeQuotaExhaustion(bodyText)) {
    return new ProviderError("QuotaError", `Muse: ${bodyText.slice(0, 300)}`);
  }
  // 400 here is genuinely our fault, not a transient one — a malformed size, an
  // unreadable reference image, or the documented 400 from trying to pass tools
  // manually. Retrying an identical body cannot help.
  if (status === 400 || status === 422) {
    return new ProviderError("ValidationError", `Muse rejected the request (${status}): ${bodyText.slice(0, 300)}`);
  }
  if (status === 401 || status === 403) {
    return new ProviderError("AiProviderError", `Muse auth failed (${status})`);
  }
  if (status === 429) {
    return new ProviderError("AiProviderError", `Muse rate limited (${status})`);
  }
  return new ProviderError("AiProviderError", `Muse request failed (${status}): ${bodyText.slice(0, 300)}`);
}

/**
 * Generate one room image.
 *
 * Signature mirrors `generateImageWithRunware` so provider.ts can slot this
 * into its existing chain without a second call shape.
 *
 * `size` is passed as a literal `"<width>x<height>"`. Meta's reference is
 * explicit that this "sets aspect ratio; actual pixel dimensions may differ" —
 * so passing the greybox's own 1376x768 constrains the SHAPE to match the
 * reference camera exactly, while letting Muse pick its own pixel count. This
 * is the whole reason this integration talks to Meta directly, and it is why
 * `assertGenerationAspect` does not need to be called here: there is no preset
 * enum to snap to and therefore no silent crop to guard against.
 */
export async function generateImageWithMuse(
  prompt: string,
  referenceImages?: string[],
  width?: number,
  height?: number,
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const hasRefs = !!referenceImages?.length;
  const endpoint = hasRefs ? `${API_BASE}/images/edits` : `${API_BASE}/images/generations`;

  const body: Record<string, unknown> = {
    model: MUSE_MODEL,
    prompt,
    n: 1,
    // b64_json rather than url: it is Meta's own default, and it avoids a
    // second network round trip to fetch the bytes we are about to store.
    response_format: "b64_json",
    // PNG, not the webp default. Same reasoning as the Runware path: a lossy
    // round trip on the model's own output is an independent cause of the
    // smeared-surface look, and these bytes go straight into object storage.
    output_format: "png",
    reasoning_strength: REASONING_STRENGTH,
    tool_enablement: {
      enable_web_search: TOOLS_ENABLED,
      enable_image_search: TOOLS_ENABLED,
      enable_shell: TOOLS_ENABLED,
    },
  };

  if (width && height) body.size = `${width}x${height}`;
  // Edit/composition mode. Up to 10 references are accepted; this pipeline
  // sends the greybox conditioning render, and may later add the annotated
  // pass beside it.
  if (hasRefs) body.images = referenceImages!.map((image_url) => ({ image_url }));

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Network-level failure: no status to classify, and genuinely transient,
    // so it stays retryable rather than being pinned to a category.
    throw new ProviderError("AiProviderError", `Muse request could not be sent: ${(e as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) throw toProviderError(response.status, text);

  let parsed: MuseResponse;
  try {
    parsed = JSON.parse(text) as MuseResponse;
  } catch {
    throw new ProviderError("AiProviderError", `Muse returned a non-JSON body: ${text.slice(0, 200)}`);
  }
  // A 200 carrying an error object — the same shape Runware uses for a spent
  // balance, which is why this is checked separately from the status code.
  if (parsed.error) throw toProviderError(200, parsed.error.message ?? JSON.stringify(parsed.error));

  const first = parsed.data?.[0];
  if (!first?.b64_json) {
    throw new ProviderError("AiProviderError", "Muse returned no image data");
  }

  return {
    bytes: Buffer.from(first.b64_json, "base64"),
    contentType: "image/png",
    costUsd: MUSE_COST_PER_IMAGE_USD,
  };
}
