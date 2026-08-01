import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Route guard (Next 16 renamed `middleware.ts` → `proxy.ts`; this now runs on
 * the Node.js runtime by default, no Edge-runtime constraints).
 *
 * This is an OPTIMISTIC check only — it reads the session cookie's JWT and
 * decides whether to redirect, but doesn't touch the database. Real
 * authorization (role checks, profile status) happens in `getCurrentUser`/
 * `requireRole` (src/lib/auth/session.ts), called from every protected page
 * and API route. Never rely on this file alone — see Next's own auth guide.
 */

// /s/[token] (the shared-walkthrough page) and /api/s/[token]/asset (the
// bytes it renders) are deliberately public — see those routes' own
// comments. Without listing both here, this optimistic check would redirect
// an unauthenticated visitor to /login before either one ever ran, which is
// exactly the audience "Get shareable link" is meant to reach.
//
// /spike and /api/spike are the Phase 0 greybox proof spike (throwaway — see
// docs/superpowers/plans/2026-08-01-greybox-opening-placement-phase0-spike.md),
// which bypasses assertAllowed entirely and so must never be reachable in a
// deployment. Gated on an explicit SPIKE_ENABLED flag rather than NODE_ENV:
// `process.env.NODE_ENV === "production"` is TRUE inside this file even under
// `next dev` (verified 2026-08-01 — /s/foo returned 200 while /spike/greybox
// still 307'd), so NODE_ENV is not a usable dev signal here. SPIKE_ENABLED
// lives only in .env.local, which is gitignored and never deployed.
// Note "/api/spike-greybox", not "/api/spike": the match below requires an
// exact hit or a "/" boundary, so "/api/spike" would NOT cover
// "/api/spike-greybox/save".
const SPIKE_ENABLED = process.env.SPIKE_ENABLED === "1";
const PUBLIC_PREFIXES = SPIKE_ENABLED
  ? ["/login", "/s", "/api/s", "/spike", "/api/spike-greybox"]
  : ["/login", "/s", "/api/s"];

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  // Supabase not configured (local dev without it set up) — don't lock the
  // app out, same graceful-degradation pattern used everywhere else.
  if (!url || !publishableKey) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isAuthed = !!data?.claims;

  if (!isAuthed && !isPublic) {
    // A Server Action POST (console/actions.ts, analytics/actions.ts) that
    // arrives here after its session already expired must NOT get a plain
    // redirect: Next's client-side action handler only accepts an RSC/action
    // response or a `next-action`-aware redirect signal, and silently
    // rejects anything else with an opaque "An unexpected response was
    // received from the server." (see server-action-reducer.js's isRscResponse
    // check) — the browser never even shows *why* it failed. A 401 with a
    // `text/plain` body is the one non-RSC shape that handler special-cases:
    // it reads the body text and surfaces it as the actual thrown error.
    if (request.headers.has("next-action")) {
      return new NextResponse("Your session has expired. Please sign in again.", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirecting an already-authed session away from /login is deliberately
  // NOT done here: this check is JWT-only (no profile lookup), so it can
  // disagree with the real check in `getCurrentUser` (e.g. valid session, no
  // matching `profiles` row) — bouncing on that disagreement would loop
  // forever between "/" and "/login". The login page itself does this
  // redirect using the same real check every protected route relies on.

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico)$).*)"],
};
