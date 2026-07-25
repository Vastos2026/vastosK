"use client";

import type { DetectedGeometry } from "@/lib/types";

export interface LayerToggles {
  walls: boolean;
  doors: boolean;
  windows: boolean;
  rooms: boolean;
}

const ROOM_STROKE = "#5cc98a";

/**
 * Draws the OpenCV detection result as an SVG overlay sized to the image's
 * natural pixel space (the parent positions the image and this overlay in the
 * same box; the SVG's viewBox maps 1:1 to image pixels).
 */
export function DetectionOverlay({
  geometry,
  layers,
}: {
  geometry: DetectedGeometry;
  layers: LayerToggles;
}) {
  const { imageWidth: W, imageHeight: H, walls, doors, windows, rooms } = geometry;
  // Stroke widths scale with image size so they read at any resolution.
  const s = Math.max(W, H) / 400;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {layers.rooms &&
        rooms.map((r, i) => (
          <g key={`room-${i}`}>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill={ROOM_STROKE}
              fillOpacity={0.1}
              stroke={ROOM_STROKE}
              strokeWidth={s * 1.2}
              strokeDasharray={`${s * 4} ${s * 3}`}
              rx={s}
            />
          </g>
        ))}

      {layers.walls &&
        walls.map((w, i) => (
          <line
            key={`wall-${i}`}
            x1={w.x1}
            y1={w.y1}
            x2={w.x2}
            y2={w.y2}
            stroke="#ff5c8a"
            strokeWidth={s * 2}
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}

      {layers.windows &&
        windows.map((win, i) => {
          const half = win.length / 2;
          const x1 = win.orientation === "h" ? win.x - half : win.x;
          const x2 = win.orientation === "h" ? win.x + half : win.x;
          const y1 = win.orientation === "v" ? win.y - half : win.y;
          const y2 = win.orientation === "v" ? win.y + half : win.y;
          return (
            <line
              key={`win-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#5cc9e2"
              strokeWidth={s * 3}
              strokeLinecap="round"
            />
          );
        })}

      {layers.doors &&
        doors.map((d, i) => (
          <g key={`door-${i}`}>
            <circle cx={d.x} cy={d.y} r={s * 4} fill="#f0b429" fillOpacity={0.85} />
            <circle cx={d.x} cy={d.y} r={s * 6} fill="none" stroke="#f0b429" strokeWidth={s} />
          </g>
        ))}
    </svg>
  );
}
