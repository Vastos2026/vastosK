import "server-only";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase/server";
import { BILLING_CYCLES, type BillingCycle } from "@/lib/billing";
import type { SupabaseClient } from "@supabase/supabase-js";

interface GuardOptions {
  /** Per-user rate limit for this route; omit to skip rate limiting (e.g. a route with no AI/compute cost). */
  rateLimit?: { key: string; limit: number; windowMs: number };
  /** Skip the same-origin check — only for routes with no state-changing side effect. Default: checked. */
  checkOrigin?: boolean;
  /** Enforce the admin-set $ usage cap (see checkUsageLimit below) — only paid AI-generation routes opt in. */
  checkUsage?: boolean;
}

/**
 * Shared auth + CSRF + rate-limit + usage-limit guard for API routes (revamp
 * plan, "Security" section). Every route below used to repeat these same
 * checks inline; centralizing them here means a route can no longer be
 * accidentally left unguarded the way /api/share-link once was, and — same
 * reasoning — a future paid route can't forget the usage-limit check the way
 * 3 separate call sites once could (opt in via `checkUsage: true` instead of
 * a second manual call after this one returns).
 *
 * Returns the authenticated user on success, or a ready-to-return Response
 * on failure — callers do `const guard = await assertAllowed(...); if (guard
 * instanceof Response) return guard;` then use `guard` as the user.
 */
export async function assertAllowed(
  request: Request,
  opts: GuardOptions = {},
): Promise<CurrentUser | Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (opts.checkOrigin !== false && !isSameOrigin(request)) {
    return Response.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }

  if (opts.rateLimit) {
    const { key, limit, windowMs } = opts.rateLimit;
    if (!checkRateLimit(`${key}:${user.id}`, limit, windowMs)) {
      return Response.json({ error: "Too many requests, please slow down." }, { status: 429 });
    }
  }

  if (opts.checkUsage) {
    const usageBlock = await checkUsageLimit(user);
    if (usageBlock) return usageBlock;
  }

  return user;
}

/**
 * One interval of a billing cycle, subtracted from a Date (UTC), clamped to
 * the target month's last real day. `Date.setUTCMonth` alone overflows past
 * month-end (e.g. Mar 31 minus 1 month naively lands on Mar 3, not Feb 28,
 * because Feb 31 doesn't exist and JS rolls the overflow into the next
 * month) — found via a code review, this would have silently undercounted a
 * few days of usage every cycle for any user whose billing date falls on the
 * 29th-31st. Returns the clamped Date, or null for an unrecognized cycle
 * label (caller falls back to summing all-time usage).
 */
function stepBack(d: Date, cycle: BillingCycle): Date {
  const monthsBack = cycle === "Monthly" ? 1 : cycle === "Quarterly" ? 3 : 12; // "Yearly"
  const targetMonth = d.getUTCMonth() - monthsBack;
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), targetMonth, Math.min(d.getUTCDate(), daysInTargetMonth)));
}

function isBillingCycle(v: string): v is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(v);
}

/**
 * Sum of `estimated_cost` for `userId` since `since` (or all-time if null).
 * Tries a single Postgres-side aggregate first (`.sum()`) — cheaper than
 * fetching every row, since an active user's row count over a billing
 * period can be sizeable (one row per image/edit/video/planning call). But
 * PostgREST's aggregate functions are disabled by default on a fresh
 * Supabase project (an explicit opt-in setting) — if that's the case here,
 * the aggregate query errors and this falls back to fetching just
 * `estimated_cost` and summing in JS, so the usage cap still actually works
 * rather than silently no-op'ing for every user (found in review: the
 * aggregate-only version failed open with zero visible indication).
 * Returns null only if BOTH paths fail (network/config issue) — the caller
 * treats that as "can't determine spend," never as "spend is zero."
 */
async function sumUsageSince(
  admin: SupabaseClient,
  userId: string,
  since: string | null,
): Promise<number | null> {
  let aggQuery = admin.from("ai_usage_logs").select("total:estimated_cost.sum()").eq("user_id", userId);
  if (since) aggQuery = aggQuery.gte("created_at", since);
  const { data: aggData, error: aggError } = await aggQuery.single<{ total: number | null }>();
  if (!aggError && aggData) return Number(aggData.total ?? 0);

  let rowsQuery = admin.from("ai_usage_logs").select("estimated_cost").eq("user_id", userId);
  if (since) rowsQuery = rowsQuery.gte("created_at", since);
  const { data: rows, error: rowsError } = await rowsQuery;
  if (rowsError || !rows) return null;
  return (rows as { estimated_cost: number | null }[]).reduce(
    (sum, row) => sum + Number(row.estimated_cost ?? 0),
    0,
  );
}

/**
 * Admin-set spend cap check (console's "Usage limit ($)" field on
 * `profiles.usage_limit_usd`) — called from `assertAllowed` when a route
 * passes `checkUsage: true`. This is a CHECK-AFTER design: it sums cost
 * already logged in `ai_usage_logs` from past calls in the current billing
 * period, not an estimate of the call about to happen, so a user can still
 * slip slightly over their cap on the call that crosses it. Confirmed
 * acceptable by the product owner — simpler, and reuses exactly what
 * ai_usage_logs already logs (src/lib/ai/usage-log.ts, a parallel
 * workstream).
 *
 * Takes the CurrentUser `assertAllowed` already fetched (it carries
 * usage_limit_usd/billing_cycle/next_billing_date) instead of re-querying
 * `profiles` a second time — this runs on every single paid generation call.
 *
 * Returns null (proceed) when: Supabase isn't configured, the user has no
 * usage_limit_usd set (unlimited), or the cost-sum read fails — this must
 * never be the thing that blocks generation when the database hiccups.
 * Returns a ready-to-return 429 Response once total spend for the period
 * reaches the limit.
 */
async function checkUsageLimit(user: CurrentUser): Promise<Response | null> {
  if (user.usageLimitUsd === null) return null; // unlimited

  const admin = supabaseAdmin();
  if (!admin) return null;

  // Current period's start = next_billing_date (the period's END) minus one
  // interval of billing_cycle. If either field is missing, or billing_cycle
  // isn't one of the three recognized labels, there's no well-defined period
  // — fall back to summing ALL of this user's usage ever, a reasonable
  // (if more conservative) default rather than erroring or skipping the check.
  //
  // Deliberately NO upper bound on the query (no `.lte(created_at, periodEnd)`)
  // — this asks "how much has the user spent since the period started, up to
  // right now," not "up to the period's nominal end." Nothing in this app
  // automatically advances `next_billing_date` each cycle (an admin sets it
  // manually in the console); a query bounded by that date would silently
  // stop counting ANY new usage the moment the stored date lapses (found in
  // review), disabling the cap entirely until an admin happens to update it.
  let periodStart: string | null = null;
  if (user.billingCycle && isBillingCycle(user.billingCycle) && user.nextBillingDate) {
    periodStart = stepBack(new Date(user.nextBillingDate), user.billingCycle).toISOString();
  }

  const spent = await sumUsageSince(admin, user.id, periodStart);
  if (spent === null) return null;
  if (spent >= Number(user.usageLimitUsd)) {
    return Response.json(
      { error: "Usage limit reached, please contact Vastos Admin" },
      { status: 429 },
    );
  }

  return null;
}
