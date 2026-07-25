/**
 * Client for the per-room detection API (`/api/detect-room`).
 *
 * Turns "what Gemini saw in this room's crop of the plan" into things the app
 * can store: doors/windows snapped onto the room's own walls, and furniture
 * matched to the catalog. Everything it returns is user-editable afterwards in
 * the room's 2D plan, so a wrong call costs one drag, not a re-parse.
 */

import { specForLabel } from "./furniture-spec";
import { DEFAULT_WINDOW_LEN, snapToWall } from "./openings";
import type { Door, PlacedItem, Room, Window } from "./types";
import { uid } from "./utils";

export interface DetectedItem {
  type: "door" | "window" | "furniture";
  name: string;
  /** absolute plan feet */
  x: number;
  y: number;
  w: number;
  d: number;
  /** fractions of the room box (0-1) — survive a room-size correction */
  fx?: number;
  fy?: number;
  fw?: number;
  fd?: number;
}

/** The room's printed truth as read off the plan crop (name + real size). */
export interface DetectedLabel {
  name?: string;
  sizeText?: string;
  printedWidthFt?: number;
  printedHeightFt?: number;
}

export interface DetectResult {
  items: DetectedItem[];
  label: DetectedLabel;
}

export async function detectRoomFeatures(input: {
  storageKey: string;
  /** the plan's px→ft transform, straight from plan.meta */
  originPxX: number;
  originPxY: number;
  ftPerPxX: number;
  ftPerPxY: number;
  /** the image size the transform was measured on (plan.meta.imageWidth/Height) */
  imageWidth?: number;
  imageHeight?: number;
  room: { x: number; y: number; width: number; height: number; name?: string; type?: string };
}): Promise<DetectResult> {
  const res = await fetch("/api/detect-room", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let msg = `Detection failed (${res.status})`;
    try {
      const b = await res.json();
      if (b?.error) msg = b.error;
    } catch {
      /* non-JSON error */
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { items?: DetectedItem[]; label?: DetectedLabel };
  return { items: body.items ?? [], label: body.label ?? {} };
}

/**
 * Correct a room's box to its PRINTED size (the architect's own number), keeping
 * the box's centre. The detected pixel box runs ~1-1.5 ft short on real uploads
 * (interior floor mask vs printed clear dimensions), which is exactly the
 * "margin of error in placements" the user sees. Printed dims are assigned to
 * the axis that matches the drawn orientation (a 12×9 room stays wider than
 * tall even if the text reads "9'1\"X12'3\"").
 */
export function printedRoomBox(
  room: { x: number; y: number; width: number; height: number },
  label: DetectedLabel,
): { x: number; y: number; width: number; height: number } | null {
  const pw = label.printedWidthFt;
  const ph = label.printedHeightFt;
  if (!pw || !ph) return null;
  // Sanity: the printed size must be in the same ballpark as the drawn box —
  // a mismatched read (another room's text caught in the crop) is rejected.
  const [a, b] = pw >= ph ? [pw, ph] : [ph, pw];
  const [dw, dh] = room.width >= room.height ? [room.width, room.height] : [room.height, room.width];
  if (a / dw > 1.6 || dw / a > 1.6 || b / dh > 1.6 || dh / b > 1.6) return null;
  const width = room.width >= room.height ? a : b;
  const height = room.width >= room.height ? b : a;
  return {
    x: r1(room.x + room.width / 2 - width / 2),
    y: r1(room.y + room.height / 2 - height / 2),
    width: r1(width),
    height: r1(height),
  };
}

/** True for parser-generated fallback names ("Room 3") that a printed label should replace. */
export const isGenericRoomName = (name?: string) => !name || /^room\s*\d*$/i.test(name.trim());

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface RoomDetection {
  doors: Door[];
  windows: Window[];
  items: PlacedItem[];
  /** detected furniture whose label matched nothing in the catalog */
  unmatched: string[];
}

/** Snap a piece flush to any wall it already nearly touches (CAD furniture is
 *  drawn wall-adjacent; a small detection gap reads as "floating" in 3D). */
const SNAP_FT = 0.75;
function wallSnap(
  x: number,
  y: number,
  w: number,
  d: number,
  room: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (x - room.x <= SNAP_FT) nx = room.x;
  else if (room.x + room.width - (x + w) <= SNAP_FT) nx = room.x + room.width - w;
  if (y - room.y <= SNAP_FT) ny = room.y;
  else if (room.y + room.height - (y + d) <= SNAP_FT) ny = room.y + room.height - d;
  return { x: nx, y: ny };
}

/**
 * Convert raw detections into store-ready records for `room`.
 * - openings snap onto the room's nearest wall (they're drawn ON walls anyway)
 * - furniture keeps its DETECTED footprint (that's the real drawn size) but is
 *   clamped inside the room and snapped flush to walls it nearly touches; the
 *   catalog supplies the height + colour.
 *
 * `room` may be the CORRECTED box (printed size): when an item carries room
 * fractions (fx/fy/fw/fd), those are used — the piece lands at its true spot in
 * the corrected room instead of inheriting the eroded pixel-box error.
 */
export function toRoomRecords(detected: DetectedItem[], room: Room): RoomDetection {
  const doors: Door[] = [];
  const windows: Window[] = [];
  const items: PlacedItem[] = [];
  const unmatched: string[] = [];

  // Absolute feet for an item inside THIS room box — by fraction when available.
  const abs = (d: DetectedItem) =>
    d.fx !== undefined && d.fy !== undefined && d.fw !== undefined && d.fd !== undefined
      ? {
          x: room.x + d.fx * room.width,
          y: room.y + d.fy * room.height,
          w: d.fw * room.width,
          d: d.fd * room.height,
        }
      : { x: d.x, y: d.y, w: d.w, d: d.d };

  for (const det of detected) {
    const a = abs(det);
    // opening: use its centre, snapped to the room's nearest wall
    if (det.type === "door" || det.type === "window") {
      const cx = a.x + a.w / 2 - room.x;
      const cy = a.y + a.d / 2 - room.y;
      const span = Math.max(a.w, a.d);
      const len = det.type === "window" ? clamp(span, 1.5, Math.max(1.5, room.width)) : DEFAULT_WINDOW_LEN;
      const s = snapToWall(cx, cy, room.width, room.height, Math.max(0.5, len / 2));
      if (det.type === "door") {
        doors.push({ id: uid("door"), x: r1(s.x + room.x), y: r1(s.y + room.y), orientation: s.orientation });
      } else {
        windows.push({
          id: uid("win"),
          x: r1(s.x + room.x),
          y: r1(s.y + room.y),
          orientation: s.orientation,
          length: r1(len),
        });
      }
      continue;
    }

    const spec = specForLabel(det.name);
    if (!spec) {
      unmatched.push(det.name);
      continue;
    }
    // keep the DRAWN footprint (min 1ft so a bad box can't collapse), clamped
    // in-room; the spec supplies height + colour.
    const w = clamp(r1(a.w || 2), 1, room.width);
    const dep = clamp(r1(a.d || 2), 1, room.height);
    const cx = clamp(a.x, room.x, Math.max(room.x, room.x + room.width - w));
    const cy = clamp(a.y, room.y, Math.max(room.y, room.y + room.height - dep));
    const snapped = wallSnap(cx, cy, w, dep, room);
    items.push({
      id: uid("pi"),
      catalogId: spec.catalogId,
      name: spec.name,
      roomId: room.id,
      x: r1(snapped.x),
      y: r1(snapped.y),
      rotation: 0,
      w,
      d: dep,
      h: spec.h,
      color: spec.color,
    });
  }
  return { doors, windows, items, unmatched };
}
