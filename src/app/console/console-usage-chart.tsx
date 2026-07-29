"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";

export interface ConsoleUserRenderSeries {
  userId: string;
  displayName: string | null;
  email: string | null;
  months: { month: string; count: number }[];
  total: number;
}

function monthLabel(monthKey: string) {
  return new Date(`${monthKey}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });
}

/**
 * Small inline-SVG sparkline, same dependency-free bar-chart approach as
 * src/components/usage-chart-client.tsx's per-day chart on the Profile page
 * — just shrunk to fit one table row per user rather than a single
 * full-width chart. A native <title> gives an exact count on hover instead
 * of the click-to-select panel the full-size chart uses (not worth the
 * interaction cost across what could be dozens of rows).
 */
function Sparkline({ months }: { months: { month: string; count: number }[] }) {
  const width = 160;
  const height = 32;
  const barGap = 2;
  const barWidth = width / Math.max(months.length, 1) - barGap;
  const max = Math.max(...months.map((m) => m.count), 1);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-8 w-40"
      role="img"
      aria-label={`Monthly renders: ${months.map((m) => `${monthLabel(m.month)} ${m.count}`).join(", ")}`}
    >
      {months.map((m, i) => {
        const barHeight = m.count === 0 ? 0 : Math.max(2, (height * m.count) / max);
        const x = i * (barWidth + barGap);
        const y = height - barHeight;
        return (
          <rect
            key={m.month}
            x={x}
            y={y}
            width={Math.max(0, barWidth)}
            height={barHeight}
            fill="var(--color-accent)"
            fillOpacity={0.85}
            rx={1}
          >
            <title>{`${monthLabel(m.month)}: ${m.count} render${m.count === 1 ? "" : "s"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/**
 * Admin-facing render analytics — one row per user with a sparkline of
 * their monthly render count, sorted busiest-first. Kept as a table rather
 * than one chart per user or a single stacked chart: those either don't
 * scale past a handful of users or make any one user's trend hard to read
 * once dozens are on screen.
 */
export function ConsoleUsageChart({
  series,
  monthKeys,
}: {
  series: ConsoleUserRenderSeries[];
  monthKeys: string[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return series;
    return series.filter(
      (s) =>
        (s.displayName ?? "").toLowerCase().includes(q) || (s.email ?? "").toLowerCase().includes(q),
    );
  }, [series, query]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => b.total - a.total), [filtered]);

  if (series.length === 0 || monthKeys.length === 0) {
    return (
      <div className="glass grid place-items-center rounded-2xl py-10 text-center">
        <div>
          <Icon name="BarChart3" className="mx-auto size-7 text-faint" />
          <p className="mt-3 text-sm text-muted">No render activity yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-sm font-medium text-muted">Renders by user</h2>
          <span className="text-xs text-faint">
            {monthLabel(monthKeys[0])}{" – "}
            {monthLabel(monthKeys[monthKeys.length - 1])}
          </span>
        </div>
        <div className="relative min-w-0">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter users"
            className="input h-8 w-48 pl-8 text-xs"
          />
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No users match your search.</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-left text-xs text-faint">
                <th className="pb-2 pr-3 font-medium">User</th>
                <th className="pb-2 pr-3 font-medium">Last {monthKeys.length} months</th>
                <th className="pb-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.userId} className="border-b border-white/[0.04] last:border-0">
                  <td className="max-w-[12rem] truncate py-2 pr-3 text-foreground">
                    {s.displayName || s.email || "Unnamed user"}
                  </td>
                  <td className="py-2 pr-3">
                    <Sparkline months={s.months} />
                  </td>
                  <td className="py-2 text-right text-muted">{s.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
