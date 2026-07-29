"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

export interface UsageDay {
  /** YYYY-MM-DD */
  date: string;
  generationCount: number;
  /** distinct projects with a generation this day */
  projectCount: number;
  estimatedCost: number;
}

interface Bucket {
  /** bucket key: the day's date, or a month's "YYYY-MM" */
  key: string;
  label: string;
  generationCount: number;
  projectCount: number;
  estimatedCost: number;
}

function dayLabel(isoDay: string) {
  return new Date(`${isoDay}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayLabelFull(isoDay: string) {
  return new Date(`${isoDay}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function monthLabel(monthKey: string) {
  return new Date(`${monthKey}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Group daily buckets into calendar months, unioning project ids isn't
 *  possible here (only counts are passed down) — a project active across
 *  several days in the same month is counted once per day it was active,
 *  so a month's projectCount is an upper bound, not a distinct-project
 *  count. Good enough for "how much happened this month" at a glance. */
function toMonths(days: UsageDay[]): Bucket[] {
  const byMonth = new Map<string, Bucket>();
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const existing = byMonth.get(key);
    if (existing) {
      existing.generationCount += d.generationCount;
      existing.projectCount += d.projectCount;
      existing.estimatedCost += d.estimatedCost;
    } else {
      byMonth.set(key, {
        key,
        label: monthLabel(key),
        generationCount: d.generationCount,
        projectCount: d.projectCount,
        estimatedCost: d.estimatedCost,
      });
    }
  }
  return Array.from(byMonth.values());
}

function toDayBuckets(days: UsageDay[]): Bucket[] {
  return days.map((d) => ({
    key: d.date,
    label: dayLabel(d.date),
    generationCount: d.generationCount,
    projectCount: d.projectCount,
    estimatedCost: d.estimatedCost,
  }));
}

export function UsageChartClient({
  days,
  totalGenerations,
  totalCost,
}: {
  days: UsageDay[];
  totalGenerations: number;
  totalCost: number;
}) {
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const buckets = useMemo(() => {
    if (granularity === "month") return toMonths(days);
    // Day view: the trailing 30 days read the most clearly as bars; the
    // month toggle is what surfaces the rest of the fetched window.
    return toDayBuckets(days.slice(-30));
  }, [days, granularity]);

  const selected = buckets.find((b) => b.key === selectedKey) ?? null;

  const width = 600;
  const height = 144;
  const padTop = 6;
  const padBottom = 18;
  const barGap = 2;
  const barWidth = width / Math.max(buckets.length, 1) - barGap;
  const max = Math.max(...buckets.map((b) => b.generationCount), 1);
  const labelEvery = Math.max(1, Math.round(buckets.length / 6));

  return (
    <div className="glass mt-6 rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-sm font-medium text-muted">
            AI usage {granularity === "day" ? "(last 30 days)" : "(by month)"}
          </h2>
          <span className="text-xs text-faint">
            {totalGenerations} generation{totalGenerations === 1 ? "" : "s"}
            {totalCost > 0 && <> · est. ${totalCost.toFixed(2)}</>}
          </span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-0.5">
          <Button
            size="sm"
            variant={granularity === "day" ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setGranularity("day");
              setSelectedKey(null);
            }}
          >
            Days
          </Button>
          <Button
            size="sm"
            variant={granularity === "month" ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              setGranularity("month");
              setSelectedKey(null);
            }}
          >
            Months
          </Button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-36 w-full"
        role="img"
        aria-label={`${totalGenerations} AI generations, ${granularity === "day" ? "last 30 days" : "by month"}`}
      >
        <line x1={0} y1={height - padBottom} x2={width} y2={height - padBottom} stroke="var(--color-border)" strokeWidth={1} />
        {buckets.map((b, i) => {
          const barHeight = b.generationCount === 0 ? 0 : Math.max(2, ((height - padTop - padBottom) * b.generationCount) / max);
          const x = i * (barWidth + barGap);
          const y = height - padBottom - barHeight;
          const isSelected = b.key === selectedKey;
          return (
            <g
              key={b.key}
              onClick={() => setSelectedKey(isSelected ? null : b.key)}
              className="cursor-pointer"
            >
              {/* Full-height invisible hit area so a near-empty bar is still easy to click. */}
              <rect x={x} y={padTop} width={Math.max(0, barWidth)} height={height - padTop - padBottom} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={Math.max(0, barWidth)}
                height={barHeight}
                fill="var(--color-accent)"
                fillOpacity={isSelected ? 1 : 0.85}
                rx={1}
              />
              {i % labelEvery === 0 && (
                <text x={x + barWidth / 2} y={height - 4} fontSize={9} fill="var(--color-faint)" textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {selected && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-xs text-foreground">
          <Icon name="BarChart3" className="size-3.5 shrink-0 text-accent" />
          <span className="flex-1">
            <strong className="font-medium">
              {granularity === "day" ? dayLabelFull(selected.key) : selected.label}
            </strong>
            {" — "}
            {selected.generationCount} generation{selected.generationCount === 1 ? "" : "s"} across{" "}
            {selected.projectCount} project{selected.projectCount === 1 ? "" : "s"}
            {selected.estimatedCost > 0 && <> · est. ${selected.estimatedCost.toFixed(2)}</>}
          </span>
          <button
            onClick={() => setSelectedKey(null)}
            className="cursor-pointer text-faint hover:text-foreground"
            aria-label="Close"
          >
            <Icon name="X" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
