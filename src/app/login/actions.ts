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

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Logged server-side only (terminal running `npm run dev`), never sent to
    // the browser — the generic message below is deliberate (don't let a
    // login form reveal *why* it failed), but that means the real reason has
    // to be visible somewhere for debugging.
    console.error("[login] signInWithPassword failed:", error.status, error.message);
    return { error: "Incorrect username or password." };
  }

  redirect(next.startsWith("/") ? next : "/");
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase?.auth.signOut();
  redirect("/login");
}
