/**
 * Door / window ("opening") helpers for the per-room 2D editor.
 *
 * Openings live in the floor plan in PLAN feet (x,y on a wall). The room design
 * page edits them in ROOM-LOCAL feet (room pinned at 0,0), so it needs to know
 * which openings sit on a given room's perimeter and how to snap a dragged
 * opening back onto the nearest wall. Kept framework-free so both the page and
 * the SVG editor can share one source of truth.
 */

import type { Door, Room, Window } from "./types";
import { layoutSize } from "./pipeline/empty-plan";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Fixed door leaf width (ft) — doors have no length field in the model. */
export const DOOR_LEN = 2.8;
/** Default window opening width (ft) for newly-placed windows. */
export const DEFAULT_WINDOW_LEN = 3;

/** True if (x,y) lies on `room`'s perimeter within `tol` ft. */
export function onRoomPerimeter(x: number, y: number, room: Room, tol = 0.9): boolean {
  const { x: rx, y: ry } = room;
  // Pure geometry fallback for a room whose real dimensions are unknown — see
  // layoutSize's doc comment (pipeline/empty-plan.ts). Never a claimed size.
  const { width: w, height: h } = layoutSize(room);
  const withinX = x >= rx - tol && x <= rx + w + tol;
  const withinY = y >= ry - tol && y <= ry + h + tol;
  const onVertical = (Math.abs(x - rx) <= tol || Math.abs(x - (rx + w)) <= tol) && withinY;
  const onHorizontal = (Math.abs(y - ry) <= tol || Math.abs(y - (ry + h)) <= tol) && withinX;
  return onVertical || onHorizontal;
}

export interface WallSnap {
  x: number;
  y: number;
  orientation: "h" | "v";
}

/**
 * Snap a point to the nearest of a room's four walls, in ROOM-LOCAL coords
 * (room at 0,0, size W×H). `halfSpan` (half the opening's along-wall width)
 * keeps the opening from hanging off a wall end. Openings on the top/bottom
 * walls are horizontal ("h"); on the left/right walls, vertical ("v").
 */
export function snapToWall(
  px: number,
  py: number,
  W: number,
  H: number,
  halfSpan = 0.5,
): WallSnap {
  const dTop = Math.abs(py);
  const dBottom = Math.abs(H - py);
  const dLeft = Math.abs(px);
  const dRight = Math.abs(W - px);
  const nearest = Math.min(dTop, dBottom, dLeft, dRight);
  const cx = clamp(px, halfSpan, Math.max(halfSpan, W - halfSpan));
  const cy = clamp(py, halfSpan, Math.max(halfSpan, H - halfSpan));
  if (nearest === dTop) return { x: cx, y: 0, orientation: "h" };
  if (nearest === dBottom) return { x: cx, y: H, orientation: "h" };
  if (nearest === dLeft) return { x: 0, y: cy, orientation: "v" };
  return { x: W, y: cy, orientation: "v" };
}

/** Translate a plan-space opening into room-local coords (room pinned at 0,0). */
export function toLocalDoor(d: Door, room: Room): Door {
  return { ...d, x: d.x - room.x, y: d.y - room.y };
}
export function toLocalWindow(w: Window, room: Room): Window {
  return { ...w, x: w.x - room.x, y: w.y - room.y };
}
