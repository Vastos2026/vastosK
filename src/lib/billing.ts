/**
 * The three billing-cycle labels the console's admin UI offers — shared so
 * the dropdown (console/user-row.tsx, a client component) and the
 * period-math (api-guard.ts's checkUsageLimit, server-only) can't silently
 * drift apart. Kept in its own file, without a "server-only" import, since
 * both a client component and server-only code need to read it.
 */
export const BILLING_CYCLES = ["Monthly", "Quarterly", "Yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];
