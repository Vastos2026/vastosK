/**
 * Pixel → feet transform shared by the parsing pipeline.
 *
 * Kept as its own module (rather than folded into pipeline.ts) because it
 * mirrors the exact anchor/scale the Merge Engine used to build the plan —
 * a second definition would silently drift and misplace geometry.
 */

import type { DetectedGeometry, FloorPlan } from "./types";

/**
 * Linear map from image pixels to plan feet. Anchored at the detected building
 * footprint when available (the plan origin the merge used), else the full
 * image — the same priority mergePlan applies.
 */
export function pxToFtTransform(geometry: DetectedGeometry, plan: FloorPlan) {
  const bb = geometry.buildingBox;
  const useBB = !!bb && bb.w > 0 && bb.h > 0;
  const ox = useBB ? bb!.x : 0;
  const oy = useBB ? bb!.y : 0;
  const sx = plan.planWidth / (useBB ? bb!.w : geometry.imageWidth || 1);
  const sy = plan.planHeight / (useBB ? bb!.h : geometry.imageHeight || 1);
  return {
    x: (px: number) => (px - ox) * sx,
    y: (py: number) => (py - oy) * sy,
    sx,
    sy,
    /** origin (image px) the feet space is anchored at — needed to invert this map */
    ox,
    oy,
  };
}
