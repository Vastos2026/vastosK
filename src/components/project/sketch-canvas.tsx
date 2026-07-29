"use client";

import { useEffect, useRef, useState } from "react";
import {
  distToSegment,
  polygonCentroid,
  snapAngle,
  type CellData,
  type Pt,
} from "@/lib/sketch/geometry";

/**
 * The Sketch Tool's drawing surface (docs/VASTOS_REVAMP_PLAN.md's "No-floor-plan
 * flow: Sketch Tool"). Follows the same wrapping-div + canvas + ResizeObserver +
 * normalized-[0,1]-coordinates + requestAnimationFrame pattern as
 * lasso-canvas.tsx, adapted for click-to-place points and line-based cell
 * subdivision instead of freehand mask regions.
 *
 * All geometry (splitting, adjacency, angle snapping) lives in
 * lib/sketch/geometry.ts — this component only renders state and reports
 * normalized pointer coordinates upward; the parent page owns the actual
 * sketch state machine.
 */

export type SketchMode = "boundary" | "scale" | "cut" | "rooms";

const DOOR_COLOR = "#e6c15c"; // matches --color-warning
const WINDOW_COLOR = "#6da8e2"; // matches --color-info
const ACCENT = "#f2f2f2"; // matches --color-accent

export interface SketchCanvasProps {
  mode: SketchMode;
  /** Points placed so far this session — the boundary draft, or a closed cell's outline for "scale". */
  boundaryPoints?: Pt[];
  onBoundaryPoint?: (pt: Pt) => void;
  onBoundaryClose?: () => void;

  cells?: CellData[];
  cellColors?: string[];
  onCutComplete?: (a: Pt, b: Pt) => void;

  /** `${cellIndex}:${edgeIndex}` -> "door" | "window" */
  openings?: Record<string, "door" | "window">;
  onEdgeClick?: (cellIndex: number, edgeIndex: number) => void;

  onResize?: (w: number, h: number) => void;
}

const CLOSE_PX = 16;
const EDGE_HIT_PX = 14;

