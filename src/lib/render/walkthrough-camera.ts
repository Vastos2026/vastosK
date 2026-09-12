/**
 * Per-room camera-move selection for the walkthrough (flow step 11).
 *
 * Replaces the single fixed zoom prompt every clip used to share. The client
 * asked for pans and tilts rather than one push-in repeated per room; the
 * constraint is that each clip is generated from ONE still image, so any
 * camera move that swings new area into frame is asking the model to invent
 * geometry that the greybox never rendered and the floor plan may contradict.
 *
 * A push-in is the only move that reveals essentially nothing new, which is
 * why it was the original — and remains the fallback. Everything here exists
 * to decide when a room can afford something richer.
 *
 * The decision is made from the SAME locked camera the reference image was
 * rendered through (`greyboxCamera` via `roomSpecFor`), so "is this opening on
 * screen, and where" is answered against the actual frame the model is looking
 * at rather than against the floor plan in the abstract. Openings that project
 * off-frame are the signal that matters: they are the geometry a pan would
 * swing toward, and they are exactly what was never rendered.
 *
 * Deterministic by construction, for the same reason the camera itself is (see
 * greybox/camera.ts): the same room must always pick the same move, or
 * regenerating a walkthrough would silently change the shot. `index` only
 * breaks ties the room's own geometry leaves genuinely open.
 */

import { greyboxCamera, projectOpenings } from "@/lib/greybox/camera";
import { GREYBOX_ASPECT, GREYBOX_RENDER_H, GREYBOX_RENDER_W } from "@/lib/greybox/dimensions";
import { furnitureForRoomType } from "@/lib/greybox/furniture-catalogue";
import { roomSpecFor } from "@/lib/greybox/room-spec";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

export type WalkthroughMove = "push_in" | "pan_left" | "pan_right" | "tilt_up";

export interface MoveChoice {
  move: WalkthroughMove;
  /** Why this move was picked — surfaced by /api/dev-check, never sent to a model. */
  reason: string;
}

/**
 * Floor area below which a lateral pan is refused. A camera standing inside a
 * small room is already close to both side walls, so even a few degrees of pan
 * swings a large fraction of an unrendered wall into frame — the same
 * geometry-crowding effect that forced GREYBOX_ROOM_SCALE to exist.
 */
const MIN_PAN_AREA_SQFT = 70;

/**
 * Width-to-depth ratio a room needs before a pan is worth it. In a roughly
 * square room the side walls already sit near the frame edges; the pan buys
 * little and costs the same risk.
 */
const WIDE_RATIO = 1.25;

/**
 * Share of a room's openings allowed to be off-frame before every move except
 * the push-in is refused. Above this, most of the room's real geometry is
 * outside the render, so any move revealing new area is guesswork. Note a room
 * with openings on all four walls ALWAYS loses at least one — the wall the
 * camera stands against can never be in shot (see camera.ts) — so this has to
 * tolerate some loss rather than demand a clean frame.
 */
const MAX_OFFSCREEN_RATIO = 0.5;

/** Frame bands, as fractions of width, used to call an opening left or right. */
const LEFT_BAND = 0.4;
const RIGHT_BAND = 0.6;

/** An opening must sit in the upper part of frame to justify tilting up to it. */
const UPPER_BAND = 0.55;

/**
 * Picks the camera move for one room. `index` is the room's position in the
 * walkthrough, used only as a deterministic tie-break so a project whose rooms
 * all score identically still varies its shots.
 */
