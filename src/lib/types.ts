/* Domain types for the Vastos frontend (mock layer). */

import type {
  DesignReferenceAttributes,
  DesignSpecification,
  LuxuryLevel,
  UniversalInput,
} from "./ai/prompting/types";
import type { GreyboxCameraView, GreyboxWall } from "./greybox/types";

export type PropertyType = "apartment" | "villa" | "office" | "commercial";

export type ProjectStatus = "draft" | "parsing" | "parsed" | "designing" | "rendered";

/** Unit system for displaying/editing dimensions — canonical storage is always decimal feet. */
export type Unit = "ft-in" | "ft" | "m" | "cm";

export type Phase =
  | "upload"
  | "plan"
  | "review"
  | "furnish"
  | "design"
  | "generate"
  | "approve"
  | "walkthrough";

/**
 * A door/window placed by hand on a room's wall in the Plan Editor
 * (/projects/[id]/plan) — see docs/superpowers/specs/2026-08-01-greybox-*.
 */
export interface PlacedOpening {
  id: string;
  type: "door" | "window";
  wall: GreyboxWall;
  /**
   * 0..1 centre along the wall, in the plan's reading order (west->east on
   * north/south walls, north->south on east/west walls) — MUST match
   * greybox/build-scene.ts's wallFrame convention, or the greybox render
   * puts this opening on the wrong side of the wall.
   */
  t: number;
  /**
   * Fixed real-world width, in feet — e.g. STANDARD_DOOR_WIDTH_FT /
   * STANDARD_WINDOW_WIDTH_FT (see plan-editor/geometry.ts). Never derived
   * from, or scaled by, the room's/wall's current dimensions, so it
   * survives a later room resize unchanged — the same principle as
   * PlacedFurniture's footprintFt, already an absolute size never
   * normalized against room dimensions.
   */
  widthFt: number;
}

export type RenderStatus = "queued" | "processing" | "completed" | "failed";

/** A detected room from floor-plan parsing (geometry + semantics). */
export interface Room {
  id: string;
  name: string;
  /** semantic room type from Gemini (bedroom | kitchen | living | …) */
  type?: string;
  /**
   * Width x height in feet, when known. Undefined (not a fabricated default)
   * when Gemini couldn't read a printed dimension for this room and the user
   * hasn't filled it in yet — see extract-plan.ts's toRoom. Every consumer
   * that displays or sends this downstream must handle the missing case
   * explicitly rather than inventing a number (a wrong size baked into a
   * generated room image can't be un-rendered).
   */
  width?: number;
  height?: number;
  /** top-left position on the 2D plan grid, in feet */
  x: number;
  y: number;
  color: string;
  /**
   * Doors/windows on this room's walls, assigned deterministically post-merge
   * (see pipeline/assign-openings.ts) — never asserts a room has NO openings,
   * only states what was positively detected. Undefined until that stage runs.
   * Once `shape` is set, this is DERIVED from `placedOpenings` (see
   * plan-editor/geometry.ts's deriveOpenings) rather than Gemini's guess, so
   * this field's meaning is the same either way to every consumer.
   */
  openings?: import("./pipeline/assign-openings").RoomOpening[];
  /**
   * Normalised [0,1] rect on the uploaded plan image — the Plan Editor's
   * output. Undefined until the user places this room there; a room without
   * one keeps using the text-only openings clause (prompt-builder.ts).
   */
  shape?: { x: number; y: number; w: number; h: number };
  /**
   * Hand-placed doors/windows, the Plan Editor's source of truth once set.
   * `openings` above is derived from this.
   */
  placedOpenings?: PlacedOpening[];
  /** Storage key of this room's rendered perspective greybox reference image. */
  greyboxKey?: string;
  /** Pass B opening mask, stored beside greyboxKey as `{greyboxKey}-mask`. */
  greyboxMaskKey?: string;
  /**
   * The same conditioning render with numbered badges drawn over each
   * furniture piece (see greybox/render-annotated.ts) — a second reference
   * image for the Gemini (Nano Banana) image model ONLY, never sent to
   * FLUX.2. Stored beside greyboxKey as `{greyboxKey}-annotated`. Optional
   * and additive: absent whenever the room has no furniture in frame to
   * badge (render-mask.ts's renderGreyboxBundle produces no annotated image
   * at all in that case, rather than an unmodified duplicate), and for any
   * room rendered before this field existed.
   */
  greyboxAnnotatedKey?: string;
  /**
   * Content hash of everything the greybox render depends on. When this
   * differs from a freshly computed hash, the cached greyboxKey is stale and
   * must be re-rendered. Fixes the bug where editing a door in the Plan
   * editor after generating silently reused the old reference image.
   */
  greyboxHash?: string;
  /** Cached ledger, for UI display only. The prompt re-derives from the mask. */
  greyboxLedger?: GreyboxLedger;
  /**
   * Phase B: procedural furniture proxies placed in the 3D greybox (never on the 2D plan — see
   * docs/superpowers/plans/2026-08-01-greybox-phase-b-furniture.md). Optional and additive; a
   * room with none renders exactly as it did before this feature existed.
   */
  furniture?: PlacedFurniture[];
  /**
   * Which viewpoint this room's greybox renders from. Absent means "auto",
   * the original best-coverage scorer, so a room that predates this field
   * behaves exactly as it did. Part of the greybox hash — changing it must
   * invalidate the cached render, or the user picks a new angle and keeps
   * getting the old image back.
   */
  cameraView?: GreyboxCameraView;
}

