import { getUsageStats, getGenerationStats } from "@/lib/usage-stats";
import { Icon } from "@/components/ui/icon";
import { UsageChartClient, type UsageDay } from "./usage-chart-client";

const WINDOW_DAYS = 180;

/**
 * Server wrapper: fetches the current user's usage data (RLS-scoped, so this
 * naturally only ever sees their own rows) and hands a plain-data array to
 * the interactive client chart. Degrades to a small empty state when
 * Supabase isn't configured, the query fails, or there's simply no usage yet.
 */
export async function UsageChart() {
  const [callStats, genStats] = await Promise.all([
    getUsageStats(WINDOW_DAYS),
    getGenerationStats(WINDOW_DAYS),
  ]);

  if (!callStats || !genStats) {
    return (
      <div className="glass mt-6 grid place-items-center rounded-2xl py-10 text-center">
        <div>
          <Icon name="BarChart3" className="mx-auto size-7 text-faint" />
          <p className="mt-3 text-sm text-muted">No usage data yet.</p>
        </div>
      </div>
    );
  }

  const costByDate = new Map(callStats.map((d) => [d.date, d.estimatedCost]));
  const days: UsageDay[] = genStats.map((d) => ({
    date: d.date,
    generationCount: d.generationCount,
    projectCount: d.projectIds.length,
    estimatedCost: costByDate.get(d.date) ?? 0,
  }));

  const totalGenerations = days.reduce((sum, d) => sum + d.generationCount, 0);
  const totalCost = days.reduce((sum, d) => sum + d.estimatedCost, 0);

  if (totalGenerations === 0) {
    return (
      <div className="glass mt-6 grid place-items-center rounded-2xl py-10 text-center">
        <div>
          <Icon name="BarChart3" className="mx-auto size-7 text-faint" />
          <p className="mt-3 text-sm text-muted">No usage data yet.</p>
        </div>
      </div>
    );
  }

  return <UsageChartClient days={days} totalGenerations={totalGenerations} totalCost={totalCost} />;
}
