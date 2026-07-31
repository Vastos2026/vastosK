import { requireRole } from "@/lib/auth/session";
import { ConsoleTabs } from "./console-tabs";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await requireRole("master");

  return (
    <div className="flex h-full flex-col">
      <header className="px-8 py-5">
        <h1 className="text-xl font-semibold tracking-tight">Console</h1>
        <p className="text-sm text-muted">Manage client accounts, billing, and access.</p>
      </header>
      <ConsoleTabs />
      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">{children}</div>
    </div>
  );
}