/** One furniture proxy placed in a room's greybox — see furniture-catalogue.ts for `kind`s. */
export interface PlacedFurniture {
  id: string;
  /** Catalogue key, e.g. "bed", "sofa" — see src/lib/greybox/furniture-catalogue.ts. */
  kind: string;
  /** Room-local, 0..1 across the room's WIDTH (east-west). */
  x: number;
  /** Room-local, 0..1 across the room's DEPTH (north-south). */
  z: number;
  /** Radians, about the vertical (Y) axis. */
  rotation: number;
}

export interface GreyboxLedger {
  /** Doors visible in the Pass B mask from the locked camera. Not the same as placedOpenings.length. */
  doors: number;
  /** Windows visible in the Pass B mask from the locked camera. */
  windows: number;
}

export interface Door {
  id: string;
  /** wall midpoint in feet */
  x: number;
  y: number;
  /** "h" = on a horizontal wall, "v" = vertical */
  orientation: "h" | "v";
}

export interface Window {
  id: string;
  /** wall midpoint in feet */
  x: number;
  y: number;
  /** "h" = on a horizontal wall, "v" = vertical */
  orientation: "h" | "v";
  /** opening length in feet */
  length: number;
}

/** A wall segment in feet coordinates (output of line detection). */
export interface Wall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** wall thickness in feet */
  thickness: number;
}

/**
 * Raw OpenCV detection result, expressed in the *image's pixel* coordinate
 * space (before scaling to feet). Drawn directly over the uploaded preview.
 */
export interface DetectedGeometry {
  /** natural pixel dimensions of the analyzed image */
  imageWidth: number;
  imageHeight: number;
  walls: { x1: number; y1: number; x2: number; y2: number; thickness: number }[];
  doors: { x: number; y: number; orientation: "h" | "v" }[];
  windows: { x: number; y: number; orientation: "h" | "v"; length: number }[];
  /**
   * Room boundary boxes in pixels, as read off the plan by the Gemini vision
   * extraction call — which also supplies `name`/`type`.
   */
  rooms: {
    x: number;
    y: number;
    w: number;
    h: number;
    name?: string;
    type?: string;
    /** printed room dimensions in feet, when the label's dim text was read locally */
    widthFt?: number;
    heightFt?: number;
  }[];
  /**
   * Outer bounding box of all wall pixels = the building footprint, in pixels.
   * Used to scale a known building dimension against the *building* rather than
   * the whole sheet (which includes title block, compass and margins).
   */
  buildingBox?: { x: number; y: number; w: number; h: number };
  /** measured median wall stroke thickness in pixels */
  wallThicknessPx?: number;
  /** estimated feet-per-pixel scale used to convert to the plan */
  scale: number;
  /**
   * Feet-per-pixel resolved LOCALLY by the labeled detector from the plan's
   * printed room dimensions (readable on high-res uploads). Calibrates the
   * plan with zero network, so the merge produces true feet even when Gemini
   * is unavailable. Absent when no dimension text was legible.
   */
  scaleFtPerPx?: number;
  /** overall building envelope in feet, from `scaleFtPerPx` × buildingBox */
  overallWidthFt?: number;
  overallHeightFt?: number;
  /** which drawing style the detector matched: "pink" | "yellow" | "ink" */
  style?: string;
}

