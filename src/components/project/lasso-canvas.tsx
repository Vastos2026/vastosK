"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface LassoHandle {
  clear: () => void;
  /**
   * Render the current selection as a PNG mask data URL (white = selected /
   * repaint, black = keep) at the given pixel size. Returns null if empty.
   */
  getMask: (width: number, height: number) => string | null;
}

type Pt = [number, number]; // normalized 0..1

/** Freeform lasso selection drawn on a transparent canvas overlay. */
export const LassoCanvas = forwardRef<
  LassoHandle,
  { enabled: boolean; processing?: boolean; onMaskChange?: (hasMask: boolean) => void }
>(function LassoCanvas({ enabled, processing, onMaskChange }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const drawing = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 });

  useImperativeHandle(ref, () => ({
    clear: () => {
      setPoints([]);
      onMaskChange?.(false);
    },
    getMask: (width: number, height: number) => {
      if (points.length < 3) return null;
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      // black = keep, white = repaint
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.beginPath();
      ctx.moveTo(points[0][0] * width, points[0][1] * height);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0] * width, points[i][1] * height);
      }
      ctx.closePath();
      ctx.fillStyle = "#fff";
      ctx.fill();
      return c.toDataURL("image/png");
    },
  }));

  // keep canvas backing store in sync with element size
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

  // marching-ants render loop — only animates while a selection exists,
  // so the page can go idle (and screenshots/perf stay healthy) otherwise.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = sizeRef.current;

    if (points.length === 0) {
      ctx.clearRect(0, 0, w, h);
      return;
    }

    let raf = 0;
    let offset = 0;
    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.moveTo(points[0][0] * w, points[0][1] * h);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] * w, points[i][1] * h);
      if (!drawing.current) ctx.closePath();
      ctx.fillStyle = "rgba(230,164,92,0.18)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.lineDashOffset = -offset;
      ctx.strokeStyle = "#e6a45c";
      ctx.stroke();
      ctx.setLineDash([]);
      offset = (offset + 0.6) % 12;
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [points]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ cursor: enabled && !processing ? "crosshair" : "default", touchAction: "none" }}
        onPointerDown={(e) => {
          if (!enabled || processing) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = true;
          const p = toNorm(e);
          setPoints([p]);
          onMaskChange?.(true);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = toNorm(e);
          setPoints((prev) => {
            const last = prev[prev.length - 1];
            if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.008) return prev;
            return [...prev, p];
          });
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
    </div>
  );
});
