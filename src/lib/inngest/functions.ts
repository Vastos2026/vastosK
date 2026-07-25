/**
 * parsePlanJob — the async pipeline triggered by `plan/uploaded`.
 *
 * Each diagram stage is a discrete `step.run`: retried independently and visible
 * in the Inngest dashboard. Steps return JSON only; the image bytes are re-read
 * from storage inside each compute step so nothing large crosses a step
 * boundary. Inngest JSON-serializes step outputs, so we re-assert the original
 * types on the way out. Progress is mirrored into the shared job store so the
 * client can poll GET /api/parse-plan?jobId=.
 */

import { completeJob, failJob, flushJob, getJob, setStage } from "@/lib/pipeline/job-store";
import { detectGeometry, emptyGeometry, type OpenCvResult } from "@/lib/pipeline/opencv";
import { runOCR, runSemantic } from "@/lib/ai/provider";
import { mergePlan, type MergeOutput } from "@/lib/pipeline/merge";
import { assignOpenings } from "@/lib/pipeline/assign-openings";
import { validatePlan } from "@/lib/pipeline/validate";
import { getObject } from "@/lib/pipeline/storage";
import type { OcrResult, PipelineResult, SemanticPlan } from "@/lib/pipeline/types";
import { inngest, type PlanUploadedData } from "./client";

export const parsePlanJob = inngest.createFunction(
  // Inngest v4: the trigger lives inside the options object (`triggers`).
  { id: "parse-floor-plan", name: "Parse floor plan", triggers: [{ event: "plan/uploaded" }] },
  async ({ event, step }) => {
    const { jobId, storageKey, storageBackend, fileName, mimeType, scale, longestSideFt } =
      event.data as PlanUploadedData;

    try {
      // Hydrate this process's in-memory job from Supabase if needed: the route
      // created it, but in serverless the function may run in another instance.
      await getJob(jobId);

      // OCR Extraction
      setStage(jobId, "ocr");
      const ocr = (await step.run("ocr-extraction", async () =>
        runOCR(await getObject(storageKey), mimeType),
      )) as OcrResult;

      // Gemini — reconstruct the layout from the plan image's printed dimensions
      setStage(jobId, "gemini");
      const semantic = (await step.run("gemini-flash", async () =>
        runSemantic(ocr, await getObject(storageKey), mimeType),
      )) as SemanticPlan;

      // OpenCV Analysis — DETECTION_MODE=gemini skips the Python subprocess
      // entirely (see pipeline.ts for why this is safe: the Merge Engine's
      // existing under-segmentation fallback handles zero detected rooms).
      setStage(jobId, "opencv");
      const geometry = (await step.run("opencv-analysis", async () =>
        process.env.DETECTION_MODE === "gemini"
          ? emptyGeometry(await getObject(storageKey))
          : detectGeometry(await getObject(storageKey), fileName),
      )) as OpenCvResult;

      // Merge Engine
      setStage(jobId, "merge");
      const merged = (await step.run("merge-engine", async () =>
        mergePlan({ geometry, semantic, fileName, scale, longestSideFt }),
      )) as MergeOutput;

      const plan = merged.plan;
      if (plan.meta) plan.meta.ocrTokens = ocr.tokens.length;
      const openingsByRoom = assignOpenings(plan);
      for (const room of plan.rooms) room.openings = openingsByRoom[room.id] ?? [];

      const validation = validatePlan(plan, semantic, geometry.buildingBox);
      // Reconstruction-quality-first confidence, nudged by the detector (mirrors
      // the sync pipeline) — a clean 7/7 layout reads ~0.91+.
      const confidence = Math.round(validation.score * (0.83 + 0.13 * geometry.confidence) * 100) / 100;
      if (plan.meta) plan.meta.confidence = confidence;

      const result: PipelineResult = {
        plan,
        geometry,
        ocr,
        semantic,
        confidence,
        calibrated: merged.calibrated,
        scale: merged.scale,
        storage: { key: storageKey, backend: storageBackend },
        stageMs: {},
        roomsNamed: merged.roomsNamed,
        items: merged.items,
        validation,
      };

      completeJob(jobId, result);
      await flushJob(jobId); // background path: guarantee the final state persists
      return { jobId, rooms: plan.rooms.length, roomsNamed: merged.roomsNamed };
    } catch (e) {
      failJob(jobId, e instanceof Error ? e.message : "Pipeline failed");
      await flushJob(jobId);
      throw e;
    }
  },
);
