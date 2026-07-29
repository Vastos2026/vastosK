import "server-only";
import { supabaseServer } from "@/lib/supabase/server-client";
import { buildTimeWindow } from "@/lib/time-buckets";

export interface DailyUsage {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  estimatedCost: number;
}

/**
 * Per-day AI usage for the current user over the trailing `days` days, read
 * straight from `ai_usage_logs` via the cookie-aware (RLS-respecting) client
 * so results are naturally scoped to "my own rows" — same pattern
 * `getCurrentUser()` uses. Returns null when Supabase isn't configured or the
 * query fails, matching this codebase's degrade-gracefully contract; callers
 * should render a "No usage data yet" empty state in that case (and also when
 * every bucket comes back at zero).
 */
export async function getUsageStats(days = 30): Promise<DailyUsage[] | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;

  const { since, keys } = buildTimeWindow(days, "day");

  const { data, error } = await supabase
    .from("ai_usage_logs")
    .select("created_at, estimated_cost")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: true });

  if (error || !data) return null;

  const buckets = new Map<string, DailyUsage>();
  for (const key of keys) {
    buckets.set(key, { date: key, count: 0, estimatedCost: 0 });
  }

  for (const row of data as { created_at: string; estimated_cost: number | null }[]) {
    const key = row.created_at.slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the window, e.g. clock skew
    bucket.count += 1;
    bucket.estimatedCost += Number(row.estimated_cost ?? 0);
  }

  return Array.from(buckets.values());
}

export interface DailyGenerations {
  /** YYYY-MM-DD */
  date: string;
  generationCount: number;
  /** distinct project ids with at least one generation this day */
  projectIds: string[];
}

/**
 * Per-day generation + distinct-project counts for the current user, over
 * the trailing `days` days — the data the usage chart's click-to-drill-down
 * shows. Reads `generations` (not `ai_usage_logs`, which counts every AI
 * *call*, including retries/failures) via the same RLS-respecting client as
 * `getUsageStats`. "Projects" here means "projects with at least one
 * generation that day" rather than a `projects` table row count — most
 * projects don't have one yet (see CLAUDE.md's "Project lifecycle state
 * machine"), so that table would undercount badly.
 */
export async function getGenerationStats(days = 180): Promise<DailyGenerations[] | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;

  const { since, keys } = buildTimeWindow(days, "day");

  const { data, error } = await supabase
    .from("generations")
    .select("created_at, project_id")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: true });

  if (error || !data) return null;

  const buckets = new Map<string, { generationCount: number; projectIds: Set<string> }>();
  for (const key of keys) {
    buckets.set(key, { generationCount: 0, projectIds: new Set() });
  }

  for (const row of data as { created_at: string; project_id: string }[]) {
    const key = row.created_at.slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the window, e.g. clock skew
    bucket.generationCount += 1;
    bucket.projectIds.add(row.project_id);
  }

  return Array.from(buckets.entries()).map(([date, b]) => ({
    date,
    generationCount: b.generationCount,
    projectIds: Array.from(b.projectIds),
  }));
}
