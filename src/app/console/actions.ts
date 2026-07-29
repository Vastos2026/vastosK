"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { BILLING_CYCLES } from "@/lib/billing";

/**
 * Every export here is a Server Action, callable independently of the
 * `/console` page that renders it — so each one re-checks `requireRole`
 * itself rather than trusting that only the (already gated) page ever calls
 * it. Mirrors the "never trust frontend state" rule in src/lib/auth/session.ts.
 */
async function requireAdminClient() {
  const caller = await requireRole("master");
  const admin = supabaseAdmin();
  if (!admin) throw new Error("Supabase isn't configured.");
  return { admin, caller };
}

export async function setUserStatus(userId: string, status: "active" | "suspended") {
  const { admin, caller } = await requireAdminClient();
  // Suspending yourself is an unrecoverable lockout if you're the only
  // master account (or simply the one signed in right now): a suspended
  // account fails `getCurrentUser`'s status check immediately, including for
  // the console page that would let you undo it — there is no way back in
  // except a direct SQL update. Blocked outright, same as self-delete below.
  if (userId === caller.id) {
    throw new Error("You can't suspend your own account — ask another master account to do it.");
  }
  const { error } = await admin.from("profiles").update({ status }).eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

/** Pushes trial_ends_at forward `days` days from now. Simple by design — no
 *  recurring-interval math, matches the same "admin sets it directly" spirit
 *  as billing_cycle/next_billing_date. `days` is admin-entered (console UI),
 *  so it's validated here rather than trusted from the client. */
export async function extendTrial(userId: string, days: number) {
  const { admin } = await requireAdminClient();
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("Days must be a positive number.");
  }
  const nextTrialEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin
    .from("profiles")
    .update({ trial_ends_at: nextTrialEnd })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

export async function deleteUserAccount(userId: string) {
  const { admin, caller } = await requireAdminClient();
  if (userId === caller.id) {
    throw new Error("You can't delete your own account from here — ask another master account to do it.");
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

/**
 * Fixes the "Hello, ___" greeting showing an email instead of a name — the
 * only way an account's display_name gets set is either the New user form's
 * `displayName` field, or (if left blank there, or the account was created
 * directly in the Supabase dashboard rather than via this console) it falls
 * back to the account's email (`handle_new_auth_user` trigger,
 * supabase/schema.sql). This lets an admin fix it after the fact without SQL.
 */
export async function updateDisplayName(userId: string, displayName: string) {
  const { admin } = await requireAdminClient();
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error("Display name can't be empty.");
  const { error } = await admin.from("profiles").update({ display_name: trimmed }).eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

export async function updateBilling(
  userId: string,
  billingCycle: string | null,
  nextBillingDate: string | null,
) {
  const { admin } = await requireAdminClient();
  // The console's <select> only ever offers BILLING_CYCLES, but Server
  // Actions are callable independently of the page that renders them (same
  // reasoning as requireRole above) — validate server-side too, rather than
  // trusting the client sent one of the three real values.
  if (billingCycle && !(BILLING_CYCLES as readonly string[]).includes(billingCycle)) {
    throw new Error(`Invalid billing cycle: ${billingCycle}`);
  }
  const { error } = await admin
    .from("profiles")
    .update({
      billing_cycle: billingCycle || null,
      next_billing_date: nextBillingDate || null,
    })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

/**
 * Sets the total USD a user may spend on AI generation within their current
 * billing period; null clears it back to unlimited. Kept separate from
 * updateBilling above — this is a distinct feature (a spend cap) from the
 * billing_cycle/next_billing_date pair, even though checkUsageLimit
 * (src/lib/api-guard.ts) reads both to figure out the current period.
 */
export async function updateUsageLimit(userId: string, limitUsd: number | null) {
  const { admin } = await requireAdminClient();
  if (limitUsd !== null && (!Number.isFinite(limitUsd) || limitUsd < 0)) {
    throw new Error("Usage limit must be a non-negative number.");
  }
  const { error } = await admin
    .from("profiles")
    .update({ usage_limit_usd: limitUsd })
    .eq("id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/console");
}

export interface CreateUserState {
  error?: string;
  success?: string;
}

/** Admin-issued account creation — the only way a client account gets made
 *  (see CLAUDE.md's "Auth" section). `role` flows into user_metadata, read by
 *  the `handle_new_auth_user` trigger (supabase/schema.sql) that auto-creates
 *  the matching `profiles` row. */
export async function createUser(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  await requireRole("master");
  const admin = supabaseAdmin();
  if (!admin) return { error: "Supabase isn't configured." };

  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "user") === "master" ? "master" : "user";

  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      display_name: displayName || null,
      role,
    },
  });

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/console");
  return { success: `Account created for ${email}.` };
}
