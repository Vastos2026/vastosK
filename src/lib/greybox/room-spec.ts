import { seedPlacedOpenings } from "@/lib/plan-editor/geometry";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { GreyboxCameraView } from "./types";
import type { PlacedOpening, Room } from "@/lib/types";

/**
 * The subset of a room's greybox geometry the SERVER needs to rebuild the
 * exact camera the client rendered from.
 *
 * Kept deliberately small: width, depth, openings and the chosen view are the
 * complete input to `greyboxCamera`, and nothing else about a room affects
 * which viewpoint is selected.
 */
export interface RoomSpecPayload {
  width: number;
  depth: number;
  openings: PlacedOpening[];
  cameraView?: GreyboxCameraView;
}

/**
 * Derives that payload from a Room, using EXACTLY the same rules
 * `ensureGreybox` uses to build the spec it renders from.
 *
 * This has to agree with ensureGreybox or the whole feature is worse than
 * useless: the server rebuilds the camera from this payload in order to say
 * "the long low box at centre-left is the sofa", and if it reconstructs a
 * different camera than the one that produced the reference image, every
 * position phrase in the prompt points at the wrong box. That is a more
 * damaging failure than having no phrases at all, because a confident wrong
 * pointer actively misleads the model.
 *
 * Two rules are load-bearing and are the ones most likely to be forgotten if
 * a caller ever hand-rolls this:
 *
 *  - Openings fall back to `seedPlacedOpenings(room.openings)` when the room
 *    has no hand-placed ones. A manually added room never passed through the
 *    Plan Editor, so it has door/window counts per side but no positions, and
 *    the greybox spreads them evenly along their walls. Passing an empty
 *    array instead would select a camera for a room the renderer treats as
 *    having four openings.
 *  - Sizes come from `layoutSize`, not from `room.width`/`room.height`
 *    directly, since those are undefined for a room whose dimensions were
 *    never legible on the plan.
 */
export function roomSpecFor(room: Room): RoomSpecPayload {
  const { width, height } = layoutSize(room);
  return {
    width,
    depth: height,
    openings: room.placedOpenings?.length ? room.placedOpenings : seedPlacedOpenings(room.openings ?? []),
    cameraView: room.cameraView,
  };
}
