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
  type EditorShape,
  type ResizeHandle,
} from "@/lib/plan-editor/geometry";
import type { PlacedOpening } from "@/lib/types";
import type { Pt } from "@/lib/sketch/geometry";

/**
 * The Plan Editor's drawing surface. Renders room rectangles over the
 * uploaded plan image (the background image itself is rendered by the PARENT
 * page, behind this transparent canvas — see plan/page.tsx) and handles every
 * pointer interaction: select/move/resize a room, and place/drag/resize an
 * opening on the SELECTED room's walls.
 *
 * Follows sketch-canvas.tsx's wrapping-div + canvas + ResizeObserver +
 * normalized-[0,1] + render-on-state-change pattern.
 */

export interface EditorRoom {
  id: string;
  name: string;
  color: string;
  shape: EditorShape;
  placedOpenings: PlacedOpening[];
}

const DOOR_COLOR = "#e6c15c";
const WINDOW_COLOR = "#6da8e2";
const ACCENT = "#f2f2f2";
const HANDLE_PX = 7;
const WALL_HIT_PX = 12;
const OPENING_END_PX = 8;
const OPENING_BODY_PX = 10;
const CLICK_SLOP_PX = 4;

type DragMode =
  | { kind: "move-room"; id: string; startShape: EditorShape; startPt: Pt }
  | { kind: "resize-room"; id: string; handle: ResizeHandle; startShape: EditorShape; startPt: Pt }
  | { kind: "move-opening"; roomId: string; openingId: string }
  | { kind: "resize-opening"; roomId: string; openingId: string; end: "a" | "b" }
  | null;

