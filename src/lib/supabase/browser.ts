/**
 * Browser-side Supabase client using the PUBLISHABLE key (safe to expose).
 *
 * Used only for Realtime subscriptions (live project sync). Returns null when
 * Supabase isn't configured so callers degrade gracefully. Never use the
 * service-role key here — that's server-only (see server.ts).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

let _client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient | null {
  if (!url || !publishableKey) return null;
  if (_client) return _client;
  _client = createClient(url, publishableKey, {
    auth: { persistSession: false },
  });
  return _client;
}
