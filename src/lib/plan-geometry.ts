/**
 * Geometry helpers for plan analysis.
 *
 * `analyzePlan` flags rooms that overlap or spill outside the envelope so the
 * UI can highlight exactly what needs fixing.
 */

import type { FloorPlan, Room } from "./types";

export interface PlanIssues {
  /** rooms that overlap another room */
  overlapIds: Set<string>;
  /** rooms that extend past the plan envelope */
  outOfBoundsIds: Set<string>;
  /** number of overlapping room pairs */
  overlapPairs: number;
  /** sum of room areas ÷ envelope area (×100); >100% means rooms overlap */
  coverage: number;
}

/** Overlap area (sq ft) of two rooms — 0 when they don't intersect. */
function overlapArea(a: Room, b: Room): number {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

export function analyzePlan(plan: FloorPlan): PlanIssues {
  const rooms = plan.rooms;
  const overlapIds = new Set<string>();
  let overlapPairs = 0;

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (overlapArea(rooms[i], rooms[j]) > 0.5) {
        overlapIds.add(rooms[i].id);
        overlapIds.add(rooms[j].id);
        overlapPairs++;
      }
    }
  }

  const outOfBoundsIds = new Set(
    rooms
      .filter(
        (r) =>
          r.x < -0.05 ||
          r.y < -0.05 ||
          r.x + r.width > plan.planWidth + 0.05 ||
          r.y + r.height > plan.planHeight + 0.05,
      )
      .map((r) => r.id),
  );

  const envelope = Math.max(1, plan.planWidth * plan.planHeight);
  const roomArea = rooms.reduce((s, r) => s + r.width * r.height, 0);
  const coverage = Math.round((roomArea / envelope) * 100);

  return { overlapIds, outOfBoundsIds, overlapPairs, coverage };
}

