"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Icon } from "./ui/icon";
import { signOut } from "@/app/login/actions";

// Styles / Asset Library belonged to the old 3D-placement studio, out of
// scope for the revamp — dropped from the nav (routes still exist, dormant,
// same "deprioritized not removed" treatment as the rest of that studio).
const NAV = [
  { href: "/", label: "Home", icon: "LayoutDashboard" },
  { href: "/projects", label: "Projects", icon: "PanelsTopLeft" },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="glass my-3 ml-3 flex w-16 shrink-0 flex-col items-center gap-1 rounded-3xl py-4 shadow-2xl shadow-black/40">
      <Link
        href="/"
        className="group relative mb-3 grid size-10 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-foreground transition-all duration-200 hover:scale-105 hover:border-white/25 hover:bg-white/[0.08] cursor-pointer"
        aria-label="Vastos home"
        title="Vastos home"
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-2xl opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: "radial-gradient(circle, rgba(31,140,100,0.5), transparent 70%)" }}
        />
        <span className="relative font-mono text-lg font-bold leading-none">V</span>
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1.5">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "group relative grid size-11 place-items-center rounded-2xl transition-all duration-200 cursor-pointer hover:scale-105",
              isActive(item.href)
                ? "bg-white/[0.08] text-foreground"
                : "text-muted hover:bg-white/[0.05] hover:text-foreground",
            )}
          >
            <Icon name={item.icon} className="size-[20px]" />
            <span className="pointer-events-none absolute left-full ml-3 hidden whitespace-nowrap rounded-lg border border-white/10 bg-surface-3/95 px-2.5 py-1.5 text-xs text-foreground shadow-xl backdrop-blur-sm group-hover:block z-50">
              {item.label}
            </span>
            {isActive(item.href) && (
              <span
                aria-hidden
                className="absolute -left-[7px] top-1/2 h-5 w-1 -translate-y-1/2 rounded-full"
                style={{
                  background: "#1f8c64",
                  boxShadow: "0 0 8px 1px rgba(31,140,100,0.7)",
                }}
              />
            )}
          </Link>
        ))}
      </nav>

      <div className="flex flex-col items-center gap-2">
        <Link
          href="/profile"
          aria-label="Profile"
          title="Profile"
          className={cn(
            "grid size-11 place-items-center rounded-2xl transition-all duration-200 cursor-pointer hover:scale-105",
            isActive("/profile")
              ? "bg-white/[0.08] text-foreground"
              : "text-muted hover:bg-white/[0.05] hover:text-foreground",
          )}
        >
          <Icon name="UserRound" className="size-[20px]" />
        </Link>
        <form action={signOut}>
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.03] text-muted transition-all duration-200 hover:scale-105 hover:border-danger/40 hover:text-danger cursor-pointer"
          >
            <Icon name="LogOut" className="size-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
