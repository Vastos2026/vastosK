/**
 * Browser-side Supabase client using the PUBLISHABLE key (safe to expose).
 *
 * Used only for Realtime subscriptions (live project sync). Returns null when
 * Supabase isn't configured so callers degrade gracefully. Never use the
 * service-role key here — that's server-only (see server.ts).
 *
 * Cookie-aware (`@supabase/ssr`'s `createBrowserClient`), not a bare anon
 * client — mirrors the same session cookie `server-client.ts` reads on the
 * server, so this client's Postgres role carries the signed-in user's JWT
 * and `auth.uid()` resolves for it. That's what lets `project_snapshots`'s
 * SELECT policy be scoped to `anon_owner = auth.uid()::text` instead of
 * `using (true)` — a bare anon client has no session, so `auth.uid()` would
 * be NULL and that scoped policy would deny Realtime entirely. See the RLS
 * comment on that policy in supabase/schema.sql for the vulnerability this
 * closes (any holder of the publishable key could previously SELECT every
 * user's project_snapshots row, not just via this app's own Realtime call).
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

let _client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient | null {
  if (!url || !publishableKey) return null;
  if (_client) return _client;
  _client = createBrowserClient(url, publishableKey);
  return _client;
}
