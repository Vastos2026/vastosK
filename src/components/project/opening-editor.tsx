"use client";

import { useRef, useState } from "react";
import type { Door, Window } from "@/lib/types";
import { DEFAULT_WINDOW_LEN, DOOR_LEN, snapToWall, type WallSnap } from "@/lib/openings";

/**
 * Interactive doors + windows layer for the per-room 2D plan. Rendered as a
 * transparent SVG on TOP of the PlanEditor, sharing its exact viewBox so the
 * openings sit on the room's walls. The layer itself is pointer-transparent
 * (furniture underneath stays draggable); only the openings capture pointer
 * events. Dragging an opening snaps it to the nearest wall via `snapToWall`.
 *
 * All coordinates here are ROOM-LOCAL (room pinned at 0,0, size W×H); the caller
 * translates back to plan space when persisting.
 */
export function OpeningEditor({
  planWidth: W,
  planHeight: H,
  pad = 2,
  doors,
  windows,
  selectedId,
  onSelect,
  onChangeDoor,
  onChangeWindow,
}: {
  planWidth: number;
  planHeight: number;
  /** must match PlanEditor's pad so the viewBoxes align exactly */
  pad?: number;
  doors: Door[];
  windows: Window[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeDoor: (id: string, patch: WallSnap) => void;
  onChangeWindow: (id: string, patch: WallSnap) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; kind: "door" | "window" } | null>(null);

  const toLocal = (e: React.PointerEvent) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const start = (e: React.PointerEvent, id: string, kind: "door" | "window") => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    onSelect(id);
    setDrag({ id, kind });
  };

  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const { x, y } = toLocal(e);
    if (drag.kind === "door") {
      onChangeDoor(drag.id, snapToWall(x, y, W, H, DOOR_LEN / 2));
    } else {
      const win = windows.find((w) => w.id === drag.id);
      const half = (win?.length ?? DEFAULT_WINDOW_LEN) / 2;
      onChangeWindow(drag.id, snapToWall(x, y, W, H, half));
    }
  };

  const end = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setDrag(null);
  };

  const cx = W / 2;
  const cy = H / 2;
  const acc = "var(--color-accent)";
  const win = "#5cc9e2";

  return (
    <svg
      ref={svgRef}
      viewBox={`${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {/* windows — a cyan sill segment with end ticks; a wider transparent rect
          is the drag/tap target so the thin line is easy to grab. */}
      {windows.map((w) => {
        const half = w.length / 2;
        const sel = w.id === selectedId;
        const horiz = w.orientation === "h";
        const x1 = horiz ? w.x - half : w.x;
        const x2 = horiz ? w.x + half : w.x;
        const y1 = horiz ? w.y : w.y - half;
        const y2 = horiz ? w.y : w.y + half;
        return (
          <g
            key={w.id}
            className="pointer-events-auto cursor-grab"
            onPointerDown={(e) => start(e, w.id, "window")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <rect
              x={(horiz ? w.x - half : w.x - 0.5) - 0}
              y={horiz ? w.y - 0.5 : w.y - half}
              width={horiz ? w.length : 1}
              height={horiz ? 1 : w.length}
              fill="transparent"
            />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={win} strokeWidth={sel ? 0.4 : 0.3} strokeLinecap="round" />
            {/* end ticks */}
            <line
              x1={horiz ? x1 : x1 - 0.35}
              y1={horiz ? y1 - 0.35 : y1}
              x2={horiz ? x1 : x1 + 0.35}
              y2={horiz ? y1 + 0.35 : y1}
              stroke={win}
              strokeWidth={0.12}
            />
            <line
              x1={horiz ? x2 : x2 - 0.35}
              y1={horiz ? y2 - 0.35 : y2}
              x2={horiz ? x2 : x2 + 0.35}
              y2={horiz ? y2 + 0.35 : y2}
              stroke={win}
              strokeWidth={0.12}
            />
            {sel && <circle cx={w.x} cy={w.y} r={0.6} fill={win} fillOpacity={0.25} stroke={win} strokeWidth={0.1} />}
          </g>
        );
      })}

      {/* doors — a wall break + hinge line + swing arc toward the room centre. */}
      {doors.map((d) => {
        const sel = d.id === selectedId;
        const horiz = d.orientation === "h";
        const L = DOOR_LEN;
        const gap = 0.35;
        let hinge: { x: number; y: number; w: number; h: number };
        let path: string;
        let leaf: { x1: number; y1: number; x2: number; y2: number };
        let brk: { x: number; y: number; w: number; h: number };
        if (horiz) {
          const x0 = d.x - L / 2;
          const x1 = d.x + L / 2;
          const dir = cy >= d.y ? 1 : -1;
          const tipY = d.y + dir * L;
          brk = { x: x0, y: d.y - gap, w: L, h: gap * 2 };
          leaf = { x1: x0, y1: d.y, x2: x0, y2: tipY };
          path = `M ${x0} ${tipY} A ${L} ${L} 0 0 ${dir > 0 ? 1 : 0} ${x1} ${d.y}`;
          hinge = { x: x0 - 0.4, y: Math.min(d.y, tipY) - 0.4, w: L + 0.8, h: L + 0.8 };
        } else {
          const y0 = d.y - L / 2;
          const y1 = d.y + L / 2;
          const dir = cx >= d.x ? 1 : -1;
          const tipX = d.x + dir * L;
          brk = { x: d.x - gap, y: y0, w: gap * 2, h: L };
          leaf = { x1: d.x, y1: y0, x2: tipX, y2: y0 };
          path = `M ${tipX} ${y0} A ${L} ${L} 0 0 ${dir > 0 ? 0 : 1} ${d.x} ${y1}`;
          hinge = { x: Math.min(d.x, tipX) - 0.4, y: y0 - 0.4, w: L + 0.8, h: L + 0.8 };
        }
        return (
          <g
            key={d.id}
            className="pointer-events-auto cursor-grab"
            onPointerDown={(e) => start(e, d.id, "door")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            {/* hit target over the whole leaf sweep */}
            <rect x={hinge.x} y={hinge.y} width={hinge.w} height={hinge.h} fill="transparent" />
            <rect x={brk.x} y={brk.y} width={brk.w} height={brk.h} fill="var(--color-bg)" />
            <line x1={leaf.x1} y1={leaf.y1} x2={leaf.x2} y2={leaf.y2} stroke={acc} strokeWidth={sel ? 0.22 : 0.16} />
            <path d={path} fill="none" stroke={acc} strokeOpacity={sel ? 1 : 0.75} strokeWidth={sel ? 0.18 : 0.12} />
            {sel && <circle cx={d.x} cy={d.y} r={0.6} fill={acc} fillOpacity={0.25} stroke={acc} strokeWidth={0.1} />}
          </g>
        );
      })}
    </svg>
  );
}
