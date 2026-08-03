import type { GreyboxClass } from "./build-scene";

/**
 * Pure pixel statistics for the section 3.7 value-ladder assertion — split
 * out of render-to-data-uri.ts (which is "use client" for its WebGL calls)
 * specifically so the server-side verification route (dev-check) and any
 * future server-side caller can import `assertHistogram` without dragging in
 * a client boundary. render-to-data-uri.ts re-exports both names so existing
 * import paths keep working.
 */

/** Thrown when the section 3.7 value ladder has collapsed. Never swallowed. */
export class GreyboxHistogramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GreyboxHistogramError";
  }
}

function luma(d: Uint8ClampedArray, i: number): number {
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Section 3.7. Material colours are not rendered values — a lighting tweak
 * can silently collapse the value ladder while every constant still looks
 * right in source. This verifies the actual pixels.
 *
 * Runs against a label pass (each mesh flat-shaded by its greyboxClass) used
 * purely as a region selector over the real render's pixels.
 */
export function assertHistogram(real: ImageData, labels: Map<GreyboxClass, number[]>) {
  const d = real.data;
  const lumaOf = (idx: number) => luma(d, idx * 4);
  const sortedOf = (cls: GreyboxClass) => (labels.get(cls) ?? []).map(lumaOf).sort((a, b) => a - b);

  const win = sortedOf("window");
  const wall = sortedOf("wall");
  const furn = sortedOf("furniture");
  const door = sortedOf("door");

  if (win.length && wall.length) {
    // Literally: "window region occupies the top 1% of luma, and no wall
    // pixel exceeds it". Compared at p05/p99 rather than min/max because
    // antialiased edge pixels blend across the boundary and would fail a
    // strict comparison for a render that is perfectly correct.
    if (percentile(win, 5) <= percentile(wall, 99)) {
      throw new GreyboxHistogramError(
        `Window is not the brightest surface (window p05 ${percentile(win, 5).toFixed(3)} <= wall p99 ${percentile(wall, 99).toFixed(3)}). ` +
          "Check that the window filler is still an unlit MeshBasicMaterial.",
      );
    }
  }

  if (furn.length && wall.length) {
    const gap = percentile(wall, 50) - percentile(furn, 50);
    if (gap < 0.15) {
      throw new GreyboxHistogramError(
        `Furniture does not separate from the walls (median gap ${gap.toFixed(3)} < 0.15). Furniture must be the darkest thing in frame.`,
      );
    }
  }

  if (door.length && furn.length) {
    const gap = Math.abs(percentile(door, 50) - percentile(furn, 50));
    if (gap < 0.1) {
      throw new GreyboxHistogramError(
        `Door panel and furniture are too close in value (${gap.toFixed(3)} < 0.10) — a wardrobe will read as a door.`,
      );
    }
  }

  const nonWindow = new Set(labels.get("window") ?? []);
  let total = 0;
  let clipped = 0;
  for (let i = 0; i < d.length; i += 4) {
    const idx = i / 4;
    if (nonWindow.has(idx)) continue;
    total++;
    if (d[i] >= 255 && d[i + 1] >= 255 && d[i + 2] >= 255) clipped++;
  }
  if (total && clipped / total > 0.005) {
    throw new GreyboxHistogramError(
      `${((clipped / total) * 100).toFixed(2)}% of non-window pixels are clipped at 255 (max 0.5%). Pull the light rig back.`,
    );
  }
}
