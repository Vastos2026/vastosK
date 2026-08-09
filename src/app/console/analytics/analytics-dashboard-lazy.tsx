"use client";

import dynamic from "next/dynamic";
import type { ConsoleUsageAnalytics } from "@/lib/console/usage-analytics-types";

/**
 * PERF: `ssr:false` dynamic import of the real dashboard, wrapped in this
 * tiny Client Component boundary because Next.js disallows `ssr:false`
 * directly inside a Server Component — page.tsx (the only caller) is one,
 * and `next/dynamic`'s own docs say so explicitly (lazy-loading.md: "ssr:
 * false is not allowed with next/dynamic in Server Components. Please move
 * it into a Client Component").
 *
 * Measured via `.next/diagnostics/route-bundle-stats.json` after `npm run
 * build`: /console/analytics carried firstLoadUncompressedJsBytes of
 * 1178.8KB vs. ~840KB on routes with no chart library, because
 * analytics-dashboard.tsx imports recharts at module scope. This route is
 * admin-only ("master" role, gated by requireRole in page.tsx) and the
 * chart data (`analytics`) is already fetched server-side before this
 * component ever renders, so deferring recharts to its own chunk — loaded
 * only once the browser hydrates — costs nothing but a brief "Loading usage
 * charts…" placeholder on an already-privileged, low-traffic page.
 */
const AnalyticsDashboardImpl = dynamic(
  () => import("./analytics-dashboard").then((m) => m.AnalyticsDashboard),
  {
    ssr: false,
    loading: () => (
      <div className="glass grid h-64 place-items-center rounded-2xl text-center">
        <p className="text-sm text-muted">Loading usage charts…</p>
      </div>
    ),
  },
);

export function AnalyticsDashboard({ analytics }: { analytics: ConsoleUsageAnalytics }) {
  return <AnalyticsDashboardImpl analytics={analytics} />;
}
