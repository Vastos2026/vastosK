import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { runwareConfigured } from "@/lib/render/runware-client";
import { museConfigured } from "@/lib/render/meta-muse-client";
import { PROVIDER_CHOICES, type ProviderCapability, type ProviderChoice } from "./provider-types";

export type { ProviderCapability, ProviderChoice } from "./provider-types";
export { PROVIDER_CHOICES } from "./provider-types";

const COLUMN: Record<ProviderCapability, "image_gen_primary" | "image_edit_primary"> = {
  image_gen: "image_gen_primary",
  image_edit: "image_edit_primary",
};

/**
 * The pre-database default.
 *
 * Capability-aware, because the providers are not interchangeable: Muse leads
 * for GENERATION whenever a Meta key is present, but can never serve editing
 * (no mask parameter — see provider-types.ts), so the edit capability keeps the
 * original Runware-then-Gemini order regardless of what Meta is configured for.
 */
function envDefault(capability: ProviderCapability): ProviderChoice {
  if (capability === "image_gen" && museConfigured()) return "meta";
  return runwareConfigured() ? "runware" : "gemini";
}

/**
 * Admin-configurable primary provider for image generation/editing (console's
 * Analytics page). Falls back to `envDefault()` when Supabase isn't
 * configured, the `provider_settings` row doesn't exist yet, or the query
 * errors — a DB hiccup must never break a generation call, matching this
 * app's degrade-gracefully contract elsewhere (same
 * pattern). Video is intentionally not covered here — it stays governed by
 * the VIDEO_PROVIDER env var, see provider.ts.
 */
export async function getProviderPrimary(capability: ProviderCapability): Promise<ProviderChoice> {
  const db = supabaseAdmin();
  if (!db) return envDefault(capability);
  try {
    const { data } = await db
      .from("provider_settings")
      .select("image_gen_primary, image_edit_primary")
      .eq("id", "default")
      .maybeSingle();
    const value = data?.[COLUMN[capability]] as string | undefined;
    // Validated against the per-capability list, not just the union: the
    // column is a plain text field, so a stored "meta" on image_edit is
    // reachable (an older row, a hand-edited row, a future console bug) and
    // would otherwise route the lasso edit to a model with no mask support.
    const allowed = PROVIDER_CHOICES[capability] as readonly string[];
    return value && allowed.includes(value) ? (value as ProviderChoice) : envDefault(capability);
  } catch (e) {
    console.warn(`[provider-settings] read "${capability}" failed (using default):`, (e as Error).message);
    return envDefault(capability);
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
  // Enforced on the way in as well as on the way out. The read path already
  // rejects an invalid pairing, but letting one be STORED means the console
  // would display a setting that silently never takes effect.
  if (!(PROVIDER_CHOICES[capability] as readonly string[]).includes(value)) {
    throw new Error(`"${value}" is not a valid provider for ${capability}`);
  }
  const { error } = await db
    .from("provider_settings")
    .upsert({ id: "default", [COLUMN[capability]]: value, updated_by: updatedBy, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
