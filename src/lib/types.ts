/* Domain types for the Vasto Studios frontend (mock layer). */

export type PropertyType = "apartment" | "villa" | "office" | "commercial";

export type ProjectStatus = "draft" | "parsing" | "parsed" | "designing" | "rendered";

export type Phase = "upload" | "review" | "rooms" | "renders";

export type RenderStatus = "queued" | "processing" | "completed" | "failed";

/** A detected room from floor-plan parsing (geometry + semantics). */
export interface Room {
  id: string;
  name: string;
  /** semantic room type from Gemini (bedroom | kitchen | living | …) */
  type?: string;
  /** width × height in feet */
  width: number;
  height: number;
  /** top-left position on the 2D plan grid, in feet */
  x: number;
  y: number;
  color: string;
  /** ceiling height in feet (user-set on the room page); defaults to 9 if unset */
  ceilingFt?: number;
  /**
   * Optional per-room design brief — leads the render prompt when set. Lives on
   * the room (not page state) so a reload can't silently drop it mid-design.
   */
  brief?: string;
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
  /** representative wall + floor colors used by the 3D preview */
  wallColor: string;
  floorColor: string;
  accentColor: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: "seating" | "tables" | "storage" | "lighting" | "decor" | "beds";
  /** footprint in feet */
  w: number;
  d: number;
  /** height in feet */
  h: number;
  color: string;
  icon: string;
}

/** An instance of a catalog item placed in a room. */
export interface PlacedItem {
  id: string;
  catalogId: string;
  name: string;
  roomId?: string;
  /** position in feet on the plan */
  x: number;
  y: number;
  /** rotation in degrees */
  rotation: number;
  w: number;
  d: number;
  h: number;
  color: string;
  /** AI-suggested but not yet accepted */
  ghost?: boolean;
}

/**
 * One furniture item's verdict from the render verify loop: the render was
 * vision-checked against its own 3D screenshot, and missing pieces were
 * repaired in place with a targeted edit.
 *   present   — seen in the render where the plan puts it
 *   repaired  — was missing, added back by the repair pass, now present
 *   missing   — still absent after repairs (or repair unavailable)
 *   misplaced — present, but well away from where its 3D box sits in frame
 *   offscreen — its box isn't visible in this camera's frame (not an error)
 *   unchecked — the checker itself was unavailable; no claim either way
 */
export interface FurnitureCheck {
  name: string;
  status: "present" | "repaired" | "missing" | "misplaced" | "offscreen" | "unchecked";
  /** short location phrase from the checker (evidence, shown as a hint) */
  where?: string;
}

export interface RenderVersion {
  id: string;
  label: string;
  createdAt: string;
  note: string;
  /** style snapshot for this version (enables visible compare / style-switch) */
  styleId?: string;
  /** URL of the real generated image for this version (served from storage) */
  imageUrl?: string;
  /** storage key of the image — used as the base for a later inpaint edit */
  imageKey?: string;
  /** the FLUX prompt that produced this version, for transparency */
  prompt?: string;
  /** furniture verify-loop result for this version (ticks in the UI) */
  checklist?: FurnitureCheck[];
  /** substantial furniture the checker saw that matches nothing in the plan */
  extras?: string[];
  /**
   * Non-fatal quality warning for this version (shown as a banner). Set on a
   * walkthrough clip when a side still couldn't be verified or a Veo turn
   * couldn't be pinned to its end frame — the output is kept, but placements may
   * drift and a retry would be cleaner.
   */
  warning?: string;
}

export interface RenderJob {
  id: string;
  // front/side/corner/corner-back/top are 3D-camera renders; left/right/back are
  // stills extracted from the orbit VIDEO; pano holds the orbit video itself.
  view: "front" | "side" | "corner" | "corner-back" | "left" | "right" | "back" | "top" | "pano";
  styleId: string;
  /** the room this render is focused on (room-by-room flow); absent = whole scene */
  roomId?: string;
  status: RenderStatus;
  createdAt: string;
  /** progress 0–100 while processing */
  progress: number;
  versions: RenderVersion[];
  /** failure reason when status === "failed" */
  error?: string;
  /**
   * For the left/right/back stills extracted from a walkthrough: the id of the
   * `pano` render they were produced with. Lets the reconcile pass complete
   * exactly this attempt's sides (not every same-room side record) when it
   * recovers a walkthrough whose response never reached the client.
   */
  videoOf?: string;
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
  placedItems: PlacedItem[];
  renders: RenderJob[];
}
