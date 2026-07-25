"use client";

/**
 * Room walkthrough — step through a room's photoreal renders (corner / front /
 * side / opposite corner) with the ← → arrow keys or the on-screen arrows, so it
 * feels like moving around inside the room. Used instead of the equirectangular
 * 360° sphere, whose AI-merged source image visibly "bends".
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";

export interface WalkView {
  label: string;
  url: string;
}

export default function RoomWalkthrough({
  views,
  auto = false,
  intervalMs = 2000,
}: {
  views: WalkView[];
  /** Auto-advance through the views as a hard-cut slideshow (no crossfade). */
  auto?: boolean;
  intervalMs?: number;
}) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(auto);
  const n = views.length;
  const go = useCallback((d: number) => setI((p) => (p + d + n) % n), [n]);

  // Arrow keys (and A/D) move between views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Auto-advance (2s hard cuts) like the architectural-slideshow reference.
  useEffect(() => {
    if (!playing || n <= 1) return;
    const t = setInterval(() => setI((p) => (p + 1) % n), intervalMs);
    return () => clearInterval(t);
  }, [playing, n, intervalMs]);

  if (n === 0) return null;
  const cur = views[i];

  return (
    <div className="relative h-full w-full select-none bg-black">
      {/* In auto mode: instant HARD CUTS (architectural-slideshow style). Otherwise
          crossfade so manual stepping feels like moving rather than cutting. */}
      {views.map((v, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${v.label}-${idx}`}
          src={v.url}
          alt={v.label}
          className={`absolute inset-0 h-full w-full object-contain ${auto ? "" : "transition-opacity duration-500"}`}
          style={{ opacity: idx === i ? 1 : 0 }}
        />
      ))}

      {auto && n > 1 && (
        <button
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pause" : "Play"}
          className="absolute right-3 top-3 grid size-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/80 cursor-pointer"
        >
          <Icon name={playing ? "X" : "ChevronRight"} className="size-5" />
        </button>
      )}

      {n > 1 && (
        <>
          <button
            onClick={() => go(-1)}
            aria-label="Previous view"
            className="absolute left-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/80 cursor-pointer"
          >
            <Icon name="ChevronLeft" className="size-6" />
          </button>
          <button
            onClick={() => go(1)}
            aria-label="Next view"
            className="absolute right-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition-colors hover:bg-black/80 cursor-pointer"
          >
            <Icon name="ChevronRight" className="size-6" />
          </button>
        </>
      )}

      <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        <span className="rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
          {cur.label} · {i + 1}/{n} · {auto ? "2s slideshow · ← → to step" : "← → to move around"}
        </span>
        {n > 1 && (
          <div className="flex gap-1.5">
            {views.map((_, idx) => (
              <span
                key={idx}
                className={`size-1.5 rounded-full ${idx === i ? "bg-accent" : "bg-white/40"}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
