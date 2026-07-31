import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser, BLOCK_MESSAGES } from "@/lib/auth/session";
import { LoginForm } from "./login-form";
import { Icon } from "@/components/ui/icon";

/**
 * Real (non-optimistic) redirect-away-if-already-logged-in check, deliberately
 * NOT delegated to the proxy's optimistic JWT-only check — a session can pass
 * that check (valid JWT) while `getCurrentUser` still returns null (e.g. no
 * matching `profiles` row), and the proxy redirecting off /login in that case
 * would bounce straight back here, looping forever. Using the same real check
 * everywhere means there's only one source of truth for "is this user in".
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ blocked?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  // Set by requireUser() when an already-open session's account got blocked
  // (suspended, pending approval, or a scheduled stop reached) — a fresh
  // failed-login attempt gets its own message directly from signIn instead,
  // this only covers "was signed in, tried to load a page, got kicked out."
  const { blocked } = await searchParams;
  const blockedMessage = blocked ? BLOCK_MESSAGES[blocked] : null;

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        {/* A green gradient chip (the old text-"V" treatment) would swallow
            the logo's own green arrow mark — a plain white chip keeps the
            whole mark (black V + green arrow/house) legible instead. */}
        <div className="relative size-14 rounded-2xl bg-white shadow-lg">
          <Image src="/vastos-logo.png" alt="Vastos" fill sizes="56px" className="object-contain p-2.5" priority />
        </div>
        <h1 className="text-2xl font-semibold text-foreground">Vastos</h1>
        <p className="max-w-xs text-sm text-muted">
          Turn a floor plan into photorealistic interiors your clients can see.
        </p>
      </div>

      {blockedMessage && (
        <div className="flex max-w-xs items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
          <span>{blockedMessage}</span>
        </div>
      )}

      <LoginForm />

      <p className="max-w-xs text-center text-xs text-faint">
        Accounts are created by your Vastos team. Contact your admin if you don&apos;t have one.
      </p>
    </div>
  );
}
