import { cookies } from "next/headers";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cookie-aware Supabase client for Server Components, Route Handlers, and
 * Server Actions — represents the logged-in user (RLS applies), unlike
 * `supabaseAdmin()` (service-role, bypasses RLS) or `supabaseBrowser()`
 * (anon key, no cookie/session wiring). Must be created fresh per request —
 * `@supabase/ssr` reads/writes the request's own cookies each call.
 *
 * Returns null when Supabase isn't configured, matching the rest of this
 * codebase's graceful-degradation pattern.
 */
export async function supabaseServer(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return null;

  const cookieStore = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (cookiesToSet) => {
      try {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      } catch {
        // Called from a Server Component (no cookie write access) — fine,
        // the proxy already refreshes the session on the way in.
      }
    },
  };

  return createServerClient(url, publishableKey, { cookies: cookieMethods });
}
