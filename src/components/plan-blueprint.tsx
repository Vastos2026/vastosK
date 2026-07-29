"use client";

import { useId } from "react";
import type { Door, FloorPlan, PlacedItem, Room, Window } from "@/lib/types";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import { cn } from "@/lib/utils";

/**
 * Architectural redraw of a parsed floor plan — not a stack of labelled boxes.
 *
 * Walls are drawn as solid "poché" mass carved out of the room rectangles (so
 * adjacent rooms share a single partition and the building reads as one
 * structure), doors become real openings with a swing arc, and windows use the
 * standard double-line glass symbol. The viewBox tracks the building's true
 * footprint so the reconstruction keeps the same proportions as the detected
 * geometry instead of a forced square.
 */
export function PlanBlueprint({
  plan,
  items = [],
  className,
  showLabels = true,
}: {
  plan: FloorPlan;
  /** furniture / fixtures detected on the plan, drawn as footprints */
  items?: PlacedItem[];
  className?: string;
  showLabels?: boolean;
}) {
  // useId() contains ":" which is brittle inside SVG url(#…) references.
  const maskId = `wall-${useId().replace(/:/g, "")}`;
  const rooms = plan.rooms;

  // Footprint = the extent of everything we draw, so the drawing fills the box
  // at the plan's real aspect ratio (matching the detected geometry's shape).
  const box = footprint(plan);
  const pad = Math.max(1, Math.max(box.w, box.h) * 0.04);
  const vbX = box.x - pad;
  const vbY = box.y - pad;
  const vbW = box.w + pad * 2;
  const vbH = box.h + pad * 2;

  // Wall thickness in feet — scales gently with the plan so it reads at any size.
  const t = clamp(Math.max(box.w, box.h) * 0.02, 0.5, 1.1);
  const inset = t / 2;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };

  // Interior floor rectangle for a room (the carved-out space inside its
  // walls). Uses layoutSize's placeholder box for a room whose real
  // dimensions are unknown — this is pure drawing geometry, never a claimed
  // size (the dimension LABEL below checks the room's real width/height).
  const interior = (r: Room) => {
    const size = layoutSize(r);
    return {
      x: r.x + inset,
      y: r.y + inset,
      w: Math.max(0.2, size.width - t),
      h: Math.max(0.2, size.height - t),
    };
  };

  const labelled = showLabels ? labelTargets(rooms) : [];

  return (
    <svg
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      className={cn("h-full w-full", className)}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* Wall mask: union of full room rects MINUS their interiors = the wall
            lattice. Shared edges collapse to one partition automatically. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={vbX} y={vbY} width={vbW} height={vbH}>
          <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="black" />
          {rooms.map((r) => {
            const size = layoutSize(r);
            return <rect key={`m-${r.id}`} x={r.x} y={r.y} width={size.width} height={size.height} fill="white" />;
          })}
          {rooms.map((r) => {
            const i = interior(r);
            return <rect key={`mi-${r.id}`} x={i.x} y={i.y} width={i.w} height={i.h} fill="black" />;
          })}
        </mask>
      </defs>

      {/* Building floor — so corridors / stairs read as interior space rather
          than holes punched through the plan. */}
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="var(--color-surface)" />

      {/* Room floors (the carved interiors) + a faint per-room tint. */}
      {rooms.map((r) => {
        const i = interior(r);
        return (
          <g key={`floor-${r.id}`}>
            <rect x={i.x} y={i.y} width={i.w} height={i.h} fill="var(--color-surface-2)" />
            <rect x={i.x} y={i.y} width={i.w} height={i.h} fill={r.color} fillOpacity={0.14} />
          </g>
        );
      })}

      {/* Wall mass. */}
      <rect
        x={vbX}
        y={vbY}
        width={vbW}
        height={vbH}
        fill="var(--color-border-strong)"
        mask={`url(#${maskId})`}
      />

      {/* Bold building outline so the envelope reads as the outer wall. */}
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={t * 0.9}
        strokeLinejoin="round"
      />

      {/* Detected interior walls, faint — adds structure beyond the room boxes. */}
      {plan.walls?.map((w) => (
        <line
          key={w.id}
          x1={w.x1}
          y1={w.y1}
          x2={w.x2}
          y2={w.y2}
          stroke="var(--color-border-strong)"
          strokeOpacity={0.5}
          strokeWidth={t * 0.35}
          strokeLinecap="round"
        />
      ))}

      {/* Windows — glass symbol set into the wall. */}
      {plan.windows?.map((win) => (
        <WindowSymbol key={win.id} win={win} t={t} />
      ))}

      {/* Doors — opening cut through the wall + swing arc (the circulation). */}
      {plan.doors.map((d) => (
        <DoorSymbol key={d.id} door={d} t={t} center={center} />
      ))}

      {/* Detected furniture / fixtures — drawn as footprints on the floor. */}
      {items.map((it) => (
        <rect
          key={it.id}
          x={it.x}
          y={it.y}
          width={Math.max(0.4, it.w)}
          height={Math.max(0.4, it.d)}
          rx={t * 0.3}
          fill={it.color}
          fillOpacity={0.85}
          stroke="var(--color-bg)"
          strokeWidth={t * 0.12}
        />
      ))}

      {/* Labels — room name + dimensions, only where they fit. */}
      {labelled.map((r) => {
        const i = interior(r);
        const minSide = Math.min(i.w, i.h);
        const nameSize = clamp(Math.min(i.w / Math.max(6, r.name.length * 0.62), minSide * 0.34), 0.6, 1.5);
        const showDims = minSide > 5.5;
        const cx = i.x + i.w / 2;
        const cy = i.y + i.h / 2;
        return (
          <g key={`label-${r.id}`} className="pointer-events-none">
            <text
              x={cx}
              y={showDims ? cy - nameSize * 0.55 : cy}
              fontSize={nameSize}
              fill="var(--color-foreground)"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ letterSpacing: nameSize * 0.04 }}
            >
              {r.name.toUpperCase()}
            </text>
            {showDims && (
              <text
                x={cx}
                y={cy + nameSize * 0.7}
                fontSize={nameSize * 0.74}
                fill="var(--color-faint)"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {r.width !== undefined && r.height !== undefined
                  ? `${round(r.width)}×${round(r.height)} ft`
                  : "Size not available"}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A door: a floor-coloured gap that cuts the wall, plus a leaf + swing arc. */
function DoorSymbol({
  door,
  t,
  center,
}: {
  door: Door;
  t: number;
  center: { x: number; y: number };
}) {
  const L = 3; // standard ~3 ft opening
  const hw = L / 2;
  const acc = "var(--color-accent)";

  if (door.orientation === "h") {
    // Opening spans X; door sits in a horizontal wall, swings up/down (inward).
    const dir = center.y >= door.y ? 1 : -1;
    const hingeX = door.x - hw;
    const farX = door.x + hw;
    const tipY = door.y + dir * L;
    return (
      <g className="pointer-events-none">
        <rect x={door.x - hw} y={door.y - t} width={L} height={t * 2} fill="var(--color-surface)" />
        <line x1={hingeX} y1={door.y} x2={hingeX} y2={tipY} stroke={acc} strokeWidth={t * 0.3} />
        <path
          d={`M ${hingeX} ${tipY} A ${L} ${L} 0 0 ${dir > 0 ? 1 : 0} ${farX} ${door.y}`}
          fill="none"
          stroke={acc}
          strokeOpacity={0.7}
          strokeWidth={t * 0.22}
        />
      </g>
    );
  }

  // Opening spans Y; door sits in a vertical wall, swings left/right (inward).
  const dir = center.x >= door.x ? 1 : -1;
  const hingeY = door.y - hw;
  const farY = door.y + hw;
  const tipX = door.x + dir * L;
  return (
    <g className="pointer-events-none">
      <rect x={door.x - t} y={door.y - hw} width={t * 2} height={L} fill="var(--color-surface)" />
      <line x1={door.x} y1={hingeY} x2={tipX} y2={hingeY} stroke={acc} strokeWidth={t * 0.3} />
      <path
        d={`M ${tipX} ${hingeY} A ${L} ${L} 0 0 ${dir > 0 ? 0 : 1} ${door.x} ${farY}`}
        fill="none"
        stroke={acc}
        strokeOpacity={0.7}
        strokeWidth={t * 0.22}
      />
    </g>
  );
}

/** A window: a gap in the wall with the standard double-line glass symbol. */
function WindowSymbol({ win, t }: { win: Window; t: number }) {
  const half = win.length / 2;
  const glass = "#5cc9e2";
  const o = t * 0.22;
  if (win.orientation === "h") {
    return (
      <g className="pointer-events-none">
        <rect x={win.x - half} y={win.y - t * 0.7} width={win.length} height={t * 1.4} fill="var(--color-surface)" />
        <line x1={win.x - half} y1={win.y - o} x2={win.x + half} y2={win.y - o} stroke={glass} strokeWidth={t * 0.16} />
        <line x1={win.x - half} y1={win.y + o} x2={win.x + half} y2={win.y + o} stroke={glass} strokeWidth={t * 0.16} />
      </g>
    );
  }
  return (
    <g className="pointer-events-none">
      <rect x={win.x - t * 0.7} y={win.y - half} width={t * 1.4} height={win.length} fill="var(--color-surface)" />
      <line x1={win.x - o} y1={win.y - half} x2={win.x - o} y2={win.y + half} stroke={glass} strokeWidth={t * 0.16} />
      <line x1={win.x + o} y1={win.y - half} x2={win.x + o} y2={win.y + half} stroke={glass} strokeWidth={t * 0.16} />
    </g>
  );
}

/** Bounding box (feet) of every drawn element, so the viewBox matches the plan. */
function footprint(plan: FloorPlan): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of plan.rooms) {
    const size = layoutSize(r);
    xs.push(r.x, r.x + size.width);
    ys.push(r.y, r.y + size.height);
  }
  for (const w of plan.walls ?? []) {
    xs.push(w.x1, w.x2);
    ys.push(w.y1, w.y2);
  }
  if (xs.length === 0) {
    return { x: 0, y: 0, w: plan.planWidth, h: plan.planHeight };
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

/**
 * Rooms whose labels should be drawn — largest first, skipping any whose centre
 * falls inside an already-chosen larger room (so overlapping boxes don't stack
 * two names on top of each other).
 */
function labelTargets(rooms: Room[]): Room[] {
  const sorted = [...rooms].sort((a, b) => {
    const sa = layoutSize(a);
    const sb = layoutSize(b);
    return sb.width * sb.height - sa.width * sa.height;
  });
  const kept: Room[] = [];
  for (const r of sorted) {
    const size = layoutSize(r);
    const cx = r.x + size.width / 2;
    const cy = r.y + size.height / 2;
    const covered = kept.some((k) => {
      const ks = layoutSize(k);
      return cx > k.x && cx < k.x + ks.width && cy > k.y && cy < k.y + ks.height;
    });
    if (!covered) kept.push(r);
  }
  return kept;
}

const round = (n: number) => Math.round(n * 10) / 10;
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
