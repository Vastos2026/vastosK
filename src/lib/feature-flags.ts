import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * Minimal on/off feature flags (revamp Workstream 7) — a `feature_flags`
 * table read server-side, no rollout percentage/targeting/admin UI by
 * design (see the plan's CTO review). Flip a row directly in the SQL editor.
 * Falls back to `defaultValue` when Supabase isn't configured or the key
 * has no row yet, so the app never hard-depends on this table existing.
 */
export async function isFeatureEnabled(key: string, defaultValue = false): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return defaultValue;
  try {
    const { data } = await db.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
    return data ? data.enabled : defaultValue;
  } catch (e) {
    console.warn(`[feature-flags] read "${key}" failed (using default):`, (e as Error).message);
    return defaultValue;
  }
}
