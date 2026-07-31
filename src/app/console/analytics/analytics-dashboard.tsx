"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import type { ConsoleUsageAnalytics, UsageWindow } from "@/lib/console/usage-analytics-types";
import { friendlyModelLabel } from "@/lib/ai/friendly-model-label";
import { CATEGORICAL, OTHER_COLOR, PROVIDER_COLOR, colorForIndex } from "./chart-colors";

const MAX_MODEL_SLOTS = 5;

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatDayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMonthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function foldToOther(models: UsageWindow["models"]) {
  if (models.length <= MAX_MODEL_SLOTS) return models;
  const head = models.slice(0, MAX_MODEL_SLOTS);
  const tail = models.slice(MAX_MODEL_SLOTS);
  const other = tail.reduce(
    (acc, m) => ({ model: "Other", provider: "", cost: acc.cost + m.cost, count: acc.count + m.count }),
    { model: "Other", provider: "", cost: 0, count: 0 },
  );
  return [...head, other];
}

interface TooltipPayloadItem {
  value?: number;
  payload?: { key: string };
}

function SpendTooltip({ active, payload, unit }: { active?: boolean; payload?: TooltipPayloadItem[]; unit: "day" | "month" }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  const key = point.payload?.key ?? "";
  return (
    <div className="rounded-lg border border-border bg-surface-3/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm">
      <p className="text-muted">{unit === "day" ? formatDayLabel(key) : formatMonthLabel(key)}</p>
      <p className="mt-0.5 font-medium text-foreground">{formatUsd(point.value ?? 0)}</p>
    </div>
  );
}

function SpendChart({ window: win, unit }: { window: UsageWindow; unit: "day" | "month" }) {
  const total = win.points.reduce((s, p) => s + p.cost, 0);
  const label = unit === "day" ? formatDayLabel : formatMonthLabel;

  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <p className="text-xs text-muted">Spend {unit === "day" ? "· last 30 days" : "· last 12 months"}</p>
          <p className="text-2xl font-semibold text-foreground">{formatUsd(total)}</p>
        </div>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={win.points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CATEGORICAL[0]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={CATEGORICAL[0]} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#262626" strokeDasharray="0" />
            <XAxis
              dataKey="key"
              tickFormatter={label}
              stroke="#666666"
              tick={{ fontSize: 11, fill: "#9a9a9a" }}
              tickLine={false}
              axisLine={{ stroke: "#262626" }}
              minTickGap={unit === "day" ? 24 : 8}
            />
            <YAxis
              tickFormatter={(v) => formatUsd(v)}
              stroke="#666666"
              tick={{ fontSize: 11, fill: "#9a9a9a" }}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <Tooltip content={<SpendTooltip unit={unit} />} cursor={{ stroke: "#363636", strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="cost"
              stroke={CATEGORICAL[0]}
              strokeWidth={2}
              fill="url(#spendFill)"
              dot={false}
              activeDot={{ r: 4, fill: CATEGORICAL[0], stroke: "#0d0d0d", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ProviderSplit({ window: win }: { window: UsageWindow }) {
  const total = win.providers.reduce((s, p) => s + p.cost, 0) || 1;
  return (
    <div className="glass rounded-2xl p-5">
      <p className="mb-4 text-xs text-muted">Provider split</p>
      <div className="flex flex-col gap-3">
        {win.providers.length === 0 && <p className="text-sm text-faint">No calls in this window.</p>}
        {win.providers.map((p) => {
          const pct = (p.cost / total) * 100;
          const color = PROVIDER_COLOR[p.provider] ?? OTHER_COLOR;
          return (
            <div key={p.provider}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-foreground">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  {p.provider === "google" ? "Gemini" : p.provider === "runware" ? "Runware" : p.provider}
                </span>
                <span className="text-muted">
                  {formatUsd(p.cost)} · {p.count} calls
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModelBreakdown({ window: win }: { window: UsageWindow }) {
  const models = foldToOther(win.models);
  const max = Math.max(...models.map((m) => m.cost), 0.0001);
  return (
    <div className="glass rounded-2xl p-5">
      <p className="mb-4 text-xs text-muted">Spend by model</p>
      <div className="flex flex-col gap-3">
        {models.length === 0 && <p className="text-sm text-faint">No calls in this window.</p>}
        {models.map((m, i) => {
          const color = m.model === "Other" ? OTHER_COLOR : colorForIndex(i);
          return (
            <div key={`${m.provider}:${m.model}`}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 truncate text-foreground">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate">
                    {m.model === "Other" ? "Other" : friendlyModelLabel(m.model)}
                    {m.model !== "Other" && (
                      <span className="ml-1.5 text-xs text-faint">{m.model}</span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-muted">
                  {formatUsd(m.cost)} · {m.count}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${(m.cost / max) * 100}%`, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserTable({ window: win }: { window: UsageWindow }) {
  return (
    <div className="glass overflow-hidden rounded-2xl">
      <div className="border-b border-white/5 px-5 py-4">
        <p className="text-xs text-muted">Usage by user</p>
      </div>
      {win.users.length === 0 ? (
        <p className="px-5 py-6 text-sm text-faint">No calls in this window.</p>
      ) : (
        <div className="scrollbar-thin max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-3/95 text-xs text-muted backdrop-blur-sm">
              <tr>
                <th className="px-5 py-2 text-left font-medium">User</th>
                <th className="px-5 py-2 text-right font-medium">Requests</th>
                <th className="px-5 py-2 text-right font-medium">Success</th>
                <th className="px-5 py-2 text-right font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {win.users.map((u) => {
                const successRate = u.count > 0 ? Math.round((u.successCount / u.count) * 100) : 0;
                return (
                  <tr key={u.userId} className="border-t border-white/5">
                    <td className="px-5 py-2.5 text-foreground">
                      {u.displayName || u.email || u.userId.slice(0, 8)}
                    </td>
                    <td className="px-5 py-2.5 text-right text-muted tabular-nums">{u.count}</td>
                    <td className="px-5 py-2.5 text-right text-muted tabular-nums">{successRate}%</td>
                    <td className="px-5 py-2.5 text-right font-medium text-foreground tabular-nums">
                      {formatUsd(u.cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AnalyticsDashboard({ analytics }: { analytics: ConsoleUsageAnalytics }) {
  const [unit, setUnit] = useState<"day" | "month">("day");
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  const win = useMemo(() => (unit === "day" ? analytics.day : analytics.month), [analytics, unit]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {(["day", "month"] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors cursor-pointer " +
                (unit === u ? "bg-surface-3 text-foreground" : "text-muted hover:text-foreground")
              }
            >
              {u === "day" ? "Daily" : "Monthly"}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="RefreshCw"
          loading={refreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          Refresh
        </Button>
      </div>

      <SpendChart window={win} unit={unit} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ModelBreakdown window={win} />
        <ProviderSplit window={win} />
      </div>

      <UserTable window={win} />
    </div>
  );
}
