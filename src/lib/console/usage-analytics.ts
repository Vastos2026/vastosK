import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTimeWindow } from "@/lib/time-buckets";
import type {
  UsagePoint,
  ModelBreakdown,
  ProviderBreakdown,
  UserUsageRow,
  UsageWindow,
  ConsoleUsageAnalytics,
} from "./usage-analytics-types";

export type {
  UsagePoint,
  ModelBreakdown,
  ProviderBreakdown,
  UserUsageRow,
  UsageWindow,
  ConsoleUsageAnalytics,
} from "./usage-analytics-types";

interface UsageLogRow {
  user_id: string | null;
  feature: string;
  provider: string;
  model: string | null;
  estimated_cost: number | null;
  success: boolean;
  created_at: string;
}

interface ProfileLite {
  id: string;
  displayName: string | null;
  email: string | null;
}

function aggregate(rows: UsageLogRow[], keys: string[], keySliceLength: number, profiles: Map<string, ProfileLite>): UsageWindow {
  const points = new Map<string, UsagePoint>(keys.map((k) => [k, { key: k, cost: 0, count: 0 }]));
  const models = new Map<string, ModelBreakdown>();
  const providers = new Map<string, ProviderBreakdown>();
  const users = new Map<string, UserUsageRow>();

  for (const row of rows) {
    const cost = Number(row.estimated_cost ?? 0);

    const pointKey = row.created_at.slice(0, keySliceLength);
    const point = points.get(pointKey);
    if (point) {
      point.cost += cost;
      point.count += 1;
    }

    const modelKey = `${row.provider}:${row.model ?? "unknown"}`;
    const model = models.get(modelKey) ?? { model: row.model ?? "unknown", provider: row.provider, cost: 0, count: 0 };
    model.cost += cost;
    model.count += 1;
    models.set(modelKey, model);

    const provider = providers.get(row.provider) ?? { provider: row.provider, cost: 0, count: 0 };
    provider.cost += cost;
    provider.count += 1;
    providers.set(row.provider, provider);

    if (row.user_id) {
      const profile = profiles.get(row.user_id);
      const user = users.get(row.user_id) ?? {
        userId: row.user_id,
        displayName: profile?.displayName ?? null,
        email: profile?.email ?? null,
        cost: 0,
        count: 0,
        successCount: 0,
        failCount: 0,
      };
      user.cost += cost;
      user.count += 1;
      if (row.success) user.successCount += 1;
      else user.failCount += 1;
      users.set(row.user_id, user);
    }
  }

  return {
    points: Array.from(points.values()),
    models: Array.from(models.values()).sort((a, b) => b.cost - a.cost),
    providers: Array.from(providers.values()).sort((a, b) => b.cost - a.cost),
    users: Array.from(users.values()).sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Console Analytics page data — one query against `ai_usage_logs` covering
 * the trailing 12 months (a superset of both windows below), aggregated in
 * JS into a day-granularity window (last 30 days) and a month-granularity
 * window (last 12 months) so the page's Day/Month toggle is a pure client-
 * side switch between two already-fetched datasets, no second round-trip.
 *
 * Admin-scoped: takes the service-role client the Analytics page already
 * builds (cross-user by design, same rationale the old console/render-stats.ts
 * used — RLS on ai_usage_logs otherwise scopes reads to "your own rows").
 * Returns null on query failure, matching this app's degrade-gracefully
 * contract for every other Supabase read.
 */
export async function getConsoleUsageAnalytics(
  admin: SupabaseClient,
  profiles: ProfileLite[],
): Promise<ConsoleUsageAnalytics | null> {
  const monthWindow = buildTimeWindow(12, "month");
  const dayWindow = buildTimeWindow(30, "day");

  const { data, error } = await admin
    .from("ai_usage_logs")
    .select("user_id, feature, provider, model, estimated_cost, success, created_at")
    .gte("created_at", monthWindow.since.toISOString())
    .order("created_at", { ascending: true });

  if (error || !data) return null;

  const rows = data as UsageLogRow[];
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const dayRows = rows.filter((r) => r.created_at >= dayWindow.since.toISOString());

  return {
    day: aggregate(dayRows, dayWindow.keys, 10, profileById),
    month: aggregate(rows, monthWindow.keys, 7, profileById),
  };
}
