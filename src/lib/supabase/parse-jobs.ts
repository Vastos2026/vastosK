/**
 * Supabase persistence for the parsing pipeline's `parse_jobs` table.
 *
 * Maps the in-memory `JobState` to/from a row so a run survives process
 * restarts and is visible across serverless instances. Every call is
 * best-effort: it never throws, so a database hiccup can't break the pipeline
 * (the in-memory job store remains the live source of truth — see job-store.ts).
 */

import type { DetectedGeometry, FloorPlan } from "@/lib/types";
import type { JobState, OcrResult, PipelineResult, SemanticPlan } from "@/lib/pipeline/types";
import { validatePlan } from "@/lib/pipeline/validate";
import { supabaseAdmin } from "./server";

const TABLE = "parse_jobs";

/** Shape of a `parse_jobs` row (jsonb columns typed loosely). */
interface ParseJobRow {
  id: string;
  app_project_id: string | null;
  status: JobState["status"];
  stage: JobState["stage"];
  progress: number | string | null;
  message: string | null;
  file_name: string | null;
  mime_type: string | null;
  storage_key: string | null;
  storage_backend: string | null;
  ocr: unknown;
  semantics: unknown;
  raw_geometry: unknown;
  merged: unknown;
  confidence: number | string | null;
  scale: number | string | null;
  calibrated: boolean | null;
  rooms_named: number | null;
  stage_ms: unknown;
  error: string | null;
  updated_at: string;
}

function toRow(s: JobState): Record<string, unknown> {
  const r = s.result;
  return {
    id: s.jobId,
    app_project_id: s.appProjectId ?? null,
    status: s.status,
    stage: s.stage,
    progress: s.progress,
    message: s.message ?? null,
    file_name: s.fileName ?? null,
    mime_type: s.mimeType ?? null,
    storage_key: r?.storage.key ?? s.storageKey ?? null,
    storage_backend: r?.storage.backend ?? s.storageBackend ?? null,
    ocr: r?.ocr ?? null,
    semantics: r?.semantic ?? null,
    raw_geometry: r?.geometry ?? null,
    merged: r?.plan ?? null,
    confidence: r?.confidence ?? null,
    scale: r?.scale ?? null,
    calibrated: r?.calibrated ?? null,
    rooms_named: r?.roomsNamed ?? null,
    stage_ms: r?.stageMs ?? null,
    error: s.error ?? null,
    updated_at: new Date().toISOString(),
  };
}

function fromRow(row: ParseJobRow): JobState {
  const result: PipelineResult | undefined = row.merged
    ? {
        plan: row.merged as FloorPlan,
        geometry: row.raw_geometry as DetectedGeometry,
        ocr: row.ocr as OcrResult,
        semantic: row.semantics as SemanticPlan,
        confidence: Number(row.confidence ?? 0),
        calibrated: !!row.calibrated,
        scale: Number(row.scale ?? 0),
        storage: {
          key: row.storage_key ?? "",
          backend: (row.storage_backend as "s3" | "local") ?? "local",
        },
        stageMs: (row.stage_ms as PipelineResult["stageMs"]) ?? {},
        roomsNamed: row.rooms_named ?? 0,
        // Detected furniture isn't persisted on the job row; it lives on the
        // local-first project (placedItems). Rehydrate empty here.
        items: [],
        validation: validatePlan(
          row.merged as FloorPlan,
          row.semantics as SemanticPlan,
          (row.raw_geometry as DetectedGeometry)?.buildingBox,
        ),
      }
    : undefined;
  return {
    jobId: row.id,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress ?? 0),
    message: row.message ?? "",
    error: row.error ?? undefined,
    updatedAt: row.updated_at,
    appProjectId: row.app_project_id ?? undefined,
    fileName: row.file_name ?? undefined,
    mimeType: row.mime_type ?? undefined,
    storageKey: row.storage_key ?? undefined,
    storageBackend: row.storage_backend ?? undefined,
    result,
  };
}

/** Best-effort upsert of the full job snapshot. Never throws. */
export async function upsertParseJob(state: JobState): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.from(TABLE).upsert(toRow(state), { onConflict: "id" });
  if (error) console.warn("[parse-jobs] upsert failed:", error.message);
}

/** Best-effort fetch; returns undefined if unconfigured, missing, or errored. */
export async function fetchParseJob(jobId: string): Promise<JobState | undefined> {
  const db = supabaseAdmin();
  if (!db) return undefined;
  const { data, error } = await db.from(TABLE).select("*").eq("id", jobId).maybeSingle();
  if (error) {
    console.warn("[parse-jobs] fetch failed:", error.message);
    return undefined;
  }
  return data ? fromRow(data as ParseJobRow) : undefined;
}
