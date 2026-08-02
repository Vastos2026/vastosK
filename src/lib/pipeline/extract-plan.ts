/**
 * Extraction pipeline orchestrator — the single entry point that replaces
 * the old OCR + OpenCV geometry + semantic + merge pipeline (see
 * docs/superpowers/specs/2026-07-26-fresh-start-frontend-and-extraction-design.md,
 * Section 1). Calls the one-shot Gemini extraction, maps its output onto the
 * existing FloorPlan/Room shape, and assigns each room a colour + a cosmetic
 * grid position (nothing in the new flow reads position spatially, but
 * `PlanThumb` on the dashboard project list still renders room.x/y, so a
 * position is always populated).
 */

import { randomUUID } from "node:crypto";
import {
  extractFloorPlan,
  extractOpeningGeometry,
  type CallContext,
  type RawBox,
  type RawExtractedRoom,
  type RawGeometry,
} from "@/lib/ai/provider";
import { ROOM_PALETTE } from "@/lib/utils";
import type { FloorPlan, PlacedOpening, Room } from "@/lib/types";
import type { OpeningSide, RoomOpening } from "./assign-openings";
import { DEFAULT_ROOM_SIZE_FT, emptyPlan, layoutSize } from "./empty-plan";
import { boxToShape, deriveOpenings, openingBoxToPlaced, seedPlacedOpenings } from "@/lib/plan-editor/geometry";

export interface ExtractPlanInput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  /** the active project category's room-type list, e.g. from getProjectTypeConfig(category).roomTypes */
  roomTypeHints: string[];
  ctx?: CallContext;
}

export interface ExtractPlanResult {
  plan: FloorPlan;
  /** false when the model couldn't read this as a floor plan at all */
  readable: boolean;
  confidence: number;
}

/** Grid packing constants — cosmetic only, see file header. */
const GRID_GAP_FT = 2;
const GRID_COLS = 4;

export async function runPlanExtraction(input: ExtractPlanInput): Promise<ExtractPlanResult> {
  const raw = await extractFloorPlan(input.bytes, input.mimeType, input.roomTypeHints, input.ctx);

  if (!raw.readable || raw.rooms.length === 0) {
    return {
      plan: emptyPlan(),
      readable: false,
      confidence: raw.confidence,
    };
  }

  // Geometry (box_2d per room + per opening) comes from a SEPARATE Gemini
  // call — see extractOpeningGeometry's doc comment in provider.ts for why
  // bundling it into the call above proved unreliable on dense plans.
  // Best-effort: never throws, so a geometry failure just means every room
  // falls back to the pre-existing manual "Place" flow, same as before this
  // feature existed.
  const geometry = await extractOpeningGeometry(
    input.bytes,
    input.mimeType,
    raw.rooms.map((r) => r.name),
    input.ctx,
  );
  const roomsWithGeometry = mergeGeometry(raw.rooms, geometry);

  const rooms = packRoomsGrid(roomsWithGeometry.map((r, i) => toRoom(r, i)));

  // Once every room's shape is known (from Gemini's box_2d reading — see
  // toRoom below), re-derive each opening's connectsTo from rectangle
  // adjacency (plan-editor/geometry.ts's deriveOpenings) instead of trusting
  // Gemini's own text-guessed connectsTo — same geometry-is-truth source the
  // Plan Editor's manual "Continue" step already uses, so a project that
  // never opens the Plan Editor still gets consistent opening data. A room
  // with no shape (Gemini wasn't confident about its box) keeps its
  // text-guessed openings unchanged — the existing fallback path.
  const derived = deriveOpenings(rooms);
  const finalRooms = rooms.map((r) => (r.shape ? { ...r, openings: derived[r.id] ?? [] } : r));

  const planWidth = Math.max(...finalRooms.map((r) => r.x + layoutSize(r).width), DEFAULT_ROOM_SIZE_FT);
  const planHeight = Math.max(...finalRooms.map((r) => r.y + layoutSize(r).height), DEFAULT_ROOM_SIZE_FT);

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms: finalRooms,
    doors: [],
    windows: [],
    meta: {
      source: "manual",
      confidence: raw.confidence,
    },
  };

  return { plan, readable: true, confidence: raw.confidence };
}

