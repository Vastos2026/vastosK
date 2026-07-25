/**
 * Geometry helpers for the 2D Review editor.
 *
 * `analyzePlan` flags rooms that overlap or spill outside the envelope so the
 * editor can highlight exactly what needs fixing. `tidyLayout` snaps room
 * corners onto shared gridlines and nudges overlapping rooms apart — it only
 * moves positions (x/y), never changing a room's width/height, so the exact
 * dimensions read from the plan are preserved.
 */

import type { FloorPlan, Room } from "./types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

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

/**
 * Returns position patches that align room corners to shared gridlines and
 * separate overlaps. Only x/y change — widths/heights (the printed dimensions)
 * are preserved. Apply each patch via the store's updateRoom.
 */
export function tidyLayout(plan: FloorPlan): { id: string; patch: Partial<Room> }[] {
  const rooms = plan.rooms.map((r) => ({ ...r }));
  const { planWidth: W, planHeight: H } = plan;
  const TOL = 1.2;

  // 1) Snap corners onto shared gridlines (closes small gaps, aligns walls).
  const xLines = gridlines(rooms.flatMap((r) => [r.x, r.x + r.width]), TOL);
  const yLines = gridlines(rooms.flatMap((r) => [r.y, r.y + r.height]), TOL);
  for (const r of rooms) {
    r.x = clamp(snap(r.x, xLines, TOL), 0, Math.max(0, W - r.width));
    r.y = clamp(snap(r.y, yLines, TOL), 0, Math.max(0, H - r.height));
  }

  // 2) Separate overlaps: push the further room along its axis of least overlap.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 0.1 && oy > 0.1) {
          if (ox <= oy) {
            const hi = a.x <= b.x ? b : a;
            hi.x = clamp(r1(hi.x + ox), 0, Math.max(0, W - hi.width));
          } else {
            const hi = a.y <= b.y ? b : a;
            hi.y = clamp(r1(hi.y + oy), 0, Math.max(0, H - hi.height));
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // Emit only rooms whose position actually changed.
  const patches: { id: string; patch: Partial<Room> }[] = [];
  for (const r of rooms) {
    const orig = plan.rooms.find((o) => o.id === r.id)!;
    const nx = r1(r.x);
    const ny = r1(r.y);
    if (Math.abs(nx - orig.x) > 0.05 || Math.abs(ny - orig.y) > 0.05) {
      patches.push({ id: r.id, patch: { x: nx, y: ny } });
    }
  }
  return patches;
}

/** Cluster sorted values within `tol` into representative gridlines (centroids). */
function gridlines(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lines: number[] = [];
  let cluster: number[] = [];
  for (const v of sorted) {
    if (cluster.length && v - cluster[cluster.length - 1] > tol) {
      lines.push(r1(cluster.reduce((s, x) => s + x, 0) / cluster.length));
      cluster = [];
    }
    cluster.push(v);
  }
  if (cluster.length) lines.push(r1(cluster.reduce((s, x) => s + x, 0) / cluster.length));
  return lines;
}

function snap(v: number, lines: number[], tol: number): number {
  let best = v;
  let bestD = tol;
  for (const l of lines) {
    const d = Math.abs(l - v);
    if (d <= bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}