export function SketchCanvas({
  mode,
  boundaryPoints = [],
  onBoundaryPoint,
  onBoundaryClose,
  cells = [],
  cellColors = [],
  onCutComplete,
  openings = {},
  onEdgeClick,
  onResize,
}: SketchCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  // Resizing a <canvas> clears its pixels, and resize can happen independently
  // of any state this component tracks — this ref always holds the latest
  // render() closure (assigned by the draw effect below) so the resize
  // observer can repaint immediately instead of leaving the canvas blank
  // until some unrelated state change happens to fire the draw effect again.
  const renderRef = useRef<() => void>(() => {});
  const [pointer, setPointer] = useState<Pt | null>(null);
  const [cutStart, setCutStart] = useState<Pt | null>(null);
  const [hoverClose, setHoverClose] = useState(false);

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
      onResize?.(r.width, r.height);
      renderRef.current();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draws once per state change, not a self-rescheduling animation loop —
  // this is a click-to-place/hover UI, not a frame-by-frame animation, and
  // the effect's dependency array already re-runs it exactly when something
  // that affects the drawing changes. (lasso-canvas.tsx's dashed
  // marching-ants stroke genuinely needs a continuous rAF loop; this canvas
  // doesn't animate anything, so it doesn't.)
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      const px = (p: Pt): Pt => [p[0] * w, p[1] * h];

      // Filled/stroked cells (cut + rooms modes, and once the boundary is closed).
      cells.forEach((cell, ci) => {
        const color = cellColors[ci % cellColors.length] ?? "#666666";
        ctx.beginPath();
        cell.points.forEach((p, i) => {
          const [x, y] = px(p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = `${color}33`;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();

        const [cx, cy] = px(polygonCentroid(cell.points));
        ctx.fillStyle = color;
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(ci + 1), cx, cy);

        // Opening markers, in rooms mode.
        if (mode === "rooms") {
          const n = cell.points.length;
          for (let i = 0; i < n; i++) {
            const kind = openings[`${ci}:${i}`];
            if (!kind) continue;
            const a = cell.points[i];
            const b = cell.points[(i + 1) % n];
            const [mx, my] = px([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            ctx.beginPath();
            ctx.arc(mx, my, 8, 0, Math.PI * 2);
            ctx.fillStyle = kind === "door" ? DOOR_COLOR : WINDOW_COLOR;
            ctx.fill();
            ctx.fillStyle = "#0a0a0a";
            ctx.font = "bold 10px sans-serif";
            ctx.fillText(kind === "door" ? "D" : "W", mx, my + 0.5);
          }

          // Hover highlight on the nearest edge, for discoverability.
          if (pointer) {
            const hit = nearestEdge(cells, pointer, w, h);
            if (hit) {
              const cell2 = cells[hit.cellIndex];
              const a = cell2.points[hit.edgeIndex];
              const b = cell2.points[(hit.edgeIndex + 1) % cell2.points.length];
              const [ax, ay] = px(a);
              const [bx, by] = px(b);
              ctx.beginPath();
              ctx.moveTo(ax, ay);
              ctx.lineTo(bx, by);
              ctx.lineWidth = 4;
              ctx.strokeStyle = ACCENT;
              ctx.stroke();
            }
          }
        }
      });

      // Boundary draft (click-to-place polygon, before closing).
      if (mode === "boundary" && boundaryPoints.length > 0) {
        ctx.beginPath();
        boundaryPoints.forEach((p, i) => {
          const [x, y] = px(p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        if (pointer) {
          const [x, y] = px(pointer);
          ctx.lineTo(x, y);
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = ACCENT;
        ctx.setLineDash(pointer ? [6, 5] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        boundaryPoints.forEach((p, i) => {
          const [x, y] = px(p);
          const isFirst = i === 0;
          ctx.beginPath();
          ctx.arc(x, y, isFirst && hoverClose ? 9 : 5, 0, Math.PI * 2);
          ctx.fillStyle = isFirst && hoverClose ? "#5cc98a" : ACCENT;
          ctx.fill();
        });
      }

      // Reference-edge highlight (scale step): boundaryPoints holds the closed boundary.
      if (mode === "scale" && boundaryPoints.length >= 2) {
        ctx.beginPath();
        boundaryPoints.forEach((p, i) => {
          const [x, y] = px(p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = `${ACCENT}1a`;
        ctx.fill();
        ctx.strokeStyle = `${ACCENT}55`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const [ax, ay] = px(boundaryPoints[0]);
        const [bx, by] = px(boundaryPoints[1]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#5cc98a";
        ctx.stroke();
      }

      // Cut-in-progress preview line.
      if (mode === "cut" && cutStart && pointer) {
        const [x1, y1] = px(cutStart);
        const [x2, y2] = px(pointer);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "#e27d9a";
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x1, y1, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#e27d9a";
        ctx.fill();
      }
    };
    renderRef.current = render;
    render();
  }, [mode, boundaryPoints, cells, cellColors, openings, pointer, cutStart, hoverClose]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const cursor =
    mode === "boundary" || mode === "cut" ? "crosshair" : mode === "rooms" ? "pointer" : "default";

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ cursor, touchAction: "none" }}
        onPointerMove={(e) => {
          const p = toNorm(e);
          setPointer(p);
          if (mode === "boundary" && boundaryPoints.length >= 3) {
            const { w, h } = sizeRef.current;
            const d0 = boundaryPoints[0];
            const distPx = Math.hypot((p[0] - d0[0]) * w, (p[1] - d0[1]) * h);
            setHoverClose(distPx <= CLOSE_PX);
          }
        }}
        onPointerLeave={() => setPointer(null)}
        onPointerDown={(e) => {
          const p = toNorm(e);
          const { w, h } = sizeRef.current;

          if (mode === "boundary") {
            if (boundaryPoints.length >= 3) {
              const d0 = boundaryPoints[0];
              const distPx = Math.hypot((p[0] - d0[0]) * w, (p[1] - d0[1]) * h);
              if (distPx <= CLOSE_PX) {
                onBoundaryClose?.();
                return;
              }
            }
            const prev = boundaryPoints[boundaryPoints.length - 1];
            const next = prev ? snapAngle(prev, p) : p;
            onBoundaryPoint?.(next);
            return;
          }

          if (mode === "cut") {
            if (!cutStart) {
              setCutStart(p);
            } else {
              onCutComplete?.(cutStart, p);
              setCutStart(null);
            }
            return;
          }

          if (mode === "rooms") {
            const hit = nearestEdge(cells, p, w, h);
            if (hit) onEdgeClick?.(hit.cellIndex, hit.edgeIndex);
          }
        }}
      />
    </div>
  );
}

function nearestEdge(
  cells: CellData[],
  p: Pt,
  w: number,
  h: number,
): { cellIndex: number; edgeIndex: number; dist: number } | null {
  const target: Pt = [p[0] * w, p[1] * h];
  let best: { cellIndex: number; edgeIndex: number; dist: number } | null = null;
  cells.forEach((cell, ci) => {
    const n = cell.points.length;
    for (let i = 0; i < n; i++) {
      const a: Pt = [cell.points[i][0] * w, cell.points[i][1] * h];
      const b: Pt = [cell.points[(i + 1) % n][0] * w, cell.points[(i + 1) % n][1] * h];
      const d = distToSegment(target, a, b);
      if (d <= EDGE_HIT_PX && (!best || d < best.dist)) best = { cellIndex: ci, edgeIndex: i, dist: d };
    }
  });
  return best;
}
