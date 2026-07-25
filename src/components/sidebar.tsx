"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Icon } from "./ui/icon";
import { signOut } from "@/app/login/actions";

const NAV = [
  { href: "/", label: "Dashboard", icon: "LayoutDashboard" },
  { href: "/projects", label: "Projects", icon: "PanelsTopLeft" },
  { href: "/styles", label: "Styles", icon: "Palette" },
  { href: "/assets", label: "Asset Library", icon: "Box" },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface/60 py-4">
      <Link
        href="/"
        className="group mb-3 grid size-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-hover text-accent-foreground shadow-lg"
        aria-label="Vasto Studios home"
      >
        <span className="font-mono text-lg font-bold leading-none">V</span>
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "group relative grid size-11 place-items-center rounded-xl transition-colors",
              isActive(item.href)
                ? "bg-surface-3 text-accent"
                : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon name={item.icon} className="size-[20px]" />
            <span className="pointer-events-none absolute left-full ml-3 hidden whitespace-nowrap rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-foreground shadow-lg group-hover:block z-50">
              {item.label}
            </span>
            {isActive(item.href) && (
              <span className="absolute -left-[1px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
            )}
          </Link>
        ))}
      </nav>

      <div className="flex flex-col items-center gap-1">
        <Link
          href="/profile"
          aria-label="Profile"
          title="Profile"
          className={cn(
            "grid size-11 place-items-center rounded-xl transition-colors",
            isActive("/profile")
              ? "bg-surface-3 text-accent"
              : "text-muted hover:bg-surface-2 hover:text-foreground",
          )}
        >
          <Icon name="Settings" className="size-[20px]" />
        </Link>
        <form action={signOut}>
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="grid size-9 place-items-center rounded-full bg-surface-3 text-muted ring-1 ring-border hover:text-foreground cursor-pointer"
          >
            <Icon name="LogOut" className="size-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