export function selectWalkthroughMove(room: Room, index: number): MoveChoice {
  // A room the furniture catalogue deliberately leaves bare (bathroom, store
  // room, WC — NO_FURNITURE_ROOM_TYPES, reached here through the same alias
  // normalisation the catalogue itself uses) has nothing worth panning across,
  // and is usually tiny besides.
  if (room.type && furnitureForRoomType(room.type).length === 0) {
    return { move: "push_in", reason: "room type is deliberately unfurnished" };
  }

  const spec = roomSpecFor(room);
  if (spec.openings.length === 0) {
    return { move: "push_in", reason: "no openings to anchor a reveal" };
  }

  const camera = greyboxCamera(spec, GREYBOX_ASPECT);
  const projected = projectOpenings(spec, camera);
  const onScreen = projected.filter((p) => p.px >= 0);
  const offScreenRatio = (projected.length - onScreen.length) / projected.length;

  if (offScreenRatio > MAX_OFFSCREEN_RATIO) {
    return { move: "push_in", reason: "most openings are off-frame; a reveal would be invented" };
  }
  if (onScreen.length === 0) {
    return { move: "push_in", reason: "no openings on screen to move toward" };
  }

  // True feet, NOT spec.width/spec.depth — those carry GREYBOX_ROOM_SCALE and
  // are greybox world units (see room-spec.ts).
  const { width, height } = layoutSize(room);
  const area = width * height;
  const wide = height > 0 && width / height >= WIDE_RATIO;

  if (area >= MIN_PAN_AREA_SQFT && wide) {
    const left = onScreen.filter((p) => p.px < GREYBOX_RENDER_W * LEFT_BAND).length;
    const right = onScreen.filter((p) => p.px > GREYBOX_RENDER_W * RIGHT_BAND).length;

    // Pan TOWARD rendered geometry, never away from it into the unrendered
    // edge. That single rule is what keeps a pan from inventing a wall.
    if (right > left) return { move: "pan_right", reason: "openings cluster right of frame" };
    if (left > right) return { move: "pan_left", reason: "openings cluster left of frame" };
    if (left > 0) {
      // Genuinely balanced — the room supports either direction equally, so
      // alternating is free variety rather than a coin flip over safety.
      const move = index % 2 === 0 ? "pan_left" : "pan_right";
      return { move, reason: "openings balanced both sides; alternating for variety" };
    }
  }

  // No pan available: a window high in frame is the one thing worth tilting up
  // to, since the reveal lands on wall and window head rather than on the blank
  // ceiling the greybox never detailed.
  const highWindow = onScreen.some((p) => p.type === "window" && p.py < GREYBOX_RENDER_H * UPPER_BAND);
  if (highWindow) {
    return { move: "tilt_up", reason: "window sits high in frame" };
  }

  return { move: "push_in", reason: "no safe reveal available" };
}

/**
 * The camera-motion clause for each move.
 *
 * Phrased as a bounded positive instruction ("no more than a few degrees")
 * rather than a list of prohibitions, per docs/PROMPTING-RULES.md — the
 * previous single prompt spent half its length on "No panning, no camera
 * rotation", which is both untrue of these moves now and the shape of
 * instruction that rulebook says to avoid.
 */
const MOVE_CLAUSES: Record<WalkthroughMove, string> = {
  push_in:
    "A slow, subtle cinematic push in toward the room shown. The camera glides steadily " +
    "forward along its own axis at an even speed from the first frame to the last, and does not rotate.",
  pan_left:
    "A slow, subtle cinematic pan to the left across the room shown. The camera turns gently " +
    "and evenly to the left, no more than a few degrees in total, holding one steady speed from " +
    "the first frame to the last.",
  pan_right:
    "A slow, subtle cinematic pan to the right across the room shown. The camera turns gently " +
    "and evenly to the right, no more than a few degrees in total, holding one steady speed from " +
    "the first frame to the last.",
  tilt_up:
    "A slow, subtle cinematic tilt upward across the room shown. The camera lifts its gaze " +
    "gently and evenly, no more than a few degrees in total, holding one steady speed from " +
    "the first frame to the last.",
};

/**
 * The consistency half of the prompt, kept VERBATIM from the original single
 * zoom prompt. It is load-bearing prompt text (AGENTS.md): it is what stops the
 * model redecorating the room between frames, and it is unrelated to which way
 * the camera moves — so it survives this change untouched.
 */
const CONSISTENCY_CLAUSE =
  "No new furniture, people, or objects invented — the room must stay exactly as shown, " +
  "and the walls, doors, and windows hold the exact positions they have in the image. " +
  "Only the camera moves.";

/** The full positive prompt sent to the video model for one room's clip. */
export function walkthroughPrompt(move: WalkthroughMove): string {
  return `${MOVE_CLAUSES[move]} ${CONSISTENCY_CLAUSE}`;
}
