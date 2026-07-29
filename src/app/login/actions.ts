"use server";

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server-client";

export interface LoginState {
  error?: string;
}

/**
 * Admin-issued credentials only — there is no signup action. A client's
 * username/password come from the admin console (Workstream 9), backed by
 * `supabase.auth.admin.createUser`.
 */
export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) {
    return { error: "Enter your username and password." };
  }

  const supabase = await supabaseServer();
  if (!supabase) {
    return { error: "Sign-in isn't configured yet. Contact your Vastos admin." };
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Logged server-side only (terminal running `npm run dev`), never sent to
    // the browser — the generic message below is deliberate (don't let a
    // login form reveal *why* it failed), but that means the real reason has
    // to be visible somewhere for debugging.
    console.error("[login] signInWithPassword failed:", error.status, error.message);
    return { error: "Incorrect username or password." };
  }

  // The credentials are valid, but the account might still be blocked at the
  // app level (console's Suspend/pending-approval/trial-ended states) — auth
  // and app status are separate concerns in Supabase, so a suspended user
  // still gets a perfectly valid session here. Checking it now, right after
  // sign-in, gives a clear reason instead of the generic-looking "keeps
  // landing back on /login" bounce that `getCurrentUser`'s own status check
  // (src/lib/auth/session.ts) would otherwise produce with no explanation.
  const { data: profile } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", data.user.id)
    .single();
  if (profile && profile.status !== "active") {
    await supabase.auth.signOut();
    const messages: Record<string, string> = {
      suspended: "Your account has been suspended. Contact your Vastos admin.",
      pending_approval: "Your account is pending approval. Contact your Vastos admin.",
      trial_ended: "Your trial has ended. Contact your Vastos admin.",
    };
    return { error: messages[profile.status] ?? "Your account can't sign in right now. Contact your Vastos admin." };
  }

  redirect(next.startsWith("/") ? next : "/");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase?.auth.signOut();
  redirect("/login");
}
