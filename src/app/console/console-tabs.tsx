"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/console", label: "Users" },
  { href: "/console/analytics", label: "Analytics" },
];

export function ConsoleTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b border-white/5 px-8">
      {TABS.map((tab) => {
        const active = tab.href === "/console" ? pathname === "/console" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "relative px-3 py-3 text-sm transition-colors cursor-pointer",
              active ? "text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            {tab.label}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-px h-px"
                style={{ background: "#1f8c64", boxShadow: "0 0 8px 1px rgba(31,140,100,0.5)" }}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
