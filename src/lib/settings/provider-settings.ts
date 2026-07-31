import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { runwareConfigured } from "@/lib/render/runware-client";
import type { ProviderCapability, ProviderChoice } from "./provider-types";

export type { ProviderCapability, ProviderChoice } from "./provider-types";

const COLUMN: Record<ProviderCapability, "image_gen_primary" | "image_edit_primary"> = {
  image_gen: "image_gen_primary",
  image_edit: "image_edit_primary",
};

/** The pre-database default: Runware whenever it's actually configured, else Gemini. */
function envDefault(): ProviderChoice {
  return runwareConfigured() ? "runware" : "gemini";
}

/**
 * Admin-configurable primary provider for image generation/editing (console's
 * Analytics page). Falls back to `envDefault()` when Supabase isn't
 * configured, the `provider_settings` row doesn't exist yet, or the query
 * errors — a DB hiccup must never break a generation call, matching this
 * app's degrade-gracefully contract elsewhere (feature-flags.ts, same
 * pattern). Video is intentionally not covered here — it stays governed by
 * the VIDEO_PROVIDER env var, see provider.ts.
 */
export async function getProviderPrimary(capability: ProviderCapability): Promise<ProviderChoice> {
  const db = supabaseAdmin();
  if (!db) return envDefault();
  try {
    const { data } = await db
      .from("provider_settings")
      .select("image_gen_primary, image_edit_primary")
      .eq("id", "default")
      .maybeSingle();
    const value = data?.[COLUMN[capability]] as string | undefined;
    return value === "gemini" || value === "runware" ? value : envDefault();
  } catch (e) {
    console.warn(`[provider-settings] read "${capability}" failed (using default):`, (e as Error).message);
    return envDefault();
  }
}

/** Admin write path — see src/app/console/analytics/actions.ts, requireRole("master")-gated. */
export async function setProviderPrimary(
  capability: ProviderCapability,
  value: ProviderChoice,
  updatedBy: string,
): Promise<void> {
  const db = supabaseAdmin();
  if (!db) throw new Error("Supabase is not configured");
  const { error } = await db
    .from("provider_settings")
    .upsert({ id: "default", [COLUMN[capability]]: value, updated_by: updatedBy, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
