import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * One row per user-facing generation (Workstream 11) - "Generate", "Generate
 * more", a lasso edit, and a walkthrough video each insert a new row here
 * rather than overwriting one, so a project's generation history can be
 * browsed/restored later. Distinct from ai_usage_logs (src/lib/ai/usage-log.ts),
 * which is cost/analytics data an admin aggregates, not product-facing output.
 */
export interface GenerationEntry {
  projectId: string;
  /** the authenticated caller's id — required for the "own generations" RLS policy to ever match a read */
  userId: string;
  /** room id/name, or omit/null for a project-level (walkthrough) generation */
  roomKey?: string | null;
  type: "image" | "edit" | "video";
  /** the /api/render?key=... URL this generation is served from */
  storageUrl: string;
  modelUsed?: string;
}

/** Best-effort write to generations - never throws, never blocks the caller. */
export async function recordGeneration(entry: GenerationEntry): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  try {
    await db.from("generations").insert({
      project_id: entry.projectId,
      user_id: entry.userId,
      room_key: entry.roomKey ?? null,
      type: entry.type,
      storage_url: entry.storageUrl,
      model_used: entry.modelUsed ?? null,
    });
  } catch (e) {
    console.warn("[supabase/generations] insert failed (non-fatal):", (e as Error).message);
  }
}
