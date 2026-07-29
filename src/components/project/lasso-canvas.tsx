"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface LassoRegionsHandle {
  /** Clear every region (in-progress and completed) and start over. */
  clear: () => void;
  /** One PNG mask data URL per completed region (white = edit, black = keep), in draw order. */
  getMasks: (width: number, height: number) => string[];
  /** Remove a single completed region by index, renumbering/recolouring the rest. */
  removeRegion: (index: number) => void;
}

type Pt = [number, number]; // normalized 0..1
type MoveDrag = { index: number; start: Pt; original: Pt[] };

// ① green, ② orange — the site's existing accent green plus a clearly
// distinct warm orange, so the two regions are never confused for one another.
export const REGION_COLORS = ["#1f8c64", "#e8964a"];

// The product limit on simultaneous lasso regions — exported so the
// consuming page's `maxRegions` prop and the server-side `/api/edit-room-image`
// validation both read this one value instead of three independent "2"
// literals that could silently drift out of sync if the limit ever changes.
export const MAX_LASSO_REGIONS = 2;

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A colored "+" cursor (with a white halo so it reads on any background),
 * indicating "click here to add a region". */
function plusCursor(color: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22'>` +
    `<line x1='11' y1='2' x2='11' y2='20' stroke='white' stroke-width='4' stroke-linecap='round'/>` +
    `<line x1='2' y1='11' x2='20' y2='11' stroke='white' stroke-width='4' stroke-linecap='round'/>` +
    `<line x1='11' y1='2' x2='11' y2='20' stroke='${color}' stroke-width='2' stroke-linecap='round'/>` +
    `<line x1='2' y1='11' x2='20' y2='11' stroke='${color}' stroke-width='2' stroke-linecap='round'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, crosshair`;
}

/**
 * Freeform lasso selection — View & Edit's region picker (revamp Workstream
 * 8.5). Draws up to `maxRegions` independently-numbered loops on a
 * transparent overlay; each completed loop is one region with its own mask.
 * Completed regions can be dragged to reposition without redrawing.
 *
 * `onRegionsChange` fires from a `regions.length`-keyed effect rather than
 * from inside the pointer handlers themselves — a prior version called
 * `setRegions` from inside `setCurrent`'s functional updater, which is an
 * impure side effect that React can (and, under StrictMode's dev-only
 * double-invoke of updater functions, does) invoke more than once per
 * gesture. That let a single completed drag commit more than one entry to
 * `regions`, so the `regions.length < maxRegions` gate — which is otherwise
 * correct — was checking a count that had already raced ahead of the number
 * of gestures the user actually performed, letting a 3rd region slip through
 * while making the 1st/2nd look like they "didn't register" (they'd already
 * been double-committed). Keeping every state update a single, independent,
 * side-effect-free `setState` call removes that possibility entirely.
 */
export const LassoCanvas = forwardRef<
  LassoRegionsHandle,
  {
    enabled: boolean;
    processing?: boolean;
    maxRegions?: number;
    onRegionsChange?: (count: number) => void;
    /** Fired when the user tries to start a region beyond `maxRegions`. */
    onBlockedAttempt?: () => void;
  }
