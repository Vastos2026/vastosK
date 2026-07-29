/**
 * Shared "trailing N days/months" window math for usage/analytics queries —
 * `usage-stats.ts`'s `getUsageStats`/`getGenerationStats` and
 * `console/render-stats.ts`'s `getConsoleRenderStats` each independently
 * computed a `since` timestamp and pre-seeded every bucket key in the
 * window, differing only in day vs. month granularity. Only that window/key
 * computation is shared here — each caller still builds its own bucket
 * shape and does its own row accumulation.
 *
 * Always UTC: bucket keys must match `created_at` (an ISO timestamp,
 * inherently UTC) — computing a window boundary in the server process's
 * local timezone (e.g. via `setHours`/`setDate`) would shift every bucket
 * key by the local UTC offset on any non-UTC host, silently dropping
 * today's/this-month's rows into no bucket at all.
 */
export function buildTimeWindow(
  count: number,
  unit: "day" | "month",
): { since: Date; keys: string[] } {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  if (unit === "month") {
    since.setUTCDate(1);
    since.setUTCMonth(since.getUTCMonth() - (count - 1));
  } else {
    since.setUTCDate(since.getUTCDate() - (count - 1));
  }

  const keySliceLength = unit === "month" ? 7 : 10; // "YYYY-MM" vs "YYYY-MM-DD"
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(since);
    if (unit === "month") d.setUTCMonth(d.getUTCMonth() + i);
    else d.setUTCDate(d.getUTCDate() + i);
    keys.push(d.toISOString().slice(0, keySliceLength));
  }

  return { since, keys };
}
