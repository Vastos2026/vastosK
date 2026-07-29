"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import type { UserRole } from "@/lib/auth/session";

// Auth screens (login) and the public shared-walkthrough page render
// full-bleed, no sidebar chrome. /s/[token] specifically must never show the
// authenticated Sidebar (sign-out button, Console link, etc.) — it's opened
// by people who were never given a Vastos login at all.
const NO_SHELL_PREFIXES = ["/login", "/s"];

export function AppShell({
  children,
  role,
}: {
  children: React.ReactNode;
  /** Passed down from the root layout (a Server Component) so this client
   *  component doesn't need its own auth check just to gate the Console nav
   *  link — see src/app/layout.tsx. */
  role: UserRole | null;
}) {
  const pathname = usePathname();
  if (NO_SHELL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar role={role} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