/** How the plan geometry was produced. */
export interface PlanMeta {
  /** "merged" = OpenCV geometry + Gemini semantics (the full pipeline) */
  source: "opencv" | "sample" | "manual" | "merged";
  /** 0–1 detector confidence for OpenCV runs */
  confidence?: number;
  detectedAt?: string;
  /** number of text tokens read by the OCR stage */
  ocrTokens?: number;
  /** how many detected room boxes received a semantic (Gemini) name */
  roomsNamed?: number;
  /**
   * Storage key of the uploaded plan image, plus the exact map back onto it, so
   * a later pass (per-room door/window/furniture detection) can re-crop the
   * ORIGINAL image for one room.
   *
   * This is the SAME transform the merge + lasso use, and it is anchored at the
   * detected building footprint — NOT the image origin — so it can't be
   * shortcut to a single feet-per-pixel:
   *   feet = (px - originPx) * ftPerPx   →   px = feet / ftPerPx + originPx
   */
  storageKey?: string;
  originPxX?: number;
  originPxY?: number;
  ftPerPxX?: number;
  ftPerPxY?: number;
  imageWidth?: number;
  imageHeight?: number;
}

export interface FloorPlan {
  fileName: string;
  /** object URL or data URL for the uploaded preview */
  previewUrl?: string;
  /** overall plan extent in feet */
  planWidth: number;
  planHeight: number;
  rooms: Room[];
  doors: Door[];
  walls?: Wall[];
  windows?: Window[];
  meta?: PlanMeta;
}

export interface DesignStyle {
  id: string;
  name: string;
  tagline: string;
  palette: string[];
}

/**
 * A detected-furniture candidate from the parsing pipeline (OCR/vision reading
 * what's drawn on the plan) — see pipeline/merge.ts's `toPlacedItems`. Kept
 * only as pipeline output typing; the app no longer places, persists, or
 * displays furniture as discrete objects (Workstream 8.5 destroyed the old
 * 3D furniture-placement studio — see docs/VASTOS_REVAMP_PLAN.md).
 */
export interface PlacedItem {
  id: string;
  catalogId: string;
  name: string;
  roomId?: string;
  x: number;
  y: number;
  rotation: number;
  w: number;
  d: number;
  h: number;
  color: string;
  ghost?: boolean;
}

