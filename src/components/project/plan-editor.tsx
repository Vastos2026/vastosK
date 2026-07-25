"use client";

import { useRef, useState } from "react";
import type { FloorPlan, PlacedItem, Room } from "@/lib/types";

/** Which edge/corner of a room a resize drag is pulling. */
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type DragState =
  | { kind: "room-move"; id: string; startX: number; startY: number; rect: Rect }
  | { kind: "room-resize"; id: string; handle: Handle; startX: number; startY: number; rect: Rect }
  | { kind: "item-move"; id: string; startX: number; startY: number; rect: Rect };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_ROOM = 3;

export function PlanEditor({
  plan,
  selectedId,
  onSelect,
  onChangeRoom,
  issueIds,
  items,
  selectedItemId,
  onSelectItem,
  onChangeItem,
  focusId,
  shell,
}: {
  plan: FloorPlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeRoom: (roomId: string, patch: Partial<Room>) => void;
  /** room ids flagged as overlapping / out-of-bounds — outlined in red */
  issueIds?: Set<string>;
  /** placed furniture to render + drag (omit to hide the furniture layer) */
  items?: PlacedItem[];
  selectedItemId?: string | null;
  onSelectItem?: (id: string | null) => void;
  /** persist a furniture move (position + the room it now sits in) */
  onChangeItem?: (itemId: string, patch: Partial<PlacedItem>) => void;
  /**
   * Isolated room review: zoom the view onto this room and show only its own
   * furniture; other rooms fade out and stop responding. Coordinates stay in
   * plan space, so every edit writes back exactly as in the full view.
   */
  focusId?: string | null;
  /**
   * Draw the DETECTED structural shell — walls + windows — as a faint backdrop
   * (doors already always render). Used on the upload editor so the detected
   * building is visible even before any room is lassoed in; off elsewhere so
   * the review/room editors stay uncluttered by raw wall lines.
   */
  shell?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const pad = 2;

  const editableItems = !!items && !!onChangeItem;
  const focusRoom = focusId ? plan.rooms.find((r) => r.id === focusId) : undefined;
  const viewBox = focusRoom
    ? `${focusRoom.x - pad} ${focusRoom.y - pad} ${focusRoom.width + pad * 2} ${focusRoom.height + pad * 2}`
    : `${-pad} ${-pad} ${plan.planWidth + pad * 2} ${plan.planHeight + pad * 2}`;

  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const begin = (e: React.PointerEvent, state: DragState, roomSelect: string | null) => {
    e.stopPropagation();
    if (roomSelect !== null) {
      onSelect(roomSelect);
      onSelectItem?.(null);
    }
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag(state);
  };

  const startRoomMove = (e: React.PointerEvent, room: Room) => {
    const { x, y } = toSvg(e.clientX, e.clientY);
    begin(e, { kind: "room-move", id: room.id, startX: x, startY: y, rect: rectOf(room) }, room.id);
  };

  const startRoomResize = (e: React.PointerEvent, room: Room, handle: Handle) => {
    const { x, y } = toSvg(e.clientX, e.clientY);
    begin(
      e,
      { kind: "room-resize", id: room.id, handle, startX: x, startY: y, rect: rectOf(room) },
      room.id,
    );
  };

  const startItemMove = (e: React.PointerEvent, item: PlacedItem) => {
    e.stopPropagation();
    onSelectItem?.(item.id);
    onSelect(null);
    const { x, y } = toSvg(e.clientX, e.clientY);
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag({
      kind: "item-move",
      id: item.id,
      startX: x,
      startY: y,
      rect: { x: item.x, y: item.y, w: item.w, h: item.d },
    });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const { x, y } = toSvg(e.clientX, e.clientY);
    const dx = x - drag.startX;
    const dy = y - drag.startY;

    if (drag.kind === "item-move") {
      const it = items?.find((i) => i.id === drag.id);
      if (!it) return;
      const nx = clamp(round1(drag.rect.x + dx), 0, Math.max(0, plan.planWidth - it.w));
      const ny = clamp(round1(drag.rect.y + dy), 0, Math.max(0, plan.planHeight - it.d));
      onChangeItem?.(it.id, { x: nx, y: ny });
      return;
    }

    const room = plan.rooms.find((r) => r.id === drag.id);
    if (!room) return;

    if (drag.kind === "room-move") {
      const nx = clamp(round1(drag.rect.x + dx), 0, plan.planWidth - room.width);
      const ny = clamp(round1(drag.rect.y + dy), 0, plan.planHeight - room.height);
      onChangeRoom(room.id, { x: nx, y: ny });
      return;
    }

    // room-resize: derive new bounds from the START rect + the dragged edge(s),
    // so the opposite edge stays pinned (dragging a wall, not the whole room).
    onChangeRoom(room.id, resizeRect(drag.rect, drag.handle, dx, dy, plan));
  };

  const end = () => {
    // On dropping furniture, re-tag it to the room its centre now lands in.
    if (drag?.kind === "item-move" && onChangeItem) {
      const it = items?.find((i) => i.id === drag.id);
      if (it) {
        const cx = it.x + it.w / 2;
        const cy = it.y + it.d / 2;
        const room = plan.rooms.find(
          (r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height,
        );
        if ((room?.id ?? undefined) !== it.roomId) onChangeItem(it.id, { roomId: room?.id });
      }
    }
    setDrag(null);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      className="h-full w-full touch-none select-none"
      onPointerDown={() => {
        onSelect(null);
        onSelectItem?.(null);
      }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {/* grid */}
      <defs>
        <pattern id="ft-grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M1 0 L0 0 0 1" fill="none" stroke="var(--color-border)" strokeWidth={0.04} />
        </pattern>
      </defs>
      <rect
        x={-pad}
        y={-pad}
        width={plan.planWidth + pad * 2}
        height={plan.planHeight + pad * 2}
        fill="url(#ft-grid)"
      />

      {/* envelope */}
      <rect
        x={0}
        y={0}
        width={plan.planWidth}
        height={plan.planHeight}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={0.18}
      />

      {/* detected shell (upload editor) — walls + windows, so the detected
          building is visible before any room is lassoed in and doors read as
          openings ON walls rather than floating marks. Behind rooms. */}
      {shell &&
        plan.walls?.map((w) => (
          <line
            key={w.id}
            x1={w.x1}
            y1={w.y1}
            x2={w.x2}
            y2={w.y2}
            stroke="var(--color-border-strong)"
            strokeWidth={Math.max(0.12, Math.min(0.45, w.thickness))}
            strokeOpacity={0.6}
            strokeLinecap="round"
            className="pointer-events-none"
          />
        ))}
      {shell &&
        plan.windows?.map((win) => {
          const half = win.length / 2;
          const x1 = win.orientation === "h" ? win.x - half : win.x;
          const x2 = win.orientation === "h" ? win.x + half : win.x;
          const y1 = win.orientation === "v" ? win.y - half : win.y;
          const y2 = win.orientation === "v" ? win.y + half : win.y;
          return (
            <line
              key={win.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#5cc9e2"
              strokeWidth={0.3}
              strokeLinecap="round"
              className="pointer-events-none"
            />
          );
        })}

      {/* rooms */}
      {plan.rooms.map((room) => {
        const selected = room.id === selectedId;
        const hasIssue = issueIds?.has(room.id);
        // In isolated review, neighbouring rooms fade to context-only outlines.
        const dimmed = !!focusRoom && room.id !== focusRoom.id;
        if (dimmed) {
          return (
            <rect
              key={room.id}
              x={room.x}
              y={room.y}
              width={room.width}
              height={room.height}
              fill={room.color}
              fillOpacity={0.04}
              stroke={room.color}
              strokeOpacity={0.2}
              strokeWidth={0.14}
              className="pointer-events-none"
            />
          );
        }
        return (
          <g key={room.id}>
            <g onPointerDown={(e) => startRoomMove(e, room)} className="cursor-move">
              <rect
                x={room.x}
                y={room.y}
                width={room.width}
                height={room.height}
                fill={room.color}
                fillOpacity={selected ? 0.28 : 0.16}
                stroke={room.color}
                strokeOpacity={selected ? 1 : 0.6}
                strokeWidth={selected ? 0.28 : 0.18}
              />
              {hasIssue && (
                <rect
                  x={room.x}
                  y={room.y}
                  width={room.width}
                  height={room.height}
                  fill="none"
                  stroke="var(--color-danger)"
                  strokeWidth={0.3}
                  strokeDasharray="0.8 0.5"
                  className="pointer-events-none"
                />
              )}
              <text
                x={room.x + room.width / 2}
                y={room.y + room.height / 2 - 0.6}
                fontSize={Math.min(1.5, room.width / 6)}
                fill="var(--color-foreground)"
                textAnchor="middle"
                dominantBaseline="middle"
                className="pointer-events-none font-medium"
              >
                {room.name}
              </text>
              <text
                x={room.x + room.width / 2}
                y={room.y + room.height / 2 + 1}
                fontSize={Math.min(1.1, room.width / 8)}
                fill="var(--color-muted)"
                textAnchor="middle"
                dominantBaseline="middle"
                className="pointer-events-none"
              >
                {round1(room.width)}×{round1(room.height)} ft
              </text>
            </g>

            {/* resize handles — drag any WALL (edge) or corner of the selected room */}
            {selected && <ResizeHandles room={room} onStart={startRoomResize} />}
          </g>
        );
      })}

      {/* furniture — draggable, re-homed to whatever room it's dropped in */}
      {items?.map((it) => {
        if (it.ghost) return null;
        if (focusRoom && it.roomId !== focusRoom.id) return null;
        const sel = it.id === selectedItemId;
        const labelSize = Math.min(0.9, it.w / 5);
        return (
          <g
            key={it.id}
            onPointerDown={editableItems ? (e) => startItemMove(e, it) : undefined}
            className={editableItems ? "cursor-grab" : "pointer-events-none"}
          >
            <rect
              x={it.x}
              y={it.y}
              width={it.w}
              height={it.d}
              rx={0.25}
              fill={it.color}
              fillOpacity={sel ? 0.95 : 0.8}
              stroke={sel ? "var(--color-accent)" : "var(--color-bg)"}
              strokeWidth={sel ? 0.22 : 0.1}
            />
            {it.w > 2.2 && it.d > 1.2 && (
              <text
                x={it.x + it.w / 2}
                y={it.y + it.d / 2}
                fontSize={labelSize}
                fill="#fff"
                fillOpacity={0.92}
                textAnchor="middle"
                dominantBaseline="middle"
                className="pointer-events-none"
              >
                {it.name}
              </text>
            )}
          </g>
        );
      })}

      {/* doors — drawn as a real OPENING (a gap that breaks the wall) with a
          swing arc + leaf, not a closed marker, so the plan reads architecturally.
          The leaf swings toward the plan interior. */}
      {plan.doors.map((d) => {
        const L = 2.8; // ~door leaf width (ft)
        const gap = 0.35; // half-thickness of the wall break
        const acc = "var(--color-accent)";
        const cx = plan.planWidth / 2;
        const cy = plan.planHeight / 2;
        if (d.orientation === "h") {
          const x0 = d.x - L / 2;
          const x1 = d.x + L / 2;
          const dir = cy >= d.y ? 1 : -1; // swing toward the building centre
          const tipY = d.y + dir * L;
          return (
            <g key={d.id} className="pointer-events-none">
              {/* break the wall line so it reads as a passage */}
              <rect x={x0} y={d.y - gap} width={L} height={gap * 2} fill="var(--color-bg)" />
              <line x1={x0} y1={d.y} x2={x0} y2={tipY} stroke={acc} strokeWidth={0.16} />
              <path
                d={`M ${x0} ${tipY} A ${L} ${L} 0 0 ${dir > 0 ? 1 : 0} ${x1} ${d.y}`}
                fill="none"
                stroke={acc}
                strokeOpacity={0.75}
                strokeWidth={0.12}
              />
            </g>
          );
        }
        const y0 = d.y - L / 2;
        const y1 = d.y + L / 2;
        const dir = cx >= d.x ? 1 : -1;
        const tipX = d.x + dir * L;
        return (
          <g key={d.id} className="pointer-events-none">
            <rect x={d.x - gap} y={y0} width={gap * 2} height={L} fill="var(--color-bg)" />
            <line x1={d.x} y1={y0} x2={tipX} y2={y0} stroke={acc} strokeWidth={0.16} />
            <path
              d={`M ${tipX} ${y0} A ${L} ${L} 0 0 ${dir > 0 ? 0 : 1} ${d.x} ${y1}`}
              fill="none"
              stroke={acc}
              strokeOpacity={0.75}
              strokeWidth={0.12}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Eight resize grips on the selected room — four walls + four corners. */
function ResizeHandles({
  room,
  onStart,
}: {
  room: Room;
  onStart: (e: React.PointerEvent, room: Room, handle: Handle) => void;
}) {
  const { x, y, width: w, height: h } = room;
  const t = 0.55; // grip half-thickness (ft)
  const edges: { handle: Handle; x: number; y: number; w: number; h: number; cursor: string }[] = [
    { handle: "n", x: x + t, y: y - t, w: w - 2 * t, h: 2 * t, cursor: "cursor-ns-resize" },
    { handle: "s", x: x + t, y: y + h - t, w: w - 2 * t, h: 2 * t, cursor: "cursor-ns-resize" },
    { handle: "w", x: x - t, y: y + t, w: 2 * t, h: h - 2 * t, cursor: "cursor-ew-resize" },
    { handle: "e", x: x + w - t, y: y + t, w: 2 * t, h: h - 2 * t, cursor: "cursor-ew-resize" },
  ];
  const corners: { handle: Handle; cx: number; cy: number; cursor: string }[] = [
    { handle: "nw", cx: x, cy: y, cursor: "cursor-nwse-resize" },
    { handle: "ne", cx: x + w, cy: y, cursor: "cursor-nesw-resize" },
    { handle: "sw", cx: x, cy: y + h, cursor: "cursor-nesw-resize" },
    { handle: "se", cx: x + w, cy: y + h, cursor: "cursor-nwse-resize" },
  ];
  return (
    <g>
      {edges.map((ed) => (
        <rect
          key={ed.handle}
          x={ed.x}
          y={ed.y}
          width={Math.max(0, ed.w)}
          height={Math.max(0, ed.h)}
          fill="var(--color-accent)"
          fillOpacity={0.18}
          stroke="var(--color-accent)"
          strokeOpacity={0.5}
          strokeWidth={0.08}
          className={ed.cursor}
          onPointerDown={(e) => onStart(e, room, ed.handle)}
        />
      ))}
      {corners.map((c) => (
        <rect
          key={c.handle}
          x={c.cx - 0.6}
          y={c.cy - 0.6}
          width={1.2}
          height={1.2}
          rx={0.2}
          fill="var(--color-accent)"
          stroke="var(--color-bg)"
          strokeWidth={0.12}
          className={c.cursor}
          onPointerDown={(e) => onStart(e, room, c.handle)}
        />
      ))}
    </g>
  );
}

function rectOf(room: Room): Rect {
  return { x: room.x, y: room.y, w: room.width, h: room.height };
}

/** New room box from the START rect, the dragged handle and the pointer delta. */
function resizeRect(
  rect: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  plan: FloorPlan,
): Partial<Room> {
  let { x, y, w, h } = rect;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;

  if (handle.includes("w")) {
    x = clamp(round1(rect.x + dx), 0, right - MIN_ROOM);
    w = round1(right - x);
  }
  if (handle.includes("e")) {
    w = clamp(round1(rect.w + dx), MIN_ROOM, plan.planWidth - rect.x);
  }
  if (handle.includes("n")) {
    y = clamp(round1(rect.y + dy), 0, bottom - MIN_ROOM);
    h = round1(bottom - y);
  }
  if (handle.includes("s")) {
    h = clamp(round1(rect.h + dy), MIN_ROOM, plan.planHeight - rect.y);
  }
  return { x, y, width: w, height: h };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
