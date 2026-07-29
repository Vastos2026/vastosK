import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server-client";

export type UserRole = "user" | "master";
export type UserStatus = "active" | "trial_ended" | "suspended" | "pending_approval";

export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  trialEndsAt: string | null;
  /** Admin-set label, e.g. "Monthly" — see supabase/schema.sql's profiles.billing_cycle. */
  billingCycle: string | null;
  /** Admin-set date the current subscription period ends. */
  nextBillingDate: string | null;
  /** Admin-set spend cap in USD for the current billing period; null = unlimited. See src/lib/api-guard.ts's checkUsageLimit. */
  usageLimitUsd: number | null;
}

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role, status, trial_ends_at, billing_cycle, next_billing_date, usage_limit_usd")
    .eq("id", userId)
    .single();
  if (!profile) return null;

  // A suspended/pending/trial-ended account keeps a perfectly valid Supabase
  // session (auth and app-level status are separate concerns) — without this
  // check, the console's Suspend button only ever flipped a cosmetic DB flag
  // that nothing enforced (found in a 2026-07-27 code review). `signIn`
  // (login/actions.ts) also checks this right after authenticating, so a
  // blocked user gets a clear message instead of silently bouncing here.
  if (profile.status !== "active") return null;

  return {
    id: userId,
    email: typeof data.claims.email === "string" ? data.claims.email : null,
    displayName: profile.display_name,
    role: profile.role,
    status: profile.status,
    trialEndsAt: profile.trial_ends_at,
    billingCycle: profile.billing_cycle ?? null,
    nextBillingDate: profile.next_billing_date ?? null,
    usageLimitUsd: profile.usage_limit_usd ?? null,
  };
}

/** Redirects to /login when there's no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Redirects unauthenticated users to /login, and unauthorized ones to /. */
export async function requireRole(...roles: UserRole[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}