>(function LassoCanvas(
  { enabled, processing, maxRegions = 2, onRegionsChange, onBlockedAttempt },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [regions, setRegions] = useState<Pt[][]>([]);
  const [current, setCurrent] = useState<Pt[]>([]);
  const [moveDrag, setMoveDrag] = useState<MoveDrag | null>(null);
  const [hoverInside, setHoverInside] = useState(false);
  const drawing = useRef(false);
  const pointsRef = useRef<Pt[]>([]);
  const sizeRef = useRef({ w: 0, h: 0 });

  const canInteract = enabled && !processing;

  // Single source of truth for "how many regions exist" — the parent learns
  // about additions, deletions and clears from one place, never from inside
  // a pointer-event handler's own state updater.
  useEffect(() => {
    onRegionsChange?.(regions.length);
  }, [regions.length, onRegionsChange]);

  useImperativeHandle(ref, () => ({
    clear: () => {
      setRegions([]);
      setCurrent([]);
      setMoveDrag(null);
      drawing.current = false;
      pointsRef.current = [];
    },
    getMasks: (width, height) =>
      regions.map((pts) => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * width, pts[0][1] * height);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * width, pts[i][1] * height);
        ctx.closePath();
        ctx.fillStyle = "#fff";
        ctx.fill();
        return c.toDataURL("image/png");
      }),
    removeRegion: (index) => {
      setRegions((prev) => prev.filter((_, i) => i !== index));
    },
  }));

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
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // marching-ants render loop for the in-progress region + static fills for
  // completed ones, each in its own colour so ① and ② stay visually distinct.
  // Only the in-progress region's dashed stroke actually animates (its
  // `lineDashOffset` needs to keep advancing); completed regions are a
  // static fill/stroke that doesn't change frame to frame. So this only
  // keeps scheduling frames while `current.length > 0` — otherwise (nothing
  // being drawn right now, or `processing` mid-generation, which always
  // clears `current` first) it renders once for the new state and stops,
  // instead of spinning at 60fps indefinitely for as long as the component
  // stays mounted.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let offset = 0;
    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      regions.forEach((pts, i) => {
        const color = REGION_COLORS[i % REGION_COLORS.length];
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0] * w, pts[j][1] * h);
        ctx.closePath();
        ctx.fillStyle = `${color}2e`;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx * w, cy * h, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), cx * w, cy * h + 1);
      });

      if (current.length > 0) {
        ctx.beginPath();
        ctx.moveTo(current[0][0] * w, current[0][1] * h);
        for (let i = 1; i < current.length; i++) ctx.lineTo(current[i][0] * w, current[i][1] * h);
        if (!drawing.current) ctx.closePath();
        const color = REGION_COLORS[regions.length % REGION_COLORS.length];
        ctx.fillStyle = `${color}2e`;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -offset;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      offset = (offset + 0.6) % 12;
      if (current.length > 0) raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [regions, current]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const nextColor = REGION_COLORS[regions.length % REGION_COLORS.length];
  let cursor = "default";
  if (canInteract) {
    if (moveDrag) cursor = "grabbing";
    else if (hoverInside) cursor = "grab";
    else if (regions.length < maxRegions) cursor = plusCursor(nextColor);
  }

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ cursor, touchAction: "none" }}
        onPointerDown={(e) => {
          if (!canInteract) return;
          const p = toNorm(e);

          // Landing inside an already-completed region starts a reposition
          // drag instead of a new one — this takes priority over the
          // max-regions gate below, since moving an existing region never
          // adds a new one. Searched back-to-front (highest index first):
          // regions are painted in array order, so a later index is drawn ON
          // TOP of an earlier one — where two regions overlap, the user is
          // pointing at whichever one they can actually SEE on top, not
          // whichever was drawn first (a forward `findIndex` would grab the
          // bottom, invisible-at-that-point region instead — found in review).
          let hitIndex = -1;
          for (let i = regions.length - 1; i >= 0; i--) {
            if (pointInPolygon(p, regions[i])) {
              hitIndex = i;
              break;
            }
          }
          if (hitIndex !== -1) {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setMoveDrag({ index: hitIndex, start: p, original: regions[hitIndex] });
            return;
          }

          if (regions.length >= maxRegions) {
            onBlockedAttempt?.();
            return;
          }

          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = true;
          pointsRef.current = [p];
          setCurrent([p]);
        }}
        onPointerMove={(e) => {
          if (!canInteract) return;
          const p = toNorm(e);

          if (moveDrag) {
            const dx = p[0] - moveDrag.start[0];
            const dy = p[1] - moveDrag.start[1];
            setRegions((prev) =>
              prev.map((r, i) =>
                i === moveDrag.index
                  ? moveDrag.original.map(([x, y]) => [x + dx, y + dy] as Pt)
                  : r,
              ),
            );
            return;
          }

          if (drawing.current) {
            const last = pointsRef.current[pointsRef.current.length - 1];
            if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.008) return;
            pointsRef.current = [...pointsRef.current, p];
            setCurrent(pointsRef.current);
            return;
          }

          // Hover-only: surface a "grab" affordance over completed regions.
          const inside = regions.some((pts) => pointInPolygon(p, pts));
          setHoverInside(inside);
        }}
        onPointerUp={() => {
          if (moveDrag) {
            setMoveDrag(null);
            return;
          }
          if (!drawing.current) return;
          drawing.current = false;
          const pts = pointsRef.current;
          pointsRef.current = [];
          setCurrent([]);
          if (pts.length >= 3) {
            setRegions((prev) => [...prev, pts]);
          }
        }}
      />
    </div>
  );
});
