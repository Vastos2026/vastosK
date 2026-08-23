"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampOpeningSpan,
  hitTestHandle,
  moveShape,
  openingPoint,
  pointInShape,
  resizeShape,
  wallHitTest,
  wallLengthFt,
  STANDARD_DOOR_WIDTH_FT,
  STANDARD_WINDOW_WIDTH_FT,
  type EditorShape,
  type ResizeHandle,
} from "@/lib/plan-editor/geometry";
import type { PlacedOpening } from "@/lib/types";
import type { GreyboxWall } from "@/lib/greybox/types";
import type { Pt } from "@/lib/sketch/geometry";

/**
 * The Plan Editor's drawing surface. Renders room rectangles over the
 * uploaded plan image (the background image itself is rendered by the PARENT
 * page, behind this transparent canvas — see plan/page.tsx) and handles every
 * pointer interaction: select/move/resize a room, and place/drag/resize an
 * opening on the SELECTED room's walls.
 *
 * Wrapping-div + canvas + ResizeObserver +
 * normalized-[0,1] + render-on-state-change pattern.
 */

export interface EditorRoom {
  id: string;
  name: string;
  color: string;
  shape: EditorShape;
  placedOpenings: PlacedOpening[];
  /** Real-world east-west extent in feet, when known — falls back to DEFAULT_ROOM_SIZE_FT
   *  (see src/lib/pipeline/empty-plan.ts) when the room's real feet dimensions aren't known.
   *  Used to size newly-placed doors/windows to a realistic real-world width regardless of
   *  how big or small the room happens to be drawn on screen. */
  widthFt?: number;
  /** Real-world north-south extent in feet, when known. Same fallback convention as widthFt. */
  depthFt?: number;
}

/** The active editing tool. "select" is move/resize/drag — everything else is unchanged from
 *  before this tool system existed. The other three are single-purpose, cross-room actions. */
export type EditorTool = "select" | "door" | "window" | "delete";

/** `room.widthFt`/`depthFt`'s real-length-in-feet for `wall`, falling back to 10 when the
 *  room's real dimensions aren't known yet — the single fallback point every create/move/
 *  resize/render call in this file shares, so they can't drift from each other. */
function wallLengthFtFor(room: { widthFt?: number; depthFt?: number }, wall: GreyboxWall): number {
  return wallLengthFt(wall, room.widthFt ?? 10, room.depthFt ?? 10);
}

export const DOOR_COLOR = "#e6c15c";
export const WINDOW_COLOR = "#6da8e2";
const DELETE_COLOR = "#e35c5c";
const ACCENT = "#f2f2f2";
const HANDLE_PX = 7;
const WALL_HIT_PX = 12;
const OPENING_END_PX = 8;
const OPENING_BODY_PX = 10;
const CLICK_SLOP_PX = 4;

const TOOL_COLOR: Record<EditorTool, string> = {
  select: ACCENT,
  door: DOOR_COLOR,
  window: WINDOW_COLOR,
  delete: DELETE_COLOR,
};

type DragMode =
  | { kind: "move-room"; id: string; startShape: EditorShape; startPt: Pt }
  | { kind: "resize-room"; id: string; handle: ResizeHandle; startShape: EditorShape; startPt: Pt }
  | { kind: "move-opening"; roomId: string; openingId: string }
  | { kind: "resize-opening"; roomId: string; openingId: string; end: "a" | "b" }
  | null;

/** Nearest wall to `p` across EVERY room (not just the selected one), for the door/window tools —
 *  the user shouldn't have to select a room before adding an opening to it. */
function findWallAcrossRooms(
  rooms: EditorRoom[],
  p: Pt,
  tol: number,
): { room: EditorRoom; wall: ReturnType<typeof wallHitTest> } | null {
  let best: { room: EditorRoom; wall: ReturnType<typeof wallHitTest>; dist: number } | null = null;
  for (const room of rooms) {
    const hit = wallHitTest(room.shape, p, tol);
    if (!hit) continue;
    const wp = openingPoint(room.shape, hit);
    const dist = Math.hypot(wp[0] - p[0], wp[1] - p[1]);
    if (!best || dist < best.dist) best = { room, wall: hit, dist };
  }
  return best;
}

/** Nearest EXISTING opening to `p` across every room, for the delete tool. */
function findOpeningAcrossRooms(
  rooms: EditorRoom[],
  p: Pt,
  tolPx: number,
  w: number,
  h: number,
): { room: EditorRoom; opening: PlacedOpening } | null {
  let best: { room: EditorRoom; opening: PlacedOpening; dist: number } | null = null;
  for (const room of rooms) {
    for (const o of room.placedOpenings) {
      const dist = pxDist(openingPoint(room.shape, o), p, w, h);
      if (dist <= tolPx && (!best || dist < best.dist)) best = { room, opening: o, dist };
    }
  }
  return best ? { room: best.room, opening: best.opening } : null;
}

