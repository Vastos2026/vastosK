import type { FloorPlan } from "@/lib/types";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import { cn } from "@/lib/utils";

/** Compact SVG preview of a parsed floor plan. */
export function PlanThumb({
  plan,
  className,
  showLabels = false,
}: {
  plan: FloorPlan;
  className?: string;
  showLabels?: boolean;
}) {
  const pad = 1;
  const vbW = plan.planWidth + pad * 2;
  const vbH = plan.planHeight + pad * 2;

  return (
    <svg
      viewBox={`0 0 ${vbW} ${vbH}`}
      className={cn("h-full w-full", className)}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* outer envelope */}
      <rect
        x={pad}
        y={pad}
        width={plan.planWidth}
        height={plan.planHeight}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={0.35}
        rx={0.4}
      />
      {plan.rooms.map((r) => {
        // Cosmetic box sizing only — falls back to a placeholder box when a
        // room's real dimensions are unknown so the preview doesn't collapse
        // to a zero-size rect. Never shown as a claimed size (no text here).
        const { width, height } = layoutSize(r);
        return (
          <g key={r.id}>
            <rect
              x={r.x + pad}
              y={r.y + pad}
              width={width}
              height={height}
              fill={r.color}
              fillOpacity={0.16}
              stroke={r.color}
              strokeOpacity={0.55}
              strokeWidth={0.22}
            />
            {showLabels && (
              <text
                x={r.x + pad + width / 2}
                y={r.y + pad + height / 2}
                fontSize={Math.min(1.6, width / 6)}
                fill="var(--color-muted)"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {r.name}
              </text>
            )}
          </g>
        );
      })}
      {/* walls — drawn over the room fills so shared/structural walls read */}
      {plan.walls?.map((w) => (
        <line
          key={w.id}
          x1={w.x1 + pad}
          y1={w.y1 + pad}
          x2={w.x2 + pad}
          y2={w.y2 + pad}
          stroke="var(--color-border-strong)"
          strokeWidth={Math.max(0.18, Math.min(0.6, w.thickness))}
          strokeLinecap="round"
        />
      ))}
      {/* windows — cyan segments along their wall */}
      {plan.windows?.map((win) => {
        const half = win.length / 2;
        const x1 = win.orientation === "h" ? win.x - half : win.x;
        const x2 = win.orientation === "h" ? win.x + half : win.x;
        const y1 = win.orientation === "v" ? win.y - half : win.y;
        const y2 = win.orientation === "v" ? win.y + half : win.y;
        return (
          <line
            key={win.id}
            x1={x1 + pad}
            y1={y1 + pad}
            x2={x2 + pad}
            y2={y2 + pad}
            stroke="#5cc9e2"
            strokeWidth={0.5}
            strokeLinecap="round"
          />
        );
      })}
      {plan.doors.map((d) => (
        <circle
          key={d.id}
          cx={d.x + pad}
          cy={d.y + pad}
          r={0.5}
          fill="var(--color-accent)"
          fillOpacity={0.8}
        />
      ))}
    </svg>
  );
}
