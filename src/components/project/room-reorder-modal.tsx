"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Room } from "@/lib/types";

export interface ReorderableRoom {
  room: Room;
  imageUrl?: string;
}

/**
 * Drag-and-drop replacement for the Walkthrough page's old chevron-button
 * reorder (revamp gap-fill). Hand-rolled pointer-event dragging rather than a
 * dependency — a plain click-to-place canvas, just
 * applied to a DOM list instead of a `<canvas>`. A card follows the pointer
 * via `transform` only (never top/left/width/height/margin, per the design
 * system's motion rule) while the rest of the grid swaps instantly as the
 * drag crosses into a neighbouring card's bounds.
 */
export function RoomReorderModal({
  open,
  onClose,
  items,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  items: ReorderableRoom[];
  onConfirm: (order: Room[]) => void;
}) {
  const [order, setOrder] = useState<ReorderableRoom[]>(items);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  // Each grid slot's on-screen rect, measured once per drag (not once per
  // pointermove). A reorder only changes which room's key sits in a slot,
  // never the slot's own position (fixed column CSS grid, same item count),
  // so these stay valid for the whole gesture — no need to re-query the DOM
  // and force a layout read on every single pointer move.
  const slotRects = useRef<DOMRect[]>([]);

  // Reset to the current effective order every time the modal transitions
  // from closed to open, so a cancelled drag from a previous open never
  // leaks into the next one. Adjusted during render rather than in an effect
  // (React's own recommended pattern for "sync state to a prop change") so
  // this doesn't cause an extra cascading render pass just to reset a list.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOrder(items);
  }

  const endDrag = () => {
    dragIndex.current = null;
    startPos.current = null;
    setDraggingIndex(null);
    setDragOffset({ x: 0, y: 0 });
  };

  // Cached slot rects (measured once per drag, see handlePointerDown below)
  // go stale if the viewport changes size mid-gesture — a window resize, or
  // a mobile device rotating while a touch-drag is held (pointer capture
  // only suppresses scroll/gestures, not orientation changes). Rather than
  // hit-testing against now-wrong rects, just end the drag safely; the user
  // can start a fresh one, which re-measures.
  useEffect(() => {
    if (draggingIndex === null) return;
    window.addEventListener("resize", endDrag);
    return () => window.removeEventListener("resize", endDrag);
  }, [draggingIndex]);

  const handlePointerDown = (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    dragIndex.current = index;
    startPos.current = { x: e.clientX, y: e.clientY };
    setDraggingIndex(index);
    setDragOffset({ x: 0, y: 0 });
    if (containerRef.current) {
      slotRects.current = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>("[data-room-card]"),
      ).map((el) => el.getBoundingClientRect());
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragIndex.current;
    const anchor = startPos.current;
    if (from === null || !anchor) return;

    setDragOffset({ x: e.clientX - anchor.x, y: e.clientY - anchor.y });

    const rects = slotRects.current;
    for (let i = 0; i < rects.length; i++) {
      if (i === from) continue;
      const rect = rects[i];
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        setOrder((prev) => {
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          next.splice(i, 0, moved);
          return next;
        });
        dragIndex.current = i;
        setDraggingIndex(i);
        // Re-anchor to here so the followed offset continues smoothly from
        // the new slot instead of jumping.
        startPos.current = { x: e.clientX, y: e.clientY };
        setDragOffset({ x: 0, y: 0 });
        break;
      }
    }
  };

  const confirm = () => {
    onConfirm(order.map((item) => item.room));
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Reorder rooms" description="Drag a room to reorder it.">
      <div className="p-6">
        <div
          ref={containerRef}
          className="grid grid-cols-3 gap-3"
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {order.map((item, i) => {
            const isDragging = draggingIndex === i;
            return (
              <div
                key={item.room.id}
                data-room-card
                onPointerDown={handlePointerDown(i)}
                style={
                  isDragging
                    ? { transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0) scale(1.05)` }
                    : undefined
                }
                className={cn(
                  "relative flex touch-none select-none flex-col overflow-hidden rounded-xl border border-border bg-surface-2 cursor-grab active:cursor-grabbing",
                  isDragging ? "z-10 border-accent shadow-2xl" : "transition-transform duration-150",
                )}
              >
                <div className="relative h-20 w-full overflow-hidden bg-surface-3">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" draggable={false} className="h-full w-full object-cover" />
                  ) : (
                    <span className="absolute inset-0" style={{ background: item.room.color, opacity: 0.25 }} />
                  )}
                  <span className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-black/60 text-[11px] font-medium text-white">
                    {i + 1}
                  </span>
                  <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-md bg-black/60 text-white">
                    <Icon name="GripVertical" className="size-3.5" />
                  </span>
                </div>
                <div className="truncate px-2 py-1.5 text-xs font-medium">{item.room.name}</div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
