import "server-only";

/**
 * Single source of truth for the model slugs each capability's Runware/
 * Gemini tier actually resolves to — provider.ts's generateImage/editImage/
 * generateVideo import this directly (no more separate inline literals),
 * and the console's model-switcher UI (src/app/console/analytics/page.tsx)
 * reads the exact same values, so the two can never silently drift apart
 * (e.g. image editing's Runware tier is Nano Banana Pro, NOT the same model
 * as image generation's FLUX.2 — easy to assume they match since the
 * switcher's two options per capability look identical in the UI; a prior
 * version of this UI got this wrong for exactly that reason).
 *
 * Server-only (reads process.env) — friendlyModelLabel (the pure label
 * lookup, safe for client components) lives in the sibling
 * friendly-model-label.ts specifically so it doesn't drag this file's
 * "server-only" guard into a client bundle.
 */
export function currentModelSlugs() {
  const geminiImageModel = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
  return {
    imageGen: {
      runware: process.env.RUNWARE_IMAGE_MODEL?.trim() || "bfl:5@1",
      meta: process.env.META_MUSE_MODEL?.trim() || "muse-image-1.0",
      gemini: geminiImageModel,
    },
    imageEdit: {
      runware: process.env.RUNWARE_EDIT_MODEL?.trim() || "google:4@2",
      gemini: geminiImageModel,
    },
    video: {
      runware: process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7",
    },
  };
}
