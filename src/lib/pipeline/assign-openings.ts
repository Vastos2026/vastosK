/**
 * Opening assignment (revamp Workstream 7a) — deterministic, not an AI call.
 *
 * The pipeline already detects doors/windows as points with orientation, in
 * the same feet-space coordinates as the merged rooms (merge.ts). This stage
 * does plain geometry — point-to-room-edge distance — to work out WHICH room
 * (or two, for a connecting door) each opening belongs to and on which side.
 * Deliberately kept out of any AI call: Gemini is good at reading a plan's
 * text and general layout, not exact spatial math, and this is reliable and
 * free precisely because it's code.
 *
 * Best-effort: a room with no detected openings gets an empty array, never
 * an assertion that it HAS no windows/doors — a detection miss must never
 * read as a false hard constraint downstream (in the Prompt Builder).
 */

import type { Door, FloorPlan, Room, Window } from "@/lib/types";

export type OpeningSide = "north" | "south" | "east" | "west";

export interface RoomOpening {
  type: "door" | "window";
  side: OpeningSide;
  /** another room's name, "exterior", or null if no room matched closely enough */
  connectsTo: string | null;
}

/** How far (feet) an opening point may sit from a room's wall and still count. */
const TOLERANCE_FT = 2;

interface Candidate {
  room: Room;
  side: OpeningSide;
  distance: number;
}

/** The room edge(s) an "h"/"v"-oriented opening point could sit on, with distance. */
function matchRoom(room: Room, px: number, py: number, orientation: "h" | "v"): Candidate | null {
  const spanTol = TOLERANCE_FT;
  if (orientation === "h") {
    // On a horizontal wall → north (top) or south (bottom) edge, only if the
    // point's x falls within the room's horizontal span (+ tolerance).
    if (px < room.x - spanTol || px > room.x + room.width + spanTol) return null;
    const dNorth = Math.abs(py - room.y);
    const dSouth = Math.abs(py - (room.y + room.height));
    return dNorth <= dSouth
      ? { room, side: "north", distance: dNorth }
      : { room, side: "south", distance: dSouth };
  }
  // "v" → west (left) or east (right) edge, point's y within the vertical span.
  if (py < room.y - spanTol || py > room.y + room.height + spanTol) return null;
  const dWest = Math.abs(px - room.x);
  const dEast = Math.abs(px - (room.x + room.width));
  return dWest <= dEast
    ? { room, side: "west", distance: dWest }
    : { room, side: "east", distance: dEast };
}

const OPPOSITE: Record<OpeningSide, OpeningSide> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

function assignOne(
  rooms: Room[],
  px: number,
  py: number,
  orientation: "h" | "v",
  type: "door" | "window",
): { roomId: string; opening: RoomOpening }[] {
  const candidates = rooms
    .map((room) => matchRoom(room, px, py, orientation))
    .filter((c): c is Candidate => !!c && c.distance <= TOLERANCE_FT)
    .sort((a, b) => a.distance - b.distance);

  if (candidates.length === 0) return [];

  const best = candidates[0];
  // A second room only counts as a genuine connection when it's found on the
  // FACING side (the two rooms share that wall) — otherwise it's just another
  // nearby room and this opening is exterior-facing for `best`.
  const second = candidates
    .slice(1)
    .find((c) => c.room.id !== best.room.id && c.side === OPPOSITE[best.side]);

  if (type === "window" || !second) {
    return [{ roomId: best.room.id, opening: { type, side: best.side, connectsTo: type === "door" && second ? null : "exterior" } }];
  }
  return [
    { roomId: best.room.id, opening: { type, side: best.side, connectsTo: second.room.name } },
    { roomId: second.room.id, opening: { type, side: second.side, connectsTo: best.room.name } },
  ];
}

/** Maps every door/window in `plan` onto the room(s) it belongs to, by room id. */
export function assignOpenings(plan: Pick<FloorPlan, "rooms" | "doors" | "windows">): Record<string, RoomOpening[]> {
  const byRoom: Record<string, RoomOpening[]> = {};
  for (const room of plan.rooms) byRoom[room.id] = [];

  const openings = [
    ...plan.doors.map((d: Door) => ({ px: d.x, py: d.y, orientation: d.orientation, type: "door" as const })),
    ...(plan.windows ?? []).map((w: Window) => ({ px: w.x, py: w.y, orientation: w.orientation, type: "window" as const })),
  ];

  for (const o of openings) {
    for (const { roomId, opening } of assignOne(plan.rooms, o.px, o.py, o.orientation, o.type)) {
      byRoom[roomId]?.push(opening);
    }
  }
  return byRoom;
}
