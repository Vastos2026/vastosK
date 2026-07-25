/* Types for the floor-plan parsing pipeline (see the diagram in the project docs):
 *   Upload → S3 → Inngest → OCR → Gemini Flash → OpenCV → Merge Engine.
 * These describe what flows *between* the stages. Feet-space domain types
 * (FloorPlan/Room/…) live in ../types and are produced by the Merge Engine. */

import type { DetectedGeometry, FloorPlan, PlacedItem } from "@/lib/types";

/** Coarse classification the OCR stage assigns to each text token. */
export type OcrCategory =
  | "room_name"
  | "dimension"
  | "scale"
  | "annotation"
  | "measurement"
  | "other";

/** A single piece of text read off the plan by the OCR stage. */
export interface OcrToken {
  text: string;
  category: OcrCategory;
  /** approximate bounding box in *normalized* [0..1] image coords (top-left origin) */
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  tokens: OcrToken[];
  /** concatenated token text — convenient input for the semantic stage */
  rawText: string;
  source: "gemini-vision" | "none";
}

/** A semantically-understood room from the Gemini Flash stage. */
export interface SemanticRoom {
  name: string;
  /** bedroom | bathroom | kitchen | living | dining | pooja | … */
  type?: string;
  widthFt?: number;
  heightFt?: number;
  /** top-left corner in feet from the plan's top-left (vision reconstruction) */
  xFt?: number;
  yFt?: number;
  /** names of rooms this room shares a wall with — drives gap-closing compaction */
  adjacentTo?: string[];
}

/** A furniture/fixture symbol Gemini read off the plan, mapped to feet space. */
export interface SemanticFurniture {
  /** sofa | chair | bed | table | dining_table | toilet | sink | wardrobe | tv | stove | plant | other */
  type: string;
  /** top-left corner in feet from the plan's top-left */
  xFt: number;
  yFt: number;
  /** footprint in feet, from the drawn symbol's box */
  widthFt: number;
  heightFt: number;
}

/** A door/window opening Gemini read off the image, mapped to feet space. */
export interface SemanticOpening {
  /** opening centre in feet from the plan's top-left */
  xFt: number;
  yFt: number;
  /** "h" = opening runs along a horizontal wall, "v" = vertical */
  orientation: "h" | "v";
  /** opening length in feet (windows; doors may omit) */
  lengthFt?: number;
}

/** Structured understanding of the plan, before geometry is known. */
export interface SemanticPlan {
  rooms: SemanticRoom[];
  /** door openings read from the image (vision path), in feet */
  doors?: SemanticOpening[];
  /** window openings read from the image (vision path), in feet */
  windows?: SemanticOpening[];
  /** furniture / fixtures drawn on the plan (vision path), in feet */
  furniture?: SemanticFurniture[];
  /** overall longest side in feet, if a dimension/scale label revealed it */
  longestSideFt?: number;
  /** overall building envelope in feet, read from the outer dimension chain */
  overallWidthFt?: number;
  overallHeightFt?: number;
  /** explicit feet-per-pixel if a scale bar was readable (rare) */
  scaleFtPerPx?: number;
  notes?: string;
  /** "gemini-vision" = full layout reconstructed from the image's printed dims */
  source: "gemini-flash" | "gemini-vision" | "fallback";
}

/** Where the original upload lives so later stages can read it back. */
export interface StorageRef {
  key: string;
  backend: "s3" | "local";
}

/** The diagram's stages, used for progress reporting. */
export type PipelineStage = "upload" | "ocr" | "gemini" | "opencv" | "merge" | "done";

/** Everything the pipeline produces — returned to the client / held on the job. */
export interface PipelineResult {
  plan: FloorPlan;
  geometry: DetectedGeometry;
  ocr: OcrResult;
  semantic: SemanticPlan;
  confidence: number;
  /** true when scale came from a real measurement, not the fallback constant */
  calibrated: boolean;
  scale: number;
  storage: StorageRef;
  /** per-stage wall-clock milliseconds, for observability */
  stageMs: Partial<Record<Exclude<PipelineStage, "done">, number>>;
  /** how many OpenCV room boxes received a Gemini name */
  roomsNamed: number;
  /** furniture / fixtures detected on the plan, as placeable items */
  items: PlacedItem[];
  /** reconstruction sanity checks surfaced to the upload UI */
  validation: PlanValidation;
}

/** One reconstruction sanity check surfaced to the upload UI. */
export interface PlanCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** Result of validating the merged plan before it reaches 3D. */
export interface PlanValidation {
  checks: PlanCheck[];
  /** fraction of checks passing, 0..1 */
  score: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

/** Server-side state for one parsing job, polled by the client in async mode. */
export interface JobState {
  jobId: string;
  status: JobStatus;
  stage: PipelineStage;
  /** 0..1 */
  progress: number;
  message: string;
  result?: PipelineResult;
  error?: string;
  updatedAt: string;
  /** local-first project id this run belongs to (recorded, not FK'd yet) */
  appProjectId?: string;
  fileName?: string;
  mimeType?: string;
  storageKey?: string;
  storageBackend?: string;
}

/** How a parse request was serviced. */
export type PipelineMode = "sync" | "inngest";