/** One generated (or edited) image for a room — never overwritten, always a new entry. */
export interface RoomGeneration {
  id: string;
  createdAt: string;
  /** URL to display the image (served by GET /api/render) */
  imageUrl: string;
  /** storage key — base for a later lasso edit */
  imageKey: string;
  /**
   * DEPRECATED — no longer written, deliberately.
   *
   * This once held the full assembled prompt, returned by
   * /api/generate-room-image "for traceability". But "never shown to the
   * user" is not "never sent to the user": it travelled in the JSON
   * response, so the whole prompt — structural contract, opening census,
   * furniture descriptors, design brief — was readable in the browser's
   * Network tab on every generation, then persisted to localStorage and
   * mirrored to Supabase. For a licensed product whose prompt layer IS the
   * product, that handed the one thing worth protecting to anyone who opened
   * DevTools.
   *
   * Traceability lives server-side instead: prompt-builder.ts logs each
   * prompt's length and FNV-1a hash, and the `generations` table records the
   * model and version columns per render. Neither reaches the client.
   *
   * Kept OPTIONAL rather than removed so generations already in a user's
   * localStorage still parse. Nothing reads it — do not reintroduce a writer.
   */
  prompt?: string;
  /** "Other requirements" note for this one generation (Generate More), if any */
  note?: string;
  /** true when this version came from a lasso edit of an earlier version, not a fresh generation */
  edited?: boolean;
  /**
   * true when this version came from the Enhance button — a whole-image
   * re-render of an earlier version that keeps its camera, geometry, openings
   * and furniture placement and improves only finish, lighting and the
   * dressing layer. Sibling of `edited` above and carried for the same
   * reason: the gallery badges it so a strip of near-identical images can
   * still be told apart at a glance.
   */
  enhanced?: boolean;
}

/** One room's generation history + Final Image Selection state. */
export interface RoomCard {
  roomId: string;
  generations: RoomGeneration[];
  /** id of the RoomGeneration approved as this room's final image — auto-defaults to the first
   *  generation so Approve/Walkthrough have something usable before the user picks anything */
  approvedId?: string;
  /** true only once the user has explicitly picked a version on the Approve page (setApproved) —
   *  distinct from approvedId, which is auto-set by addGeneration; the workspace stepper's Approve
   *  checkmark reads THIS, not approvedId, so it doesn't turn green before the user ever visits Approve */
  approvedByUser?: boolean;
  /** included in the walkthrough — defaults to true once a room has an approved image */
  included: boolean;
}

/** The finished walkthrough video for a project. */
export interface Walkthrough {
  status: RenderStatus;
  createdAt: string;
  videoUrl?: string;
  videoKey?: string;
  /** stable unguessable token for the public share link */
  shareToken?: string;
  /**
   * Whether `shareToken` is actually saved on the server, or only here.
   *
   * `POST /api/share-link` can mint a token it cannot persist — the project
   * may not have synced to `project_snapshots` yet. Such a token resolves
   * for nobody: `/s/<token>` looks it up in that table and 404s. Before this
   * field, the token was cached locally and every later click reported
   * `persisted: true` from the cache, so the honest "saved on this device
   * for now" warning appeared once and then never again, while the link
   * stayed dead for the recipient.
   *
   * Recording it lets `useShareToken` retry against the server until it
   * genuinely lands, which it will once the snapshot syncs. Absent means
   * unknown — treated as not persisted, so an older project retries once
   * rather than inheriting a false guarantee.
   */
  shareTokenPersisted?: boolean;
  /** room ids in the confirmed order the clips were concatenated in */
  roomOrder: string[];
  error?: string;
}

/**
 * A design reference photo the user uploaded on the Design step, plus what
 * was read off it. When present, the Style / Luxury level / Colour palette
 * pickers are hidden and these attributes feed the Design Planning call in
 * their place (see src/lib/ai/prompting/design-reference.ts).
 *
 * Cached on the project alongside `universalInput`/`designSpec` for the same
 * reason those are: the analysis is one paid Gemini vision call, and it must
 * run once per uploaded image, never per generation.
 */
export interface DesignReference {
  attributes: DesignReferenceAttributes;
  /**
   * A small JPEG data URI of the upload, so the user can see WHICH reference
   * is active. Deliberately not a storage key: the original bytes are never
   * stored (see /api/design-reference's header), and a few tens of KB is what
   * this local-first, localStorage-backed store can actually carry. Absent if
   * the server couldn't re-encode the upload.
   */
  thumbnail?: string;
  /** short sha256 prefix of the uploaded bytes — the part of designSignature that changes when the reference does */
  hash: string;
  analysedAt: string;
}

