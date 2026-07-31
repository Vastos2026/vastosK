import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server-client";
import type { UserRole, UserStatus } from "./types";

export type { UserRole, UserStatus } from "./types";

export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  /** Admin-set label, e.g. "Monthly" — see supabase/schema.sql's profiles.billing_cycle. */
  billingCycle: string | null;
  /**
   * The billing ANCHOR date (not necessarily the currently-active one) — see
   * src/lib/billing.ts's `computeCurrentBillingDate`, which every reader
   * (profile page, console, checkUsageLimit) rolls this forward through
   * before displaying or using it.
   */
  nextBillingDate: string | null;
  /** Admin-set spend cap in USD for the current billing period; null = unlimited. See src/lib/api-guard.ts's checkUsageLimit. */
  usageLimitUsd: number | null;
  /** Admin-set future date this account stops working entirely; null = no scheduled stop. See getBlockReason below. */
  scheduledStopAt: string | null;
}

/** True once `scheduledStopAt` has actually arrived — the account is blocked from this moment on, checked on every request. */
function scheduledStopReached(scheduledStopAt: string | null): boolean {
  return !!scheduledStopAt && new Date(scheduledStopAt).getTime() <= Date.now();
}

/**
 * User-facing copy for every reason a login/session can be blocked at the app
 * level — shared by `signIn` (login/actions.ts, the fresh-login case) and the
 * login page (rendering `requireUser`'s `?blocked=` redirect for an
 * already-blocked existing session), so the wording can't drift between the
 * two call sites.
 */
export const BLOCK_MESSAGES: Record<string, string> = {
  suspended: "Your account has been suspended. Contact your Vastos admin.",
  pending_approval: "Your account is pending approval. Contact your Vastos admin.",
  stopped: "Your account has been stopped. Please contact Vastos admin.",
};

/**
 * The real (non-optimistic) session check — verifies the JWT and loads the
 * matching `profiles` row. Use this in Server Components, Route Handlers, and
 * Server Actions; the proxy's check is optimistic only (see src/proxy.ts) and
 * is not sufficient authorization on its own, per Next's own auth guidance.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, role, status, billing_cycle, next_billing_date, usage_limit_usd, scheduled_stop_at")
    .eq("id", userId)
    .single();
  if (profileError) {
    // A failure here (e.g. schema drift between supabase/schema.sql and the
    // live DB) silently looked like "login doesn't work" with no clue why,
    // since a null profile and a query error both fell through to the same
    // `return null` → redirect-to-/login. Logging it server-side makes that
    // failure mode diagnosable instead of a mystery bounce loop.
    console.error("[auth] profiles select failed:", profileError.code, profileError.message);
  }
  if (!profile) return null;

  // A suspended/pending account (or one whose scheduled-stop date has now
  // arrived) keeps a perfectly valid Supabase session (auth and app-level
  // status are separate concerns) — without this check, the console's
  // Suspend button only ever flipped a cosmetic DB flag that nothing
  // enforced (found in a 2026-07-27 code review). `signIn` (login/actions.ts)
  // also checks this right after authenticating, so a blocked user gets a
  // clear message instead of silently bouncing here. Checked on every
  // request (not a cron job) — a scheduled stop takes effect on this
  // account's very next request once its date passes, whether or not
  // there's already an open session.
  if (profile.status !== "active" || scheduledStopReached(profile.scheduled_stop_at)) return null;

  return {
    id: userId,
    email: typeof data.claims.email === "string" ? data.claims.email : null,
    displayName: profile.display_name,
    role: profile.role,
    status: profile.status,
    billingCycle: profile.billing_cycle ?? null,
    nextBillingDate: profile.next_billing_date ?? null,
    usageLimitUsd: profile.usage_limit_usd ?? null,
    scheduledStopAt: profile.scheduled_stop_at ?? null,
  };
}

/**
 * Same status/scheduled-stop check `getCurrentUser` uses to decide whether to
 * return null, but exposed as a reason string instead — used only by
 * `requireUser` below, to pass a specific message to the login page for a
 * user who already had a session but got blocked (as opposed to `signIn`'s
 * own check, which covers the fresh-login case). A second query rather than
 * reworking `getCurrentUser`'s return shape, since most callers only need the
 * plain allow/deny answer.
 */
async function getBlockReason(): Promise<"suspended" | "pending_approval" | "stopped" | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("status, scheduled_stop_at")
    .eq("id", userId)
    .single();
  if (!profile) return null;
  if (scheduledStopReached(profile.scheduled_stop_at)) return "stopped";
  if (profile.status === "suspended" || profile.status === "pending_approval") return profile.status;
  return null;
}

/** Redirects to /login when there's no valid session — with a `?blocked=` reason when one applies, so the login page can show why. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const reason = await getBlockReason();
    redirect(reason ? `/login?blocked=${reason}` : "/login");
  }
  return user;
}

/** Redirects unauthenticated users to /login, and unauthorized ones to /. */
export async function requireRole(...roles: UserRole[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}
