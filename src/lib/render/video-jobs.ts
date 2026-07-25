/**
 * Durable registry for long-running render jobs (the ~100s Veo walkthrough).
 *
 * The walkthrough result used to live ONLY in the awaiting component's promise:
 * a page reset, a local-store sync race, or a dev-server restart mid-generation
 * orphaned the finished clip even though the mp4 + stills were safely in S3 —
 * a paid Veo generation looked "lost" and invited an expensive regenerate.
 *
 * Same pattern as the parse pipeline's job-store: an in-memory Map (stashed on
 * globalThis so Fast Refresh doesn't wipe it) is the live source of truth, and
 * every mutation mirrors to the `render_jobs` table best-effort — persistence
 * never adds latency or failure to the render path. `getVideoJob` falls back to
 * Supabase for jobs from a previous process.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

export interface VideoJobFrame {
  view: string;
  label: string;
  key: string;
  imageUrl: string;
}

export interface VideoJobResult {
  key: string;
  videoUrl: string;
  frames: VideoJobFrame[];
  /**
   * Non-fatal quality warning surfaced to the user (the clip is still returned).
   * Set when one or more orbit segments couldn't be pinned to their end frame, so
   * placements may drift across that seam — the user can retry for a cleaner orbit.
   */
  warning?: string;
}

export interface VideoJobState {
  jobId: string;
  appProjectId?: string;
  status: "processing" | "done" | "failed";
  /** human-readable progress line for a processing job ("Filming segment 2/4…") */
  stage?: string;
  result?: VideoJobResult;
  error?: string;
  updatedAt: string;
}

const TABLE = "render_jobs";

const g = globalThis as unknown as { __vastoVideoJobs?: Map<string, VideoJobState> };
const jobs: Map<string, VideoJobState> = g.__vastoVideoJobs ?? new Map();
g.__vastoVideoJobs = jobs;

interface RenderJobRow {
  id: string;
  app_project_id: string | null;
  status: VideoJobState["status"];
  result: VideoJobResult | null;
  error: string | null;
  updated_at: string;
}

/** Best-effort mirror of the in-memory snapshot. Never throws. */
function mirror(jobId: string): void {
  const state = jobs.get(jobId);
  const db = supabaseAdmin();
  if (!state || !db) return;
  void db
    .from(TABLE)
    .upsert(
      {
        id: state.jobId,
        app_project_id: state.appProjectId ?? null,
        kind: "video",
        status: state.status,
        result: state.result ?? null,
        error: state.error ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .then(({ error }) => {
      if (error) console.warn("[video-jobs] mirror failed:", error.message);
    });
}

export function createVideoJob(jobId: string, appProjectId?: string): void {
  jobs.set(jobId, {
    jobId,
    appProjectId,
    status: "processing",
    updatedAt: new Date().toISOString(),
  });
  mirror(jobId);
}

/**
 * Update a processing job's progress line (in-memory only — the stage is UI
 * sugar; a crashed process just loses the label, never the job).
 */
export function stageVideoJob(jobId: string, stage: string): void {
  const job = jobs.get(jobId);
  if (!job || job.status !== "processing") return;
  job.stage = stage;
  job.updatedAt = new Date().toISOString();
}

export function completeVideoJob(jobId: string, result: VideoJobResult): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "done";
  job.stage = undefined;
  job.result = result;
  job.updatedAt = new Date().toISOString();
  mirror(jobId);
}

export function failVideoJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "failed";
  job.stage = undefined;
  job.error = error;
  job.updatedAt = new Date().toISOString();
  mirror(jobId);
}

/** In-memory first; falls back to Supabase for jobs from a previous process. */
export async function getVideoJob(jobId: string): Promise<VideoJobState | undefined> {
  const local = jobs.get(jobId);
  if (local) return local;
  const db = supabaseAdmin();
  if (!db) return undefined;
  const { data, error } = await db.from(TABLE).select("*").eq("id", jobId).maybeSingle();
  if (error) {
    console.warn("[video-jobs] fetch failed:", error.message);
    return undefined;
  }
  if (!data) return undefined;
  const row = data as RenderJobRow;
  const state: VideoJobState = {
    jobId: row.id,
    appProjectId: row.app_project_id ?? undefined,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    updatedAt: row.updated_at,
  };
  jobs.set(jobId, state);
  return state;
}
