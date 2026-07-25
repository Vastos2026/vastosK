"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";

// Auth screens (login) render full-bleed, no sidebar chrome — matches the
// design system's "minimal chrome, one clear action" pre-login look.
const NO_SHELL_PREFIXES = ["/login"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (NO_SHELL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
