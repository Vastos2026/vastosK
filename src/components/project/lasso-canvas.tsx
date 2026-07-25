"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface LassoRegionsHandle {
  /** Clear every region (in-progress and completed) and start over. */
  clear: () => void;
  /** One PNG mask data URL per completed region (white = edit, black = keep), in draw order. */
  getMasks: (width: number, height: number) => string[];
}

type Pt = [number, number]; // normalized 0..1

const REGION_COLOR = ["#e6a45c", "#5cc9e2"]; // ① amber, ② cyan

/**
 * Freeform lasso selection — View & Edit's region picker (revamp Workstream
 * 8.5). Draws up to `maxRegions` independently-numbered loops on a
 * transparent overlay; each completed loop is one region with its own mask,
 * `onRegionsChange` fires the completed count so the parent can show a
 * numbered prompt box per region as soon as it closes.
 */
export const LassoCanvas = forwardRef<
  LassoRegionsHandle,
  {
    enabled: boolean;
    processing?: boolean;
    maxRegions?: number;
    onRegionsChange?: (count: number) => void;
  }
>(function LassoCanvas({ enabled, processing, maxRegions = 2, onRegionsChange }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [regions, setRegions] = useState<Pt[][]>([]);
  const [current, setCurrent] = useState<Pt[]>([]);
  const drawing = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 });

  const canDraw = enabled && !processing && regions.length < maxRegions;

  useImperativeHandle(ref, () => ({
    clear: () => {
      setRegions([]);
      setCurrent([]);
      onRegionsChange?.(0);
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
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let offset = 0;
    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      regions.forEach((pts, i) => {
        const color = REGION_COLOR[i % REGION_COLOR.length];
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
        ctx.fillStyle = "#0a0a0a";
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
        const color = REGION_COLOR[regions.length % REGION_COLOR.length];
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
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [regions, current]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ cursor: canDraw ? "crosshair" : "default", touchAction: "none" }}
        onPointerDown={(e) => {
          if (!canDraw) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = true;
          setCurrent([toNorm(e)]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = toNorm(e);
          setCurrent((prev) => {
            const last = prev[prev.length - 1];
            if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.008) return prev;
            return [...prev, p];
          });
        }}
        onPointerUp={() => {
          drawing.current = false;
          setCurrent((pts) => {
            if (pts.length < 3) return [];
            setRegions((prev) => {
              const next = [...prev, pts];
              onRegionsChange?.(next.length);
              return next;
            });
            return [];
          });
        }}
      />
    </div>
  );
});
