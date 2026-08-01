/**
 * Pure geometry for the Plan Editor's canvas (src/components/project/
 * plan-editor-canvas.tsx) — rectangle hit-testing/move/resize, wall
 * hit-testing for placing openings, and the two conversions that make this
 * screen's output compatible with the rest of the app:
 *
 *   - deriveOpenings: PlacedOpening[] (position-based) -> RoomOpening[]
 *     (side + connectsTo) — the shape Room Confirmation, build-universal-input.ts
 *     and prompt-builder.ts already read.
 *   - seedPlacedOpenings: RoomOpening[] (Gemini's side-only guess, no
 *     position) -> PlacedOpening[] at reasonable default positions, so a
 *     newly-placed room starts with markers to drag into place instead of a
 *     blank room the user has to populate from scratch.
 *
 * Framework-free, like sketch/geometry.ts — this file only computes numbers,
 * the canvas component owns rendering and event handling.
 */

import { distToSegment, type Pt } from "@/lib/sketch/geometry";
import type { GreyboxWall } from "@/lib/greybox/types";
import type { PlacedOpening } from "@/lib/types";
import type { RoomOpening } from "@/lib/pipeline/assign-openings";

export interface EditorShape {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_SIZE = 0.04;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const OPPOSITE: Record<GreyboxWall, GreyboxWall> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

/** Default along-wall fraction for a newly-placed opening. */
const DEFAULT_SPAN: Record<PlacedOpening["type"], number> = { door: 0.12, window: 0.18 };

export function moveShape(shape: EditorShape, dx: number, dy: number): EditorShape {
  return {
    ...shape,
    x: clamp(shape.x + dx, 0, 1 - shape.w),
    y: clamp(shape.y + dy, 0, 1 - shape.h),
  };
}

/** Resizes from one of 8 handles, keeping the OPPOSITE edge fixed. */
export function resizeShape(shape: EditorShape, handle: ResizeHandle, dx: number, dy: number): EditorShape {
  let { x, y, w, h } = shape;
  if (handle.includes("e")) w = clamp(w + dx, MIN_SIZE, 1 - x);
  if (handle.includes("w")) {
    const newX = clamp(x + dx, 0, x + w - MIN_SIZE);
    w = w + (x - newX);
    x = newX;
  }
  if (handle.includes("s")) h = clamp(h + dy, MIN_SIZE, 1 - y);
  if (handle.includes("n")) {
    const newY = clamp(y + dy, 0, y + h - MIN_SIZE);
    h = h + (y - newY);
    y = newY;
  }
  return { x, y, w, h };
}

const HANDLE_POINTS = (s: EditorShape): { h: ResizeHandle; p: Pt }[] => [
  { h: "nw", p: [s.x, s.y] },
  { h: "n", p: [s.x + s.w / 2, s.y] },
  { h: "ne", p: [s.x + s.w, s.y] },
  { h: "e", p: [s.x + s.w, s.y + s.h / 2] },
  { h: "se", p: [s.x + s.w, s.y + s.h] },
  { h: "s", p: [s.x + s.w / 2, s.y + s.h] },
  { h: "sw", p: [s.x, s.y + s.h] },
  { h: "w", p: [s.x, s.y + s.h / 2] },
];

/** `tol` is in the SAME normalised units as `shape` — the caller converts a pixel tolerance once, per axis. */
export function hitTestHandle(shape: EditorShape, pt: Pt, tol: { x: number; y: number }): ResizeHandle | null {
  for (const { h, p } of HANDLE_POINTS(shape)) {
    if (Math.abs(pt[0] - p[0]) <= tol.x && Math.abs(pt[1] - p[1]) <= tol.y) return h;
  }
  return null;
}

export function pointInShape(shape: EditorShape, pt: Pt): boolean {
  return pt[0] >= shape.x && pt[0] <= shape.x + shape.w && pt[1] >= shape.y && pt[1] <= shape.y + shape.h;
}

/**
 * Absolute [x,y] of `wall`'s two endpoints, in the SAME reading-order
 * convention build-scene.ts's wallFrame uses: north/south run west->east,
 * east/west run north->south. Getting this wrong would place an opening on
 * the correct wall but mirrored along it once rendered.
 */
export function wallEndpoints(shape: EditorShape, wall: GreyboxWall): [Pt, Pt] {
  const { x, y, w, h } = shape;
  switch (wall) {
    case "north":
      return [[x, y], [x + w, y]];
    case "south":
      return [[x, y + h], [x + w, y + h]];
    case "west":
      return [[x, y], [x, y + h]];
    case "east":
      return [[x + w, y], [x + w, y + h]];
  }
}

export function openingPoint(shape: EditorShape, o: { wall: GreyboxWall; t: number }): Pt {
  const [a, b] = wallEndpoints(shape, o.wall);
  return [a[0] + (b[0] - a[0]) * o.t, a[1] + (b[1] - a[1]) * o.t];
}

function nearestWall(shape: EditorShape, p: Pt): { wall: GreyboxWall; dist: number } {
  let best: { wall: GreyboxWall; dist: number } | null = null;
  (["north", "south", "east", "west"] as GreyboxWall[]).forEach((wall) => {
    const [a, b] = wallEndpoints(shape, wall);
    const d = distToSegment(p, a, b);
    if (!best || d < best.dist) best = { wall, dist: d };
  });
  return best!;
}

/** `tol` is normalised (same units as the shape). Returns null when `pt` isn't within `tol` of any wall. */
export function wallHitTest(shape: EditorShape, pt: Pt, tol: number): { wall: GreyboxWall; t: number } | null {
  const { wall, dist } = nearestWall(shape, pt);
  if (dist > tol) return null;
  const [a, b] = wallEndpoints(shape, wall);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (len2 < 1e-12) return null;
  const t = clamp(((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / len2, 0, 1);
  return { wall, t };
}

/** Keeps an opening fully on its wall — same halfSpan-clamp shape as lib/openings.ts's snapToWall. */
export function clampOpeningSpan(t: number, span: number): { t: number; span: number } {
  const s = clamp(span, 0.04, 0.9);
  const half = s / 2;
  return { t: clamp(t, half, 1 - half), span: s };
}

/**
 * Resolves every room's placedOpenings into RoomOpening[] (side + connectsTo).
 * Hand-drawn rectangles rarely share an EXACT edge, so "connects to room B"
 * means: the opening's point sits within TOLERANCE of B's boundary AND B's
 * nearest wall there FACES this opening (north<->south, east<->west) — not
 * just "any nearby wall", which would also match a perpendicular room across
 * a corner.
 */
const CONNECT_TOLERANCE = 0.035;

export function deriveOpenings(
  rooms: { id: string; name: string; shape?: EditorShape; placedOpenings?: PlacedOpening[] }[],
): Record<string, RoomOpening[]> {
  const placed = rooms.filter((r): r is typeof r & { shape: EditorShape } => !!r.shape);
  const result: Record<string, RoomOpening[]> = {};
  for (const room of rooms) {
    if (!room.shape || !room.placedOpenings?.length) {
      result[room.id] = [];
      continue;
    }
    const shape = room.shape;
    result[room.id] = room.placedOpenings.map((o) => {
      const p = openingPoint(shape, o);
      let connectsTo: string | null = "exterior";
      for (const other of placed) {
        if (other.id === room.id) continue;
        const { wall: nearWall, dist } = nearestWall(other.shape, p);
        if (dist <= CONNECT_TOLERANCE && nearWall === OPPOSITE[o.wall]) {
          connectsTo = other.name.trim() || null;
          break;
        }
      }
      return { type: o.type, side: o.wall, connectsTo };
    });
  }
  return result;
}

/**
 * Seeds PlacedOpening[] from a room's EXTRACTION-time openings (Gemini's
 * side-only guess, no position) so a newly-placed room starts with draggable
 * markers instead of a blank wall — the user's job becomes "drag this to the
 * right spot," not "remember every door and window from scratch." Multiple
 * openings of the same type on the same wall are spread evenly so they don't
 * start stacked on top of each other.
 */
export function seedPlacedOpenings(openings: RoomOpening[]): PlacedOpening[] {
  const byWall = new Map<string, RoomOpening[]>();
  for (const o of openings) {
    const key = `${o.side}:${o.type}`;
    byWall.set(key, [...(byWall.get(key) ?? []), o]);
  }
  const out: PlacedOpening[] = [];
  let seq = 0;
  for (const [key, group] of byWall) {
    const [wall, type] = key.split(":") as [GreyboxWall, PlacedOpening["type"]];
    group.forEach((_, i) => {
      const t = (i + 1) / (group.length + 1);
      out.push({ id: `seed-${seq++}`, type, wall, t, span: DEFAULT_SPAN[type] });
    });
  }
  return out;
}
