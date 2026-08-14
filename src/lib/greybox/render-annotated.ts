"use client";

/**
 * Draws numbered badges over furniture pieces onto a copy of the greybox
 * conditioning render, producing a THIRD reference image sent to Gemini
 * (Nano Banana) ONLY — see `ensure-greybox-key.ts`'s doc comment on
 * `greyboxAnnotatedKey` for how it reaches the model. It is never sent to
 * FLUX.2: FLUX has no reasoning pass and treats every reference image as
 * pure structural conditioning, so a numeral baked into a FLUX reference is
 * liable to survive into the generated photo as a marking painted onto the
 * furniture itself (the same reason furniture-catalogue.ts's header gives
 * for never drawing text into the proxies). Gemini, by contrast, has a
 * reasoning pass and follows an explicit "box 3 is the sofa" instruction far
 * more reliably than the computed phrases furniture-descriptors.ts produces
 * ("the long low box at centre-left") once more than a couple of pieces
 * share a frame.
 *
 * This module owns DRAWING only, not projection. Badge pixel positions are
 * computed by the caller (render-mask.ts's `projectFurniture`, which mirrors
 * camera.ts's `projectOpenings` — same locked camera, same mandatory
 * in-front dot-product test) — this file just paints circles and numerals
 * onto an already-rendered PNG using a plain 2D canvas. Three.js geometry or
 * sprites were deliberately not used for the text itself: `arc()` +
 * `fillText()` on a 2D context is pixel-exact and needs no WebGL scene, no
 * font-to-mesh pipeline, and no second render pass.
 */

/** One numbered badge, already projected to a pixel in the base image. */
export interface FurnitureBadge {
  /**
   * 1-based, matching the order of the room's furniture array (index + 1,
   * skipping pieces that aren't in frame) — so the prompt's "box N is the
   * sofa" text and this image's painted numeral N always name the same
   * piece. Never re-derive this from array position after filtering; the
   * caller must assign it before dropping out-of-frame pieces.
   */
  label: number;
  /** Pixel x within the base image, in [0, width). */
  px: number;
  /** Pixel y within the base image, in [0, height). */
  py: number;
}

// Badge fill: a single saturated red, chosen because nothing else in a
// greybox render is saturated at all. Every value on build-scene.ts's ladder
// (WALL_COLOR 0xb0b0b0, FLOOR_COLOR 0x9c9c9c, CEIL_COLOR 0xc4c4c4, DOOR_COLOR
// 0x8a7c6a, WINDOW_COLOR 0xfafafa, REVEAL_COLOR 0x6e6e6e, the 0x1a1a1a
// background) and every furniture-proxy colour (furniture-catalogue.ts's
// FRAME_COLOR 0x585858, SEAT_COLOR 0x484848, RUG_COLOR 0x8a8a8a, and even
// FOLIAGE_COLOR 0x6b7d6b, the one deliberately tinted entry) keeps its R/G/B
// channels within roughly 30 of each other — desaturated grey by
// construction, the whole point of a greybox. #e0272d's channels span 185,
// a saturation no lighting change on any of those materials can produce, so
// a badge can never be misread as a lit or shadowed patch of the scene
// itself, independent of which room or camera angle produced the render.
const BADGE_FILL = "#e0272d";
// White stroke around the fill: WINDOW_COLOR (0xfafafa) is the only
// comparably bright value in the scene, but it fills large flat panes, never
// a thin ring around a small circle — shape, not colour, keeps this from
// reading as a window edge.
const BADGE_STROKE = "#ffffff";
const BADGE_TEXT = "#ffffff";
const BADGE_RADIUS = 22;
const BADGE_STROKE_WIDTH = 3;
const BADGE_FONT = "bold 24px sans-serif";

/**
 * Draws one numbered badge per entry in `badges` onto a copy of the PNG at
 * `baseDataUri` and returns the result as a new PNG data URI. `baseDataUri`
 * itself is never mutated — this always draws onto a fresh canvas, so the
 * conditioning render callers hold onto elsewhere stays byte-identical.
 *
 * `width`/`height` must match the base image's own pixel size (callers pass
 * `GREYBOX_RENDER_W`/`GREYBOX_RENDER_H`, the one place those numbers are
 * decided) — this function does not infer them from the decoded image, so a
 * mismatch would silently letterbox the source into the canvas rather than
 * fail loudly.
 *
 * An empty `badges` array still produces a full redraw of the base image
 * (never a no-op passthrough of the original data URI) — callers that want
 * to avoid a wasted render/upload for a furniture-free room should skip
 * calling this at all rather than call it with `badges: []` (see
 * `render-mask.ts`'s `renderGreyboxBundle`, which does exactly that).
 */
export function annotateFurniture(
  baseDataUri: string,
  badges: FurnitureBadge[],
  width: number,
  height: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("annotateFurniture: 2D canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = BADGE_FONT;
      ctx.lineWidth = BADGE_STROKE_WIDTH;

      for (const badge of badges) {
        ctx.beginPath();
        ctx.arc(badge.px, badge.py, BADGE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = BADGE_FILL;
        ctx.fill();
        ctx.strokeStyle = BADGE_STROKE;
        ctx.stroke();

        ctx.fillStyle = BADGE_TEXT;
        // +1px vertical nudge: most sans-serif metrics sit a hair above true
        // centre against a numeral's visual weight; "middle" baseline alone
        // reads slightly high inside the circle without it.
        ctx.fillText(String(badge.label), badge.px, badge.py + 1);
      }

      resolve(canvas.toDataURL("image/png"));
    };
    // A base64 data: URI Image load fails only on a truly malformed source —
    // no network involved — so this branch exists for defensiveness, not a
    // path expected to fire in practice.
    img.onerror = () => reject(new Error("annotateFurniture: failed to decode base image"));
    img.src = baseDataUri;
  });
}