export function PlanEditorCanvas({
  rooms,
  selectedId,
  tool,
  onSelect,
  onShapeChange,
  onOpeningsChange,
  onInteractionStart,
  onCommit,
}: {
  rooms: EditorRoom[];
  selectedId: string | null;
  tool: EditorTool;
  onSelect: (id: string | null) => void;
  onShapeChange: (id: string, shape: EditorShape) => void;
  onOpeningsChange: (id: string, openings: PlacedOpening[]) => void;
  /** Fires once at the START of a state-changing interaction (drag or tool click), before any
   *  mutation — the caller snapshots current state here so it can push an undo entry on commit. */
  onInteractionStart?: () => void;
  /** Fires once when a state-changing interaction FINISHES (drag release, or a tool click that
   *  added/deleted an opening) — the caller pushes the pre-interaction snapshot to undo history. */
  onCommit?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const renderRef = useRef<() => void>(() => {});
  const dragRef = useRef<DragMode>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<Pt | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deleteHover, setDeleteHover] = useState<{ room: EditorRoom; opening: PlacedOpening } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: r.width, h: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderRef.current();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      const px = (p: Pt): Pt => [p[0] * w, p[1] * h];

      for (const room of rooms) {
        const selected = room.id === selectedId;
        const { x, y, w: rw, h: rh } = room.shape;
        const [x0, y0] = px([x, y]);
        const [x1, y1] = px([x + rw, y + rh]);

        ctx.fillStyle = `${room.color}2e`;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.strokeStyle = room.color;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

        ctx.fillStyle = room.color;
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(room.name || "Room", x0 + 6, y0 + 5);

        if (selected) {
          for (const [hx, hy] of cornerAndEdgeHandles(room.shape).map(px)) {
            ctx.beginPath();
            ctx.arc(hx, hy, HANDLE_PX, 0, Math.PI * 2);
            ctx.fillStyle = ACCENT;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#0a0a0a";
            ctx.stroke();
          }
        }

        for (const o of room.placedOpenings) {
          const [ax, ay] = px(wallPointAt(room, o, "a"));
          const [bx, by] = px(wallPointAt(room, o, "b"));
          const hoveredForDelete =
            tool === "delete" && deleteHover?.room.id === room.id && deleteHover.opening.id === o.id;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.lineWidth = hoveredForDelete ? 14 : 11;
          ctx.strokeStyle = hoveredForDelete ? DELETE_COLOR : o.type === "door" ? DOOR_COLOR : WINDOW_COLOR;
          ctx.stroke();
          if (selected) {
            ctx.beginPath();
            ctx.arc(ax, ay, 4, 0, Math.PI * 2);
            ctx.arc(bx, by, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#0a0a0a";
            ctx.fill();
          }
        }
      }

      // Tool feedback: a small dot follows the cursor in the active tool's
      // colour (door = yellow, window = blue, delete = red), so the tool is
      // always visible at a glance. When over a valid target — a wall for
      // door/window, an existing opening for delete — a bigger snapped ring
      // previews exactly where the action will land.
      if (pointer && !dragging) {
        if (tool === "door" || tool === "window") {
          const tol = WALL_HIT_PX / Math.max(w, h);
          const found = findWallAcrossRooms(rooms, pointer, tol);
          if (found?.wall) {
            const [hx, hy] = px(openingPoint(found.room.shape, found.wall));
            ctx.beginPath();
            ctx.arc(hx, hy, 7, 0, Math.PI * 2);
            ctx.strokeStyle = TOOL_COLOR[tool];
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          const [px_, py_] = px(pointer);
          ctx.beginPath();
          ctx.arc(px_, py_, 4, 0, Math.PI * 2);
          ctx.fillStyle = TOOL_COLOR[tool];
          ctx.fill();
        } else if (tool === "delete") {
          const [px_, py_] = px(pointer);
          ctx.beginPath();
          ctx.arc(px_, py_, deleteHover ? 7 : 4, 0, Math.PI * 2);
          ctx.fillStyle = deleteHover ? "transparent" : DELETE_COLOR;
          if (deleteHover) {
            ctx.strokeStyle = DELETE_COLOR;
            ctx.lineWidth = 2;
            ctx.stroke();
          } else {
            ctx.fill();
          }
        }
      }
    };
    renderRef.current = render;
    render();
  }, [rooms, selectedId, pointer, dragging, tool, deleteHover]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const tolNorm = () => {
    const { w, h } = sizeRef.current;
    return { x: HANDLE_PX / Math.max(w, 1), y: HANDLE_PX / Math.max(h, 1) };
  };

  const selected = rooms.find((r) => r.id === selectedId) ?? null;

  return (
    <div ref={wrapRef} className="absolute inset-0 h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{
          cursor: dragging ? "grabbing" : tool !== "select" ? "none" : "default",
          touchAction: "none",
        }}
        onPointerMove={(e) => {
          const p = toNorm(e);
          setPointer(p);
          if (tool === "delete") {
            const { w, h } = sizeRef.current;
            setDeleteHover(findOpeningAcrossRooms(rooms, p, OPENING_BODY_PX, w, h));
          } else if (deleteHover) {
            setDeleteHover(null);
          }
          const drag = dragRef.current;
          if (!drag) return;

          if (drag.kind === "move-room") {
            const dx = p[0] - drag.startPt[0];
            const dy = p[1] - drag.startPt[1];
            onShapeChange(drag.id, moveShape(drag.startShape, dx, dy));
          } else if (drag.kind === "resize-room") {
            const dx = p[0] - drag.startPt[0];
            const dy = p[1] - drag.startPt[1];
            onShapeChange(drag.id, resizeShape(drag.startShape, drag.handle, dx, dy));
          } else if (drag.kind === "move-opening") {
            const room = rooms.find((r) => r.id === drag.roomId);
            const opening = room?.placedOpenings.find((o) => o.id === drag.openingId);
            if (!room || !opening) return;
            // Generous tolerance while actively dragging an already-selected
            // opening — the pointer can stray off the exact wall line while
            // moving fast; the tight WALL_HIT_PX tolerance is only for
            // detecting the initial click. wallHitTest always returns the
            // NEAREST of the 4 walls (never null at tol=1), so once the
            // pointer crosses a corner into the region closer to an adjacent
            // wall, hit.wall differs from opening.wall — reassign it instead
            // of freezing, so the drag continues around the perimeter.
            const hit = wallHitTest(room.shape, p, 1);
            if (!hit) return;
            // widthFt is unchanged by a move — only its position (and possibly its wall, on a
            // corner crossing) changes. Re-derive the half-width FRACTION against the (possibly
            // new, post-reassignment) wall's real length purely to clamp `t`; discard the
            // returned span fraction, since widthFt itself is never stored as a fraction.
            const halfFrac = opening.widthFt / (2 * wallLengthFtFor(room, hit.wall));
            const { t } = clampOpeningSpan(hit.t, halfFrac * 2);
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, wall: hit.wall, t } : o)),
            );
          } else if (drag.kind === "resize-opening") {
            const room = rooms.find((r) => r.id === drag.roomId);
            const opening = room?.placedOpenings.find((o) => o.id === drag.openingId);
            if (!room || !opening) return;
            const hit = wallHitTest(room.shape, p, 1);
            if (!hit || hit.wall !== opening.wall) return;
            const wallLenFt = wallLengthFtFor(room, opening.wall);
            // Dragging one end moves that end while the OTHER end stays put — otherT is derived
            // from the opening's CURRENT real-world half-width, converted to this wall's fraction.
            const halfFrac = opening.widthFt / (2 * wallLenFt);
            const otherT = drag.end === "a" ? opening.t + halfFrac : opening.t - halfFrac;
            const newT = (hit.t + otherT) / 2;
            const newSpanFrac = Math.abs(hit.t - otherT);
            const { t, span: clampedSpanFrac } = clampOpeningSpan(newT, newSpanFrac);
            // Convert the clamped fraction back into feet using the CURRENT wall length before
            // storing — this is the fix: widthFt is real feet, never a fraction frozen in time.
            const newWidthFt = clampedSpanFrac * wallLenFt;
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, t, widthFt: newWidthFt } : o)),
            );
          }
        }}
        onPointerLeave={() => setPointer(null)}
        onPointerDown={(e) => {
          const p = toNorm(e);
          downRef.current = { x: e.clientX, y: e.clientY };
          const { w, h } = sizeRef.current;

          // The door/window/delete tools are click-only (handled entirely on
          // pointerup below, across ALL rooms, not just the selected one) —
          // don't start a room-move/resize drag while one of them is active.
          if (tool !== "select") return;

          if (selected) {
            // Opening end-handles take priority (finest-grained target).
            for (const o of selected.placedOpenings) {
              const a = wallPointAt(selected, o, "a");
              const b = wallPointAt(selected, o, "b");
              if (pxDist(a, p, w, h) <= OPENING_END_PX) {
                onInteractionStart?.();
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "a" };
                setDragging(true);
                return;
              }
              if (pxDist(b, p, w, h) <= OPENING_END_PX) {
                onInteractionStart?.();
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "b" };
                setDragging(true);
                return;
              }
            }
            // Opening body — move it along its wall.
            for (const o of selected.placedOpenings) {
              const center = openingPoint(selected.shape, o);
              if (pxDist(center, p, w, h) <= OPENING_BODY_PX) {
                onInteractionStart?.();
                dragRef.current = { kind: "move-opening", roomId: selected.id, openingId: o.id };
                setDragging(true);
                return;
              }
            }
            // Resize handle.
            const handle = hitTestHandle(selected.shape, p, tolNorm());
            if (handle) {
              onInteractionStart?.();
              dragRef.current = { kind: "resize-room", id: selected.id, handle, startShape: selected.shape, startPt: p };
              setDragging(true);
              return;
            }
          }

          // Room body (topmost match) — select, and prep a move-drag.
          for (let i = rooms.length - 1; i >= 0; i--) {
            const room = rooms[i];
            if (pointInShape(room.shape, p)) {
              onSelect(room.id);
              onInteractionStart?.();
              dragRef.current = { kind: "move-room", id: room.id, startShape: room.shape, startPt: p };
              setDragging(true);
              return;
            }
          }
          onSelect(null);
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          const down = downRef.current;
          dragRef.current = null;
          downRef.current = null;
          setDragging(false);
          if (!down) return;
          const movedPx = Math.hypot(e.clientX - down.x, e.clientY - down.y);
          const isClick = movedPx <= CLICK_SLOP_PX;
          const p = toNorm(e);
          const { w, h } = sizeRef.current;

          if (tool === "door" || tool === "window") {
            if (!isClick) return;
            const found = findWallAcrossRooms(rooms, p, WALL_HIT_PX / Math.max(w, h));
            if (!found?.wall) return;
            onInteractionStart?.();
            // Size the new opening to a realistic real-world width (doors ~3ft, windows ~4ft)
            // as a fraction of the ACTUAL wall it lands on, rather than a flat fraction of the
            // wall's on-screen length — a door on a huge wall shouldn't become huge, nor tiny
            // on a small one. North/south walls run east-west (length = room width); east/west
            // walls run north-south (length = room depth) — matches build-scene.ts's wallFrame.
            const targetWidthFt = tool === "door" ? STANDARD_DOOR_WIDTH_FT : STANDARD_WINDOW_WIDTH_FT;
            // clampOpeningSpan is fraction-based, so pass the target width AS a fraction of this
            // wall's real length purely to get a clamped `t` (kept fully on the wall) — its
            // returned span fraction is discarded; the FIXED real-world targetWidthFt is what
            // gets stored, never a fraction of whatever wall length happened to produce it.
            const { t } = clampOpeningSpan(
              found.wall.t,
              targetWidthFt / wallLengthFtFor(found.room, found.wall.wall),
            );
            onOpeningsChange(found.room.id, [
              ...found.room.placedOpenings,
              {
                id: `o-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                type: tool,
                wall: found.wall.wall,
                t,
                widthFt: targetWidthFt,
              },
            ]);
            onSelect(found.room.id);
            onCommit?.();
            return;
          }

          if (tool === "delete") {
            if (!isClick) return;
            const found = findOpeningAcrossRooms(rooms, p, OPENING_BODY_PX, w, h);
            if (!found) return;
            onInteractionStart?.();
            onOpeningsChange(
              found.room.id,
              found.room.placedOpenings.filter((o) => o.id !== found.opening.id),
            );
            onCommit?.();
            return;
          }

          // tool === "select": a real drag (move/resize room, drag/resize an
          // opening) just applied its change live via onPointerMove — commit
          // it to undo history now. A plain click (room/opening select, or a
          // handle grabbed then released without moving) has nothing to
          // commit — adding/removing openings is exclusively the door/
          // window/delete tools' job now.
          if (!isClick && drag) onCommit?.();
        }}
      />
    </div>
  );
}

function cornerAndEdgeHandles(s: EditorShape): Pt[] {
  return [
    [s.x, s.y],
    [s.x + s.w / 2, s.y],
    [s.x + s.w, s.y],
    [s.x + s.w, s.y + s.h / 2],
    [s.x + s.w, s.y + s.h],
    [s.x + s.w / 2, s.y + s.h],
    [s.x, s.y + s.h],
    [s.x, s.y + s.h / 2],
  ];
}

function wallPointAt(room: EditorRoom, o: PlacedOpening, end: "a" | "b"): Pt {
  // o.widthFt is fixed real-world feet — derive the current normalised half-width fraction
  // fresh here (never stored) to combine with `t` for the on-screen end-handle position.
  const halfFrac = o.widthFt / (2 * wallLengthFtFor(room, o.wall));
  const t = end === "a" ? o.t - halfFrac : o.t + halfFrac;
  return openingPoint(room.shape, { wall: o.wall, t: Math.max(0, Math.min(1, t)) });
}

function pxDist(a: Pt, b: Pt, w: number, h: number): number {
  return Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
}