/**
 * Attaches the geometry call's boxes onto the matching room (by index —
 * see extractOpeningGeometry's doc comment for why index, not name) and its
 * openings (by type only, in order). Pairing a specific geometry box to a
 * specific semantic RawOpening doesn't matter for placement — the position
 * comes purely from the box's own pixels, not from which text entry it's
 * attached to — it only matters that door boxes pair with door entries.
 * Capped at the semantic call's own opening count per type: if geometry
 * over-detects (observed in testing — noisier than room detection), the
 * extra boxes are simply unused rather than injecting an opening the text
 * read never reported.
 */
function mergeGeometry(rooms: RawExtractedRoom[], geometry: RawGeometry): RawExtractedRoom[] {
  const roomBoxByIndex = new Map(geometry.roomBoxes.map((r) => [r.roomIndex, r.box]));
  const openingsByIndex = new Map<number, { type: "door" | "window"; box: RawBox }[]>();
  for (const o of geometry.openings) {
    const list = openingsByIndex.get(o.roomIndex) ?? [];
    list.push({ type: o.type, box: o.box });
    openingsByIndex.set(o.roomIndex, list);
  }

  return rooms.map((r, i) => {
    const box = roomBoxByIndex.get(i);
    if (!box) return r;
    const geomOpenings = openingsByIndex.get(i) ?? [];
    const byType: Record<"door" | "window", RawBox[]> = {
      door: geomOpenings.filter((o) => o.type === "door").map((o) => o.box),
      window: geomOpenings.filter((o) => o.type === "window").map((o) => o.box),
    };
    return {
      ...r,
      box,
      openings: r.openings.map((o) => ({ ...o, box: byType[o.kind].shift() })),
    };
  });
}

function toRoom(r: RawExtractedRoom, index: number): Room {
  // No fallback here on purpose — a room whose dimensions weren't legible on
  // the plan stays genuinely undefined rather than getting a fabricated
  // number nothing downstream can tell apart from a real reading (the old
  // DEFAULT_ROOM_SIZE_FT fallback did exactly that). Room Confirmation and
  // the AI prompting layer are the ones that decide how to show/handle that.
  const shape = r.box ? boxToShape(r.box) : undefined;

  // A room Gemini placed a confident box for is auto-placed on the Plan
  // Editor with real geometry, not a blank rectangle the user has to draw
  // and drag into position by hand. Per opening: use its own box when
  // Gemini gave one AND it plausibly sits on this room's wall; otherwise
  // fall back to a guessed even-spread position on its reported side (the
  // pre-existing fallback, seedPlacedOpenings). Either way this is a
  // starting point — the Plan Editor's manual drag is the correction layer.
  let placedOpenings: PlacedOpening[] | undefined;
  if (shape) {
    const unresolved: RoomOpening[] = [];
    const resolved: PlacedOpening[] = [];
    for (const o of r.openings) {
      const placed = o.box ? openingBoxToPlaced(shape, o.box, o.kind, randomUUID()) : null;
      if (placed) resolved.push(placed);
      else unresolved.push(toRoomOpening(o));
    }
    placedOpenings = unresolved.length
      ? [...resolved, ...seedPlacedOpenings(unresolved, r.widthFt, r.heightFt)]
      : resolved;
  }

  return {
    id: randomUUID(),
    name: r.name,
    type: r.type,
    width: r.widthFt,
    height: r.heightFt,
    x: 0,
    y: 0,
    color: ROOM_PALETTE[index % ROOM_PALETTE.length],
    openings: r.openings.map((o) => toRoomOpening(o)),
    shape,
    placedOpenings,
  };
}

function toRoomOpening(o: RawExtractedRoom["openings"][number]): RoomOpening {
  return {
    type: o.kind,
    side: o.side as OpeningSide,
    connectsTo: o.connectsTo ?? null,
  };
}

/**
 * Lays rooms out left-to-right, wrapping every GRID_COLS, purely so the
 * dashboard's PlanThumb has non-overlapping boxes to draw — not a claim
 * about the plan's real layout. Room Confirmation's list UI never reads
 * these positions.
 */
function packRoomsGrid(rooms: Room[]): Room[] {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  return rooms.map((room, i) => {
    if (i > 0 && i % GRID_COLS === 0) {
      cursorX = 0;
      cursorY += rowHeight + GRID_GAP_FT;
      rowHeight = 0;
    }
    const placed = { ...room, x: cursorX, y: cursorY };
    const size = layoutSize(room);
    cursorX += size.width + GRID_GAP_FT;
    rowHeight = Math.max(rowHeight, size.height);
    return placed;
  });
}
