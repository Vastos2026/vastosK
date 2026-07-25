import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { ErrorCategory } from "./errors";

export interface UsageLogEntry {
  userId?: string | null;
  projectId?: string | null;
  feature: "ocr" | "semantic" | "image" | "edit" | "video";
  model?: string;
  success: boolean;
  durationMs: number;
  errorCategory?: ErrorCategory;
}

/** Best-effort write to ai_usage_logs — never throws, never blocks the caller. */
export async function logUsage(entry: UsageLogEntry): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  try {
    await db.from("ai_usage_logs").insert({
      user_id: entry.userId ?? null,
      project_id: entry.projectId ?? null,
      feature: entry.feature,
      provider: "google",
      model: entry.model ?? null,
      success: entry.success,
      duration_ms: entry.durationMs,
      error_category: entry.errorCategory ?? null,
    });
  } catch (e) {
    console.warn("[ai/usage-log] insert failed (non-fatal):", (e as Error).message);
  }
}
