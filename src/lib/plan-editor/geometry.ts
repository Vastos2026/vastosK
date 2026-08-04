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

/** Standard real-world door/window widths, feet — the FIXED size assigned to a new or seeded
 *  opening, independent of the wall/room it ends up on (openings no longer scale with the wall
 *  they sit on — see PlacedOpening.widthFt's doc comment in lib/types.ts). Shared with
 *  plan-editor-canvas.tsx's interactive click-to-add. */
export const STANDARD_DOOR_WIDTH_FT = 3;
export const STANDARD_WINDOW_WIDTH_FT = 4;

/** A wall's real length in feet, given the room's real width/depth — matches build-scene.ts's
 *  wallFrame convention: north/south walls run east-west (length = room width); east/west walls
 *  run north-south (length = room depth). Exported for plan-editor-canvas.tsx's interactive
 *  create/move/resize handlers and openingBoxToPlaced below, which all need to convert between
 *  an opening's fixed real-world widthFt and its normalised along-wall position/clamp fraction. */
export function wallLengthFt(wall: GreyboxWall, roomWidthFt: number, roomDepthFt: number): number {
  return wall === "north" || wall === "south" ? roomWidthFt : roomDepthFt;
}

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

export function nearestWall(shape: EditorShape, p: Pt): { wall: GreyboxWall; dist: number } {
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

/** A Gemini spatial-grounding box: [ymin,xmin,ymax,xmax], each 0-1000 over the full image. */
export type GeminiBox = [number, number, number, number];

/** Converts a Gemini box (0-1000 scale) to a normalised [0,1] EditorShape rect. */
export function boxToShape(box: GeminiBox): EditorShape {
  const [ymin, xmin, ymax, xmax] = box;
  return { x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 };
}

/** How far (normalised) an opening box's centre may sit from its room's nearest wall before we
 *  distrust the reading and fall back to a side-only guess instead of a wrong position. */
const OPENING_BOX_TOLERANCE = 0.12;

/**
 * Converts one opening's Gemini box, plus its room's already-placed shape, into a PlacedOpening.
 * Approximation: uses the box's CENTRE to find the nearest wall and the along-wall position, and
 * the box's extent along that wall's direction as the span. A door's swing-arc symbol is roughly
 * as wide as it is tall, so this holds up for doors too, not just windows — it is not exact
 * (arcs are asymmetric around the true hinge point), but the Plan Editor's manual drag is the
 * correction layer for whatever this gets close-but-not-exact, so this doesn't need to be exact.
 * Returns null when the box doesn't plausibly sit on this room's boundary at all (extraction
 * noise), so the caller can fall back to `seedPlacedOpenings`'s even-spread guess instead.
 *
 * `roomWidthFt`/`roomDepthFt` (the room's real feet dimensions, when known) convert the box's
 * measured along-wall fraction into an absolute widthFt ONCE, at extraction time — after that,
 * like every other opening, its real-world size no longer depends on the room's dimensions.
 * Falls back to the STANDARD_*_WIDTH_FT constants when the room's real dimensions aren't known.
 */
export function openingBoxToPlaced(
  roomShape: EditorShape,
  box: GeminiBox,
  type: PlacedOpening["type"],
  id: string,
  roomWidthFt?: number,
  roomDepthFt?: number,
): PlacedOpening | null {
  const ob = boxToShape(box);
  const centre: Pt = [ob.x + ob.w / 2, ob.y + ob.h / 2];
  const { wall, dist } = nearestWall(roomShape, centre);
  if (dist > OPENING_BOX_TOLERANCE) return null;

  const [a, b] = wallEndpoints(roomShape, wall);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (len2 < 1e-12) return null;
  const rawT = ((centre[0] - a[0]) * (b[0] - a[0]) + (centre[1] - a[1]) * (b[1] - a[1])) / len2;

  // Fraction of the wall's IMAGE-space length this box occupies. The plan image is drawn to one
  // consistent scale, so this fraction equals the real-world along-wall fraction too — len2 was
  // already checked >= 1e-12 above, so wallLenNorm here is always > 1e-6, never a division risk.
  const wallLenNorm = Math.sqrt(len2);
  const extentAlongWall = wall === "north" || wall === "south" ? ob.w : ob.h;
  const rawSpanFraction = extentAlongWall / wallLenNorm;

  // clampOpeningSpan clamps BOTH the position (keeping the whole span on the wall) AND the
  // span fraction itself (into [0.04, 0.9]) — widthFt below is derived from the SAME
  // clamped fraction it returns, not the raw pre-clamp one, so `t` and `widthFt` stay
  // consistent with each other. Using the raw fraction here would let an oversized Gemini
  // box produce a widthFt wider than the wall allows even though `t` was clamped as if it
  // weren't (Fix round 1).
  const { t, span: clampedFraction } = clampOpeningSpan(rawT, rawSpanFraction);
  const widthFt =
    roomWidthFt && roomDepthFt
      ? clampedFraction * wallLengthFt(wall, roomWidthFt, roomDepthFt)
      : type === "door"
        ? STANDARD_DOOR_WIDTH_FT
        : STANDARD_WINDOW_WIDTH_FT;
  return { id, type, wall, t, widthFt };
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
    // A fixed real-world width, independent of the room's dimensions — no conversion needed.
    const widthFt = type === "door" ? STANDARD_DOOR_WIDTH_FT : STANDARD_WINDOW_WIDTH_FT;
    group.forEach((_, i) => {
      const t = (i + 1) / (group.length + 1);
      out.push({ id: `seed-${seq++}`, type, wall, t, widthFt });
    });
  }
  return out;
}
