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
    .select("display_name, role, status, trial_ends_at")
    .eq("id", userId)
    .single();
  if (!profile) return null;

  return {
    id: userId,
    email: typeof data.claims.email === "string" ? data.claims.email : null,
    displayName: profile.display_name,
    role: profile.role,
    status: profile.status,
    trialEndsAt: profile.trial_ends_at,
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
