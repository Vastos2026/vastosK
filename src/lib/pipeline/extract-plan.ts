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
import { extractFloorPlan, type CallContext, type RawExtractedRoom } from "@/lib/ai/provider";
import { ROOM_PALETTE } from "@/lib/utils";
import type { FloorPlan, Room } from "@/lib/types";
import type { OpeningSide, RoomOpening } from "./assign-openings";
import { DEFAULT_ROOM_SIZE_FT, emptyPlan, layoutSize } from "./empty-plan";

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

  const rooms = packRoomsGrid(raw.rooms.map((r, i) => toRoom(r, i)));
  const planWidth = Math.max(...rooms.map((r) => r.x + layoutSize(r).width), DEFAULT_ROOM_SIZE_FT);
  const planHeight = Math.max(...rooms.map((r) => r.y + layoutSize(r).height), DEFAULT_ROOM_SIZE_FT);

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms,
    doors: [],
    windows: [],
    meta: {
      source: "manual",
      confidence: raw.confidence,
    },
  };

  return { plan, readable: true, confidence: raw.confidence };
}

function toRoom(r: RawExtractedRoom, index: number): Room {
  // No fallback here on purpose — a room whose dimensions weren't legible on
  // the plan stays genuinely undefined rather than getting a fabricated
  // number nothing downstream can tell apart from a real reading (the old
  // DEFAULT_ROOM_SIZE_FT fallback did exactly that). Room Confirmation and
  // the AI prompting layer are the ones that decide how to show/handle that.
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
