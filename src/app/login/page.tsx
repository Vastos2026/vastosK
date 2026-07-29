import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

/**
 * Real (non-optimistic) redirect-away-if-already-logged-in check, deliberately
 * NOT delegated to the proxy's optimistic JWT-only check — a session can pass
 * that check (valid JWT) while `getCurrentUser` still returns null (e.g. no
 * matching `profiles` row), and the proxy redirecting off /login in that case
 * would bounce straight back here, looping forever. Using the same real check
 * everywhere means there's only one source of truth for "is this user in".
 */
export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        {/* A green gradient chip (the old text-"V" treatment) would swallow
            the logo's own green arrow mark — a plain white chip keeps the
            whole mark (black V + green arrow/house) legible instead. */}
        <div className="relative size-14 rounded-2xl bg-white shadow-lg">
          <Image src="/vastos-logo.png" alt="Vastos" fill className="object-contain p-2.5" priority />
        </div>
        <h1 className="text-2xl font-semibold text-foreground">Vastos</h1>
        <p className="max-w-xs text-sm text-muted">
          Turn a floor plan into photorealistic interiors your clients can see.
        </p>
      </div>

      <LoginForm />

      <p className="max-w-xs text-center text-xs text-faint">
        Accounts are created by your Vastos team. Contact your admin if you don&apos;t have one.
      </p>
    </div>
  );
}
