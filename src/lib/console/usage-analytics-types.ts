/**
 * Pure type definitions, no server/DB access — split out from
 * usage-analytics.ts (which is server-only) specifically so client
 * components (analytics-dashboard.tsx) can import these shapes directly
 * without pulling a server-only-guarded module into the client bundle. Same
 * fix as friendly-model-label.ts/model-labels.ts and provider-types.ts/
 * provider-settings.ts — see friendly-model-label.ts's comment for why.
 */
export interface UsagePoint {
  /** "YYYY-MM-DD" (day window) or "YYYY-MM" (month window) */
  key: string;
  cost: number;
  count: number;
}

export interface ModelBreakdown {
  model: string;
  provider: string;
  cost: number;
  count: number;
}

export interface ProviderBreakdown {
  provider: string;
  cost: number;
  count: number;
}

export interface UserUsageRow {
  userId: string;
  displayName: string | null;
  email: string | null;
  cost: number;
  count: number;
  successCount: number;
  failCount: number;
}

export interface UsageWindow {
  points: UsagePoint[];
  models: ModelBreakdown[];
  providers: ProviderBreakdown[];
  users: UserUsageRow[];
}

export interface ConsoleUsageAnalytics {
  day: UsageWindow;
  month: UsageWindow;
}
