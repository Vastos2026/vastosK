/**
 * The three billing-cycle labels the console's admin UI offers — shared so
 * the dropdown (console/user-row.tsx, a client component) and the
 * period-math (api-guard.ts's checkUsageLimit, server-only) can't silently
 * drift apart. Kept in its own file, without a "server-only" import, since
 * both a client component and server-only code need to read it.
 */
export const BILLING_CYCLES = ["Monthly", "Quarterly", "Yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export function isBillingCycle(v: string): v is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(v);
}

/**
 * `profiles.next_billing_date` stores a single ANCHOR date the admin sets
 * once (must be strictly in the future — see `updateBilling`), not a value
 * that needs manual re-entry every renewal. `computeCurrentBillingDate` rolls
 * that anchor forward by whole cycle-intervals until it lands strictly after
 * `now` — every reader (profile page's reminder, the console's display,
 * checkUsageLimit's period math) calls this instead of trusting the stored
 * value directly, so the "next billing date" shown/used is always the
 * genuinely upcoming one, automatically, with nothing to go stale.
 */
function addCycle(d: Date, cycle: BillingCycle): Date {
  const monthsFwd = cycle === "Monthly" ? 1 : cycle === "Quarterly" ? 3 : 12; // "Yearly"
  const targetMonth = d.getUTCMonth() + monthsFwd;
  // Clamp to the target month's last real day — same reasoning as
  // api-guard.ts's stepBack: naively adding months can overflow past a
  // shorter month (e.g. Jan 31 + 1 month would otherwise land on Mar 3).
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), targetMonth, Math.min(d.getUTCDate(), daysInTargetMonth)));
}

/** One cycle interval subtracted from `d`, clamped the same way as `addCycle`. Used to find a billing period's start from its (live-computed) end. */
export function stepBackOneCycle(d: Date, cycle: BillingCycle): Date {
  const monthsBack = cycle === "Monthly" ? 1 : cycle === "Quarterly" ? 3 : 12;
  const targetMonth = d.getUTCMonth() - monthsBack;
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), targetMonth, Math.min(d.getUTCDate(), daysInTargetMonth)));
}

/**
 * Rolls `anchorIso` forward by whole `cycle` intervals until it's strictly
 * after `now` — the currently-active "next billing date." Capped at 1000
 * iterations as a backstop against a corrupt/far-past anchor value; returns
 * the anchor itself unrolled in that unreachable case rather than looping
 * forever.
 */
export function computeCurrentBillingDate(anchorIso: string, cycle: BillingCycle, now: Date = new Date()): Date {
  let d = new Date(anchorIso);
  for (let i = 0; i < 1000 && d.getTime() <= now.getTime(); i++) {
    d = addCycle(d, cycle);
  }
  return d;
}
