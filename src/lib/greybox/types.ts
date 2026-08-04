/**
 * Greybox room description — the input to the perspective reference render
 * that locks door/window positions in generated room images (see
 * docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md).
 *
 * Deliberately carries no real-world units. `width`/`depth` are a PROPORTION
 * only; the plan editor supplies them from a normalised rectangle drawn on
 * the uploaded plan image. Real dimensions (Room.width/Room.height, in feet)
 * are a separate concern and are not reconciled with these.
 */

export type GreyboxWall = "north" | "south" | "east" | "west";

export interface GreyboxOpening {
  id: string;
  type: "door" | "window";
  wall: GreyboxWall;
  /** 0..1 centre position along the wall, in the plan's left-to-right / top-to-bottom order. */
  t: number;
  /**
   * Fixed real-world width, in feet — never derived from or scaled by the
   * wall's length, so it survives a later room resize unchanged. Mirrors
   * PlacedOpening.widthFt exactly (src/lib/types.ts) — ensure-greybox-key.ts
   * passes room.placedOpenings straight into this field with no per-field
   * transform, so the two types must change together.
   */
  widthFt: number;
}

/** One furniture proxy, already in world-feet coordinates (see furniture-layout.ts's
 *  toWorldFurniture for the room-local [0,1] -> world-feet conversion). */
export interface GreyboxFurniturePlacement {
  /** Catalogue key — see furniture-catalogue.ts. */
  kind: string;
  /** World X, feet, 0 = room centre. */
  x: number;
  /** World Z, feet, 0 = room centre. */
  z: number;
  /** Radians, about the vertical (Y) axis. */
  rotation: number;
}

export interface GreyboxRoomSpec {
  /** East-west extent. */
  width: number;
  /** North-south extent. */
  depth: number;
  openings: GreyboxOpening[];
  /** Phase B: furniture proxies. Optional and additive — a spec with none renders exactly as it
   *  did before this feature existed. */
  furniture?: GreyboxFurniturePlacement[];
}
