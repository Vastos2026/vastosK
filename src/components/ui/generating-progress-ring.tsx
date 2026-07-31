"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const SIZE = 56;
const STROKE = 5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Circular progress ring with a percentage readout, for AI calls that don't
 * report real progress (Gemini/Runware image + video generation have no
 * progress channel — see context.md's "no cancel button" note for the same
 * underlying limitation). The percentage is a simulated ramp, not a literal
 * measurement: it eases up toward ~92% over `estimatedMs`, holds there if
 * the real response is still pending, then animates the rest of the way to
 * 100% the moment `active` flips false — an honest approximation rather
 * than a precise-looking fake number.
 */
export function GeneratingProgressRing({
  active,
  estimatedMs = 15000,
  label,
  className,
}: {
  active: boolean;
  estimatedMs?: number;
  label?: string;
  className?: string;
}) {
  const [percent, setPercent] = useState(0);
  const percentRef = useRef(0);

  useEffect(() => {
    percentRef.current = percent;
  }, [percent]);

  useEffect(() => {
    let raf: number;

    if (!active) {
      // Snap the rest of the way to completion instead of leaving the ring
      // stuck wherever the ramp happened to be.
      const from = percentRef.current;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / 300);
        setPercent(from + (100 - from) * t);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    const cap = 92;
    const tau = estimatedMs / 2.5;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      setPercent(cap * (1 - Math.exp(-elapsed / tau)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, estimatedMs]);

  const offset = CIRCUMFERENCE * (1 - percent / 100);

  return (
    <div className={cn("flex flex-col items-center gap-3", className)} role="status" aria-label={label ?? "Generating"}>
      <svg width={SIZE} height={SIZE}>
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} className="fill-none stroke-surface-3" />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="fill-none stroke-accent"
          />
        </g>
        <text
          x={SIZE / 2}
          y={SIZE / 2}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-[13px] font-semibold"
        >
          {Math.round(percent)}%
        </text>
      </svg>
    </div>
  );
}