export interface Project {
  id: string;
  name: string;
  propertyType: PropertyType;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
  floorPlan?: FloorPlan;
  /**
   * ISO timestamp set when the user clicks Continue on Room Confirmation
   * (review/page.tsx's `goToFurnish`, via the store's `confirmRooms`). This
   * is the actual "the user confirmed their rooms" signal —
   * `floorPlan.rooms.length > 0` alone is true the instant Gemini extraction
   * succeeds, before the user has looked at Room Confirmation at all, which
   * made the Review stepper pill show complete while the user was still on
   * the Plan page (reported bug, 2026-08-10). See
   * `workspace-frame.tsx`'s `computeDoneMap`.
   * Absent for any project created before this field existed; that case is
   * handled where `computeDoneMap` reads it, not here.
   */
  roomsConfirmedAt?: string;
  /**
   * ISO timestamp set when the user leaves the Plan Editor via its Continue
   * (or its confirmed Skip) — the actual "the user finished the Plan step"
   * signal, and the sibling of `roomsConfirmedAt` above.
   *
   * Exists because the Plan pill had no signal of its own: `computeDoneMap`
   * keyed it off `roomsConfirmedAt`, which is only set one step LATER on Room
   * Confirmation, so finishing the Plan page ticked nothing and the pill went
   * green only after Review was also confirmed (reported bug). It could not
   * simply key off `rooms.some(r => r.shape)` either — extract-plan.ts's
   * toRoom populates `shape` straight from Gemini's box_2d reading, so that
   * is true before the user has opened the editor at all, which is the
   * premature-done bug `roomsConfirmedAt` was itself introduced to fix.
   *
   * Absent for any project created before this field existed; that case is
   * handled where `computeDoneMap` reads it, not here.
   */
  planConfirmedAt?: string;
  /**
   * The user chose to skip the Plan step from the blank-canvas path — no
   * floor-plan image, no rooms drawn, no openings placed. Set only by the
   * Plan Editor's own confirmed skip (never inferred from "this project has
   * no shapes yet"), and cleared again when the user answers Yes to the
   * "you skipped this page, plan again?" prompt on returning there.
   *
   * It means one thing everywhere it is read: this project has no greybox.
   * The Furnish phase disappears from the stepper, "Adjust with 3D" is not
   * offered, Room Confirmation continues straight to Design, the furnish
   * routes are closed, and every generation skips ensureGreybox and sends no
   * greybox fields — which routes prompt-builder.ts to its `hasGreybox:
   * false` path. Already-generated images are untouched either way.
   */
  planSkipped?: boolean;
  styleId?: string;
  units?: Unit;
  /**
   * Global design selections (revamp Workstream 8) — the Universal JSON
   * Architecture's `design` section, chosen once on the Design step and
   * shared by every room so the whole project reads as one designer's work.
   */
  subcategory?: string;
  luxuryLevel?: LuxuryLevel;
  colourPalette?: string;
  /** Hex codes chosen via "Choose custom color" (colourPalette === "custom") — absent for a preset palette. */
  customColourHexes?: string[];
  /**
   * An uploaded design reference, when the user chose one instead of the
   * three pickers above. Those three fields keep whatever the pickers last
   * held while a reference is active — deliberately NOT overwritten with the
   * derived values, since `colourPalette` is a preset ID and would stop
   * matching any preset the moment prose was written into it, silently
   * breaking the picker the user sees again after removing the reference.
   */
  designReference?: DesignReference;
  /** One global free-text note (Workstream 8.5) — replaces the earlier per-room field. */
  additionalRequirements?: string;
  /** Cached Universal Input + Design Specification from the last Design Planning run. */
  universalInput?: UniversalInput;
  designSpec?: DesignSpecification;
  /**
   * Fingerprint of the design selections (subcategory/style/luxury/palette/
   * additional requirements) used for the last Design Planning run — lets
   * confirming Design again after only adding a room skip regenerating
   * images for rooms that already have one, instead of re-firing every
   * room's generation on an unrelated change.
   */
  designSignature?: string;
  /** Per-room generation history — the Room Generation Gallery + Final Image Selection. */
  roomCards: RoomCard[];
  walkthrough?: Walkthrough;
}
