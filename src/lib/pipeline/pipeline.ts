/**
 * Pipeline orchestrator — the synchronous core.
 *
 * Runs the stages in the diagram's order: OCR → Gemini Flash → OpenCV → Merge.
 * Called directly in sync mode (a single await in the route) and stage-by-stage
 * by the Inngest function (each stage wrapped in step.run for retries +
 * dashboard observability). Keeping the logic here means both modes run exactly
 * the same code.
 */

import { pxToFtTransform } from "../lasso-extract";
import { runOCR, runSemantic } from "@/lib/ai/provider";
import { detectGeometry } from "./opencv";
import { mergePlan } from "./merge";
import { validatePlan } from "./validate";
import type { OcrResult, PipelineResult, PipelineStage, StorageRef } from "./types";

export interface PipelineInput {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  storage: StorageRef;
  /** explicit feet-per-pixel scale, if already known */
  scale?: number;
  /** known longest side of the plan in feet — makes dimensions accurate */
  longestSideFt?: number;
}

export async function runPipeline(
  input: PipelineInput,
  onStage?: (stage: PipelineStage) => void,
): Promise<PipelineResult> {
  const stageMs: PipelineResult["stageMs"] = {};
  const timed = async <T>(
    stage: Exclude<PipelineStage, "done">,
    fn: () => Promise<T>,
  ): Promise<T> => {
    onStage?.(stage);
    const t = Date.now();
    const out = await fn();
    stageMs[stage] = Date.now() - t;
    return out;
  };

  // OCR is only consumed by the token FALLBACK; the vision reconstruction path
  // ignores it. Run it LAZILY (memoised) so a successful vision read doesn't pay
  // for a full ~80s transcription pass it never uses — a big speed win on dense
  // plans. It still runs (once) if vision fails and the fallback needs tokens.
  const ocrBox: { value: OcrResult | null } = { value: null };
  const getOcr = async () =>
    (ocrBox.value ??= await runOCR(input.bytes, input.mimeType));
  const semantic = await timed("gemini", () =>
    runSemantic(getOcr, input.bytes, input.mimeType),
  );
  const geometry = await timed("opencv", () => detectGeometry(input.bytes, input.fileName));
  const merged = await timed("merge", async () =>
    mergePlan({
      geometry,
      semantic,
      fileName: input.fileName,
      scale: input.scale,
      longestSideFt: input.longestSideFt,
    }),
  );

  const plan = merged.plan;
  if (plan.meta) {
    plan.meta.ocrTokens = ocrBox.value?.tokens.length ?? 0;
    // Remember WHERE the source image lives and HOW plan feet map back onto it,
    // so a later per-room pass can re-crop the original for one room. Reuse the
    // SAME transform the lasso uses (anchored at the building footprint) rather
    // than deriving one here — a second definition would silently drift and crop
    // the wrong part of the plan.
    const T = pxToFtTransform(geometry, plan);
    plan.meta.storageKey = input.storage.key;
    plan.meta.originPxX = T.ox;
    plan.meta.originPxY = T.oy;
    plan.meta.ftPerPxX = T.sx;
    plan.meta.ftPerPxY = T.sy;
    plan.meta.imageWidth = geometry.imageWidth;
    plan.meta.imageHeight = geometry.imageHeight;
  }

  const validation = validatePlan(plan, semantic, geometry.buildingBox);

  // Confidence reflects reconstruction quality first (that's what "accuracy"
  // means to the user), nudged by the detector. A clean 7/7 layout reads ~0.91+
  // regardless of the noisy per-run detector score; each failing check pulls it
  // down honestly.
  const confidence = Math.round(validation.score * (0.83 + 0.13 * geometry.confidence) * 100) / 100;
  if (plan.meta) plan.meta.confidence = confidence;

  onStage?.("done");

  return {
    plan,
    geometry,
    ocr: ocrBox.value ?? { tokens: [], rawText: "", source: "none" },
    semantic,
    confidence,
    calibrated: merged.calibrated,
    scale: merged.scale,
    storage: input.storage,
    stageMs,
    roomsNamed: merged.roomsNamed,
    items: merged.items,
    validation,
  };
}
