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

/**
 * Which viewpoint the greybox camera renders from.
 *
 * "auto" is camera.ts's original behaviour and stays the default: score all
 * eight candidates and keep whichever sees the most openings. The four wall
 * values name the wall the camera STANDS AGAINST, not the wall it looks at —
 * so "north" backs onto the north wall (-Z) and therefore shows the south,
 * east and west walls. This is worth being precise about, because the one
 * wall a viewpoint can never show is its own: from inside a box, an 85 degree
 * camera aimed at the centre cannot see the surface behind it. A room with
 * openings on all four walls will always lose at least one, whichever value
 * is chosen, and that is geometry rather than a limitation of this code.
 */
export type GreyboxCameraView = "auto" | GreyboxWall;

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
  /**
   * The user's chosen viewpoint. Optional and additive in the same way: absent
   * or "auto" reproduces the original scorer exactly, so every existing call
   * site keeps its previous behaviour without being touched.
   *
   * Carried on the SPEC rather than passed as a separate argument on purpose.
   * The camera has to be identical everywhere it is derived — the Pass A
   * render, the Pass B mask, `projectOpenings`, the furniture exclusion zone
   * and `isInFrame` all reconstruct it from `greyboxCamera(spec, aspect)` —
   * and threading it through the one object they all already share is what
   * makes disagreement impossible rather than merely unlikely.
   */
  cameraView?: GreyboxCameraView;
}
