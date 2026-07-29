"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Room } from "@/lib/types";

/**
 * Slim "jump to room" rail for the Generate page (revamp Workstream 8.5,
 * frontend polish pass). Only shows once a project has enough rooms that
 * scrolling between them is a chore — each room's <section> on the Generate
 * page carries a matching `id={`room-${room.id}`}` for this to target.
 *
 * Positioned fixed to the viewport (simpler than sticky-inside-the-scroll-
 * container, and the page has no other fixed-position chrome to collide
 * with). Active-room tracking uses IntersectionObserver rather than scroll
 * math; only `transform`/`opacity` are animated, per the repo's motion rule.
 */
export function RoomNavRail({ rooms }: { rooms: Room[] }) {
  const [activeId, setActiveId] = useState<string | null>(rooms[0]?.id ?? null);
  const ratiosRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (rooms.length <= 4) return;

    const sections = rooms
      .map((room) => document.getElementById(`room-${room.id}`))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const ratios = ratiosRef.current;
    ratios.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.intersectionRatio);
        }
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const [sectionId, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = sectionId;
          }
        }
        if (bestId) setActiveId(bestId.replace("room-", ""));
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [rooms]);

  if (rooms.length <= 4) return null;

  const scrollToRoom = (roomId: string) => {
    document.getElementById(`room-${roomId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav
      aria-label="Jump to room"
      className="fixed top-1/2 right-4 z-40 flex -translate-y-1/2 flex-col items-center gap-2.5 rounded-full border border-border bg-surface/80 px-2 py-3 backdrop-blur-sm"
    >
      {rooms.map((room) => {
        const active = activeId === room.id;
        return (
          <button
            key={room.id}
            type="button"
            onClick={() => scrollToRoom(room.id)}
            aria-label={`Jump to ${room.name}`}
            aria-current={active ? "true" : undefined}
            title={room.name}
            className="group flex cursor-pointer items-center justify-center p-1"
          >
            <span
              className={cn(
                "block size-1.5 rounded-full bg-border-strong opacity-70 transition-[transform,opacity] duration-150",
                active ? "scale-150 bg-accent opacity-100" : "group-hover:opacity-100",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}
