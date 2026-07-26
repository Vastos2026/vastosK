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

const PUBLIC_PREFIXES = ["/login"];

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
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }
  if (isAuthed && pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico)$).*)"],
};
