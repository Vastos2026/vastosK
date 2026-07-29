import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTimeWindow } from "@/lib/time-buckets";

export interface UserRenderMonth {
  /** YYYY-MM */
  month: string;
  count: number;
}

export interface UserRenderStats {
  userId: string;
  months: UserRenderMonth[];
  total: number;
}

const MONTHS_WINDOW = 6;

/**
 * Per-user monthly render counts for the console's analytics chart —
 * "render" here matches the same definition src/lib/usage-stats.ts's
 * getGenerationStats already uses for the Profile page's own chart: one row
 * in `generations` per Generate / Generate more / lasso edit / walkthrough
 * video call (type 'image' | 'edit' | 'video'), not `ai_usage_logs` (which
 * also counts non-render calls like 'ocr'/'semantic' and failed attempts).
 *
 * Takes the admin client the console page already builds rather than
 * creating its own — this is an admin-only cross-user view, so it
 * intentionally bypasses the RLS that scopes `generations`/`ai_usage_logs`
 * reads to "your own rows" everywhere else in the app.
 *
 * Returns null when the query fails (degrade gracefully, same contract as
 * every other Supabase read in this app).
 */
export async function getConsoleRenderStats(
  admin: SupabaseClient,
  months = MONTHS_WINDOW,
): Promise<{ monthKeys: string[]; byUser: Map<string, UserRenderStats> } | null> {
  const { since, keys: monthKeys } = buildTimeWindow(months, "month");

  const { data, error } = await admin
    .from("generations")
    .select("user_id, created_at")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: true });

  if (error || !data) return null;

  const byUser = new Map<string, UserRenderStats>();
  for (const row of data as { user_id: string | null; created_at: string }[]) {
    if (!row.user_id) continue; // user_id references auth.users on delete set null
    const monthKey = row.created_at.slice(0, 7);
    let stats = byUser.get(row.user_id);
    if (!stats) {
      stats = {
        userId: row.user_id,
        months: monthKeys.map((m) => ({ month: m, count: 0 })),
        total: 0,
      };
      byUser.set(row.user_id, stats);
    }
    const bucket = stats.months.find((m) => m.month === monthKey);
    if (bucket) {
      bucket.count += 1;
      stats.total += 1;
    }
    // Rows older than the window (shouldn't happen given the `gte` filter
    // above, but the `created_at` slice is defensive) are silently dropped.
  }

  return { monthKeys, byUser };
}
