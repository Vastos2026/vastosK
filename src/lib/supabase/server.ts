import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the SECRET service-role key.
 *
 * Bypasses Row-Level Security, so it must NEVER be imported into a client
 * component. Returns `null` when Supabase isn't configured, letting callers
 * degrade gracefully (the app stays fully functional without a database).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim();

export const supabaseConfigured = !!(url && serviceKey);

let _client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (_client) return _client;
  _client = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
