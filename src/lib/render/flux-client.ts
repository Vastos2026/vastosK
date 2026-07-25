/**
 * FLUX image generation via fal.ai's REST API — no SDK dependency.
 *
 * Three entry points, mirroring the workflow's rendering phase:
 *   - `generateImage(prompt, view, initImage?)` — text-to-image, or
 *     image-to-image when a 3D-scene screenshot (`initImage`) is supplied. The
 *     screenshot path is the real "2D → 3D → photoreal" conversion: FLUX repaints
 *     the captured Three.js scene into a photorealistic interior.
 *   - `inpaintImage(prompt, image, mask)` — FLUX inpainting over a base image +
 *     mask for the lasso "selective edit".
 *
 * Every call posts to fal's synchronous endpoint (`https://fal.run/<model>`),
 * which blocks until the result is ready, then downloads the output bytes.
 *
 * Returns `null` whenever fal.ai is unconfigured, unreachable, or fails — callers
 * treat `null` as "generation unavailable" and surface an honest error rather
 * than fabricating an image. Mirrors the Gemini client's contract.
 */

const FAL_BASE = "https://fal.run";

// High-tier FLUX models by default (the project has billing). Overridable via
// env to pin a different variant without a code change.
//   txt2img  → FLUX1.1 [pro]      (best-quality text-to-image)
//   img2img  → FLUX.1 dev i2i     (strength-based: regenerates the blocky 3D
//                                  screenshot into a photoreal render — Kontext
//                                  would preserve the input too literally here)
//   inpaint  → FLUX.1 Fill [pro]  (best masked inpainting; FLUX is the fallback,
//                                  Nano Banana is the primary lasso engine)
const TXT2IMG_MODEL = process.env.FAL_TXT2IMG_MODEL?.trim() || "fal-ai/flux-pro/v1.1";
const IMG2IMG_MODEL =
  process.env.FAL_IMG2IMG_MODEL?.trim() || "fal-ai/flux/dev/image-to-image";
const INPAINT_MODEL =
  process.env.FAL_INPAINT_MODEL?.trim() || "fal-ai/flux-pro/v1/fill";

// img2img denoising strength — the dial between "follows the 3D camera" and
// "looks polished":
//   too LOW (~0.75)  → faithful to each view's camera (distinct angles) but plain,
//                      boxy "3D model" look.
//   too HIGH (~0.93) → fully photoreal/designed, but FLUX ignores the input camera
//                      and snaps every view to the same frontal "hero" shot.
// ~0.8 is the balance: the renders hew close enough to the (consistent) 3D scene
// that furniture and colours match across views, while still photo-realising it
// (the rich design prompt + guidance below carry the styling). Tunable via
// FAL_IMG2IMG_STRENGTH — lower for tighter consistency / more distinct angles,
// raise for more polish (at the cost of cross-view drift).
const IMG2IMG_STRENGTH = (() => {
  const n = Number(process.env.FAL_IMG2IMG_STRENGTH);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.8;
})();

export function fluxConfigured(): boolean {
  return !!process.env.FAL_KEY?.trim();
}

export type RenderView =
  | "front"
  | "side"
  | "corner"
  | "corner-back"
  | "left"
  | "right"
  | "back"
  | "top"
  | "pano";

// fal.ai image_size enums per view (used for text-to-image only; the
// image-to-image and inpaint paths inherit the input image's dimensions).
const SIZE_BY_VIEW: Record<RenderView, string> = {
  corner: "landscape_16_9",
  "corner-back": "landscape_16_9",
  front: "landscape_16_9",
  side: "landscape_16_9",
  left: "landscape_16_9",
  right: "landscape_16_9",
  back: "landscape_16_9",
  top: "square_hd",
  pano: "landscape_16_9", // overridden below with a 2:1 panorama size
};

interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * Produce an interior render from a prompt. When `initImage` (a PNG/JPEG data
 * URI of the captured 3D scene) is provided, runs image-to-image so the output
 * preserves the room's real geometry and furniture layout; otherwise runs
 * text-to-image.
 */
export async function generateImage(
  prompt: string,
  view: RenderView,
  initImage?: string,
  /** Fixed seed → consistent design across a room's views (omit for random). */
  seed?: number,
  signal?: AbortSignal,
): Promise<GeneratedImage | null> {
  const seedField = typeof seed === "number" ? { seed } : {};
  if (initImage) {
    return runModel(
      IMG2IMG_MODEL,
      {
        prompt,
        image_url: initImage,
        // High strength → a fully photoreal repaint (not a smoothed 3D massing);
        // the screenshot still guides composition and the fixed per-room seed
        // keeps every angle on the SAME design.
        strength: IMG2IMG_STRENGTH,
        num_inference_steps: 44,
        // Higher prompt adherence so the design layers (false ceiling, feature
        // wall, styling) still land at the lower, camera-respecting strength.
        guidance_scale: 4.5,
        enable_safety_checker: false,
        ...seedField,
      },
      signal,
    );
  }
  return runModel(
    TXT2IMG_MODEL,
    {
      prompt,
      // 360° panoramas need a 2:1 equirectangular canvas; others use enums.
      image_size: view === "pano" ? { width: 1408, height: 704 } : SIZE_BY_VIEW[view],
      num_inference_steps: 34,
      guidance_scale: 3.5,
      enable_safety_checker: false,
      ...seedField,
    },
    signal,
  );
}

/**
 * Inpaint: regenerate only the masked region of `image`, keeping the rest.
 * `image` and `mask` are data URIs (PNG); white mask pixels are repainted,
 * black pixels are preserved.
 */
export async function inpaintImage(
  prompt: string,
  image: string,
  mask: string,
  signal?: AbortSignal,
): Promise<GeneratedImage | null> {
  return runModel(
    INPAINT_MODEL,
    {
      prompt,
      image_url: image,
      mask_url: mask,
      num_inference_steps: 34,
      guidance_scale: 3.5,
      enable_safety_checker: false,
    },
    signal,
  );
}

/** POST to fal's sync endpoint, await the result, and download the image. */
async function runModel(
  model: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GeneratedImage | null> {
  const key = process.env.FAL_KEY?.trim();
  if (!key) return null;

  let payload: FalResponse;
  try {
    const res = await fetch(`${FAL_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.warn(`[flux] ${model} → ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    payload = (await res.json()) as FalResponse;
  } catch (e) {
    console.warn("[flux] request failed:", (e as Error).message);
    return null;
  }

  const image = payload.images?.[0] ?? payload.image;
  if (!image?.url) {
    console.warn("[flux] response had no image url");
    return null;
  }
  return downloadImage(image.url, image.content_type, signal);
}

/** fal returns either a hosted https URL or, occasionally, a data URI. */
async function downloadImage(
  url: string,
  contentTypeHint?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage | null> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const contentType = meta.split(";")[0] || contentTypeHint || "image/png";
    const base64 = url.slice(comma + 1);
    return { bytes: Buffer.from(base64, "base64"), contentType };
  }
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || contentTypeHint || "image/png";
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, contentType };
  } catch (e) {
    console.warn("[flux] image download failed:", (e as Error).message);
    return null;
  }
}

interface FalImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

interface FalResponse {
  images?: FalImage[];
  // Some fal models return a single `image` instead of an `images` array.
  image?: FalImage;
}
