/* Domain types for the Vastos frontend (mock layer). */

import type { DesignSpecification, LuxuryLevel, UniversalInput } from "./ai/prompting/types";
import type { GreyboxWall } from "./greybox/types";

export type PropertyType = "apartment" | "villa" | "office" | "commercial";

export type ProjectStatus = "draft" | "parsing" | "parsed" | "designing" | "rendered";

/** Unit system for displaying/editing dimensions — canonical storage is always decimal feet. */
export type Unit = "ft-in" | "ft" | "m" | "cm";

export type Phase = "upload" | "plan" | "review" | "design" | "generate" | "approve" | "walkthrough";

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
  /** 0..1 fraction of the wall's length. */
  span: number;
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
   * Room boundary boxes in pixels. The label-anchored detector
   * (DETECTOR=labeled) also fills `name`/`type` from the plan's printed labels;
   * the contour detector leaves them undefined and names come from Gemini.
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
  /** the assembled prompt that produced it, kept for traceability, never shown to the user */
  prompt: string;
  /** "Other requirements" note for this one generation (Generate More), if any */
  note?: string;
  /** true when this version came from a lasso edit of an earlier version, not a fresh generation */
  edited?: boolean;
}

/** One room's generation history + Final Image Selection state. */
export interface RoomCard {
  roomId: string;
  generations: RoomGeneration[];
  /** id of the RoomGeneration approved as this room's final image */
  approvedId?: string;
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
  /** room ids in the confirmed order the clips were concatenated in */
  roomOrder: string[];
  error?: string;
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
