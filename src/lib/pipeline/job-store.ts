/**
 * Job registry — in-memory, mirrored to Supabase.
 *
 * The module-level Map is the live source of truth within a process (route
 * handlers and the Inngest function share it in dev). Mutations also mirror the
 * snapshot to the `parse_jobs` table, but **non-blocking** (fire-and-forget):
 * persistence must never add latency to or break the pipeline. `getJob` falls
 * back to Supabase for jobs not in memory; `flushJob` lets background callers
 * (Inngest) await durability without slowing the synchronous request path.
 */

import { fetchParseJob, upsertParseJob } from "@/lib/supabase/parse-jobs";
import type { JobState, PipelineResult, PipelineStage, StorageRef } from "./types";

// Stash on globalThis so Fast Refresh / HMR doesn't wipe in-flight jobs.
const g = globalThis as unknown as { __vastoJobs?: Map<string, JobState> };
const jobs: Map<string, JobState> = g.__vastoJobs ?? new Map();
g.__vastoJobs = jobs;

const STAGE_PROGRESS: Record<PipelineStage, number> = {
  upload: 0.1,
  ocr: 0.3,
  gemini: 0.5,
  opencv: 0.75,
  merge: 0.9,
  done: 1,
};

const STAGE_MESSAGE: Record<PipelineStage, string> = {
  upload: "Uploading to storage",
  ocr: "Reading labels (OCR)",
  gemini: "Understanding rooms (Gemini Flash)",
  opencv: "Detecting geometry (OpenCV)",
  merge: "Merging semantics + geometry",
  done: "Done",
};

export interface JobMeta {
  appProjectId?: string;
  fileName?: string;
  mimeType?: string;
  storage?: StorageRef;
}

/** Persist the current in-memory snapshot. Best-effort; never throws. */
function mirror(jobId: string): Promise<void> {
  const state = jobs.get(jobId);
  if (!state) return Promise.resolve();
  return upsertParseJob(state).catch((e) =>
    console.warn("[job-store] mirror failed:", (e as Error).message),
  );
}

export function createJob(jobId: string, meta: JobMeta = {}): JobState {
  const state: JobState = {
    jobId,
    status: "queued",
    stage: "upload",
    progress: STAGE_PROGRESS.upload,
    message: STAGE_MESSAGE.upload,
    updatedAt: new Date().toISOString(),
    appProjectId: meta.appProjectId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    storageKey: meta.storage?.key,
    storageBackend: meta.storage?.backend,
  };
  jobs.set(jobId, state);
  void mirror(jobId);
  return state;
}

/**
 * In-memory first; falls back to Supabase for jobs not in this process. When a
 * job is loaded from Supabase it's hydrated into the Map so later mutations
 * (setStage/completeJob) land — important for the cross-process Inngest path.
 */
export async function getJob(jobId: string): Promise<JobState | undefined> {
  const local = jobs.get(jobId);
  if (local) return local;
  const remote = await fetchParseJob(jobId);
  if (remote) jobs.set(jobId, remote);
  return remote;
}

export function setStage(jobId: string, stage: PipelineStage): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = stage === "done" ? "done" : "running";
  job.stage = stage;
  job.progress = STAGE_PROGRESS[stage];
  job.message = STAGE_MESSAGE[stage];
  job.updatedAt = new Date().toISOString();
  void mirror(jobId);
}

export function completeJob(jobId: string, result: PipelineResult): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "done";
  job.stage = "done";
  job.progress = 1;
  job.message = STAGE_MESSAGE.done;
  job.result = result;
  job.storageKey = result.storage.key;
  job.storageBackend = result.storage.backend;
  job.updatedAt = new Date().toISOString();
  void mirror(jobId);
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "failed";
  job.error = error;
  job.updatedAt = new Date().toISOString();
  void mirror(jobId);
}

/**
 * Await the persistence of a job's current state. Use from background workers
 * (the Inngest function) where durability matters and added latency is free.
 * No-op when Supabase isn't configured.
 */
export function flushJob(jobId: string): Promise<void> {
  return mirror(jobId);
}
