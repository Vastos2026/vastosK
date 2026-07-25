/**
 * Client helper for the floor-plan parsing pipeline.
 *
 * Posts the image to `POST /api/parse-plan`, which either returns the result
 * inline (`mode:"sync"`) or hands off to Inngest (`mode:"inngest"`), in which
 * case we poll `GET /api/parse-plan?jobId=` until the job finishes. Either way
 * the caller gets a single `ParseResult` and staged progress callbacks.
 */

import type { DetectedGeometry, FloorPlan, PlacedItem } from "./types";
import type {
  JobState,
  OcrResult,
  PipelineMode,
  PipelineResult,
  PlanValidation,
  SemanticPlan,
} from "./pipeline/types";

export type DetectStage = "upload" | "ocr" | "gemini" | "opencv" | "merge" | "done";

export interface DetectProgress {
  stage: DetectStage;
  /** 0–1 */
  progress: number;
  message: string;
}

export interface ParseResult {
  geometry: DetectedGeometry;
  plan: FloorPlan;
  confidence: number;
  /** true when scale came from a known dimension (accurate), not the fallback */
  calibrated: boolean;
  scale: number;
  /** pipeline extras (present for real pipeline runs) */
  ocr?: OcrResult;
  semantic?: SemanticPlan;
  storage?: PipelineResult["storage"];
  roomsNamed?: number;
  /** furniture / fixtures detected on the plan, placed in feet */
  items?: PlacedItem[];
  /** reconstruction sanity checks for the upload UI */
  validation?: PlanValidation;
}

export interface ParseOptions {
  /** Known longest side of the plan, in feet — makes dimensions accurate. */
  longestSideFt?: number;
  /** Explicit feet-per-pixel scale, if already known. */
  scale?: number;
  /** Local-first project id, recorded on the persisted parse job. */
  projectId?: string;
}

interface PostResponse {
  jobId: string;
  mode: PipelineMode;
  result?: PipelineResult;
  error?: string;
}

const STAGE_MESSAGE: Record<DetectStage, string> = {
  upload: "Uploading to storage",
  ocr: "Reading labels (OCR)",
  gemini: "Understanding rooms (Gemini Flash)",
  opencv: "Detecting geometry (OpenCV)",
  merge: "Merging semantics + geometry",
  done: "Detection complete",
};

function toResult(r: PipelineResult): ParseResult {
  return {
    geometry: r.geometry,
    plan: r.plan,
    confidence: r.confidence,
    calibrated: r.calibrated,
    scale: r.scale,
    ocr: r.ocr,
    semantic: r.semantic,
    storage: r.storage,
    roomsNamed: r.roomsNamed,
    items: r.items,
    validation: r.validation,
  };
}

export async function parsePlanViaApi(
  file: File,
  opts: ParseOptions = {},
  onProgress?: (p: DetectProgress) => void,
): Promise<ParseResult> {
  onProgress?.({ stage: "upload", progress: 0.1, message: STAGE_MESSAGE.upload });

  const form = new FormData();
  form.append("file", file);
  if (opts.longestSideFt) form.append("longestSideFt", String(opts.longestSideFt));
  if (opts.scale) form.append("scale", String(opts.scale));
  if (opts.projectId) form.append("projectId", opts.projectId);

  const res = await fetch("/api/parse-plan", { method: "POST", body: form });
  if (!res.ok) {
    let msg = `Parser returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  const data = (await res.json()) as PostResponse;

  // Sync mode — the result is already here (no Inngest dev server needed).
  if (data.mode === "sync" && data.result) {
    onProgress?.({ stage: "done", progress: 1, message: STAGE_MESSAGE.done });
    return toResult(data.result);
  }

  // Inngest mode — poll the job to completion.
  return pollJob(data.jobId, onProgress);
}

async function pollJob(
  jobId: string,
  onProgress?: (p: DetectProgress) => void,
): Promise<ParseResult> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(700);
    const res = await fetch(`/api/parse-plan?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) continue;

    const job = (await res.json()) as JobState;
    const stage = job.stage as DetectStage;
    onProgress?.({
      stage,
      progress: job.progress,
      message: STAGE_MESSAGE[stage] ?? job.message,
    });

    if (job.status === "done" && job.result) return toResult(job.result);
    if (job.status === "failed") throw new Error(job.error || "Pipeline failed");
  }
  throw new Error("Timed out waiting for the parsing job");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
