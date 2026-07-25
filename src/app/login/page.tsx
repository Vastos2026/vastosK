"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { signIn, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/";
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent-hover text-accent-foreground shadow-lg">
          <span className="font-mono text-2xl font-bold leading-none">V</span>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">Vastos</h1>
        <p className="max-w-xs text-sm text-muted">
          Turn a floor plan into photorealistic interiors your clients can see.
        </p>
      </div>

      <form action={action} className="flex w-full max-w-sm flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-xs font-medium text-muted">
            Username
          </label>
          <input
            id="email"
            name="email"
            type="text"
            autoComplete="username"
            required
            className="input"
            placeholder="you@company.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-xs font-medium text-muted">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="input"
            placeholder="••••••••"
          />
        </div>

        {state.error && <p className="text-sm text-danger">{state.error}</p>}

        <Button type="submit" size="lg" loading={pending} className="mt-2 w-full">
          Sign in
        </Button>
      </form>

      <p className="max-w-xs text-center text-xs text-faint">
        Accounts are created by your Vastos team. Contact your admin if you don&apos;t have one.
      </p>
    </div>
  );
}