export function PlanEditorCanvas({
  rooms,
  selectedId,
  onSelect,
  onShapeChange,
  onOpeningsChange,
}: {
  rooms: EditorRoom[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onShapeChange: (id: string, shape: EditorShape) => void;
  onOpeningsChange: (id: string, openings: PlacedOpening[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const renderRef = useRef<() => void>(() => {});
  const dragRef = useRef<DragMode>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<Pt | null>(null);
  const [dragging, setDragging] = useState(false);

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
          const [ax, ay] = px(wallPointAt(room.shape, o, "a"));
          const [bx, by] = px(wallPointAt(room.shape, o, "b"));
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.lineWidth = 6;
          ctx.strokeStyle = o.type === "door" ? DOOR_COLOR : WINDOW_COLOR;
          ctx.stroke();
          if (selected) {
            ctx.beginPath();
            ctx.arc(ax, ay, 4, 0, Math.PI * 2);
            ctx.arc(bx, by, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#0a0a0a";
            ctx.fill();
          }
        }

        // Hover preview: where a click would add a new opening on the
        // selected room, if not currently over an existing one.
        if (selected && pointer && !dragging) {
          const tol = WALL_HIT_PX / Math.max(w, h);
          const hit = wallHitTest(room.shape, pointer, tol);
          const onExisting = room.placedOpenings.some(
            (o) => pxDist(openingPoint(room.shape, o), pointer, w, h) <= OPENING_BODY_PX,
          );
          if (hit && !onExisting) {
            const [hx, hy] = px(openingPoint(room.shape, hit));
            ctx.beginPath();
            ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
    };
    renderRef.current = render;
    render();
  }, [rooms, selectedId, pointer, dragging]);

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
        style={{ cursor: dragging ? "grabbing" : "default", touchAction: "none" }}
        onPointerMove={(e) => {
          const p = toNorm(e);
          setPointer(p);
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
            // detecting the initial click.
            const hit = wallHitTest(room.shape, p, 1);
            if (!hit || hit.wall !== opening.wall) return;
            const { t, span } = clampOpeningSpan(hit.t, opening.span);
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, t, span } : o)),
            );
          } else if (drag.kind === "resize-opening") {
            const room = rooms.find((r) => r.id === drag.roomId);
            const opening = room?.placedOpenings.find((o) => o.id === drag.openingId);
            if (!room || !opening) return;
            const hit = wallHitTest(room.shape, p, 1);
            if (!hit || hit.wall !== opening.wall) return;
            // Dragging one end moves that end while the OTHER end stays put.
            const otherT = drag.end === "a" ? opening.t + opening.span / 2 : opening.t - opening.span / 2;
            const newT = (hit.t + otherT) / 2;
            const newSpan = Math.abs(hit.t - otherT);
            const { t, span } = clampOpeningSpan(newT, newSpan);
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, t, span } : o)),
            );
          }
        }}
        onPointerLeave={() => setPointer(null)}
        onPointerDown={(e) => {
          const p = toNorm(e);
          downRef.current = { x: e.clientX, y: e.clientY };
          const { w, h } = sizeRef.current;

          if (selected) {
            // Opening end-handles take priority (finest-grained target).
            for (const o of selected.placedOpenings) {
              const a = wallPointAt(selected.shape, o, "a");
              const b = wallPointAt(selected.shape, o, "b");
              if (pxDist(a, p, w, h) <= OPENING_END_PX) {
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "a" };
                setDragging(true);
                return;
              }
              if (pxDist(b, p, w, h) <= OPENING_END_PX) {
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "b" };
                setDragging(true);
                return;
              }
            }
            // Opening body — move it along its wall.
            for (const o of selected.placedOpenings) {
              const center = openingPoint(selected.shape, o);
              if (pxDist(center, p, w, h) <= OPENING_BODY_PX) {
                dragRef.current = { kind: "move-opening", roomId: selected.id, openingId: o.id };
                setDragging(true);
                return;
              }
            }
            // Resize handle.
            const handle = hitTestHandle(selected.shape, p, tolNorm());
            if (handle) {
              dragRef.current = { kind: "resize-room", id: selected.id, handle, startShape: selected.shape, startPt: p };
              setDragging(true);
              return;
            }
            // An empty spot on the selected room's wall is handled on
            // pointerup (below) — only if this turns out to be a plain
            // click, not the start of a room-move drag.
          }

          // Room body (topmost match) — select, and prep a move-drag.
          for (let i = rooms.length - 1; i >= 0; i--) {
            const room = rooms[i];
            if (pointInShape(room.shape, p)) {
              onSelect(room.id);
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
          if (movedPx > CLICK_SLOP_PX) return; // a real drag already applied its own changes via onPointerMove

          if (!selected) return;
          const p = toNorm(e);
          const { w, h } = sizeRef.current;

          // A plain click (no drag) on an existing opening cycles its type:
          // door -> window -> removed.
          for (const o of selected.placedOpenings) {
            if (pxDist(openingPoint(selected.shape, o), p, w, h) <= OPENING_BODY_PX) {
              const next =
                o.type === "door"
                  ? selected.placedOpenings.map((x) => (x.id === o.id ? { ...x, type: "window" as const } : x))
                  : selected.placedOpenings.filter((x) => x.id !== o.id);
              onOpeningsChange(selected.id, next);
              return;
            }
          }
          if (drag) return; // a resize-handle/room-select click that didn't move enough to count as a drag

          // Empty wall of the selected room — add a new door there.
          const hit = wallHitTest(selected.shape, p, WALL_HIT_PX / Math.max(w, h));
          if (hit) {
            const { t, span } = clampOpeningSpan(hit.t, 0.12);
            onOpeningsChange(selected.id, [
              ...selected.placedOpenings,
              { id: `o-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: "door", wall: hit.wall, t, span },
            ]);
          }
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

function wallPointAt(shape: EditorShape, o: PlacedOpening, end: "a" | "b"): Pt {
  const t = end === "a" ? o.t - o.span / 2 : o.t + o.span / 2;
  return openingPoint(shape, { wall: o.wall, t: Math.max(0, Math.min(1, t)) });
}

function pxDist(a: Pt, b: Pt, w: number, h: number): number {
  return Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
}
