"use client";

import { useRef, useState } from "react";
import { polygonArea, type Pt, type RectPx } from "@/lib/lasso-extract";
import { cn } from "@/lib/utils";

/**
 * Freehand lasso layer drawn over the uploaded plan image. Lives in the same
 * box as the image + DetectionOverlay and uses the identical viewBox, so its
 * coordinates ARE image pixels. While a selection is pending, the parent
 * passes it back as `preview` (loop + the wall-snapped rectangle) so the user
 * sees exactly what will become the room.
 */
export function LassoSelect({
  imageWidth,
  imageHeight,
  active,
  onComplete,
  preview,
}: {
  imageWidth: number;
  imageHeight: number;
  active: boolean;
  /** called with the closed loop, in image-pixel coordinates */
  onComplete: (polygon: Pt[]) => void;
  preview?: { polygon: Pt[]; rect: RectPx; label?: string } | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [path, setPath] = useState<Pt[] | null>(null);
  // Stroke widths scale with image size, matching DetectionOverlay.
  const s = Math.max(imageWidth, imageHeight) / 400;

  const toImg = (e: React.PointerEvent): Pt => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const down = (e: React.PointerEvent) => {
    if (!active) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    setPath([toImg(e)]);
  };

  const move = (e: React.PointerEvent) => {
    if (!path) return;
    const p = toImg(e);
    setPath((prev) => {
      if (!prev) return prev;
      const last = prev[prev.length - 1];
      // thin the path — a point every ~2 stroke-widths is plenty
      if (Math.hypot(p.x - last.x, p.y - last.y) < s * 2) return prev;
      return [...prev, p];
    });
  };

  const up = () => {
    if (path && path.length >= 8 && polygonArea(path) > imageWidth * imageHeight * 0.0005) {
      onComplete(path);
    }
    setPath(null);
  };

  const pts = (poly: Pt[]) => poly.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn(
        "absolute inset-0 h-full w-full touch-none select-none",
        active ? "cursor-crosshair" : "pointer-events-none",
      )}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setPath(null)}
    >
      {preview && !path && (
        <g className="pointer-events-none">
          <polygon
            points={pts(preview.polygon)}
            fill="var(--color-accent)"
            fillOpacity={0.08}
            stroke="var(--color-accent)"
            strokeOpacity={0.45}
            strokeWidth={s}
            strokeDasharray={`${s * 3} ${s * 2.5}`}
          />
          <rect
            x={preview.rect.x}
            y={preview.rect.y}
            width={preview.rect.w}
            height={preview.rect.h}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={s * 1.6}
            rx={s * 2}
          />
          {preview.label && (
            <text
              x={preview.rect.x + preview.rect.w / 2}
              y={Math.max(s * 10, preview.rect.y - s * 4)}
              fontSize={s * 9}
              fill="var(--color-accent)"
              textAnchor="middle"
              className="font-medium"
            >
              {preview.label}
            </text>
          )}
        </g>
      )}

      {path && (
        <polygon
          points={pts(path)}
          fill="var(--color-accent)"
          fillOpacity={0.12}
          stroke="var(--color-accent)"
          strokeWidth={s * 1.6}
          strokeLinejoin="round"
          strokeDasharray={`${s * 4} ${s * 3}`}
        />
      )}
    </svg>
  );
}
