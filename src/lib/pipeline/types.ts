/**
 * Shared storage-reference type. The floor-plan pipeline is now a single
 * Gemini vision call (see pipeline/extract-plan.ts) — this file no longer
 * describes a multi-stage OCR/OpenCV/merge pipeline; `StorageRef` is the
 * one surviving type, used by pipeline/storage.ts to record where an
 * uploaded floor-plan image lives so it can be read back by key.
 */

/** Where the original upload lives so later stages can read it back. */
export interface StorageRef {
  key: string;
  backend: "s3" | "local";
}
