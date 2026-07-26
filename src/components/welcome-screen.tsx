"use client";

import { useState } from "react";
import { WelcomeCarousel } from "./welcome-carousel";
import { NewProjectModal } from "./new-project-modal";
import { Icon } from "./ui/icon";
import type { PropertyType } from "@/lib/types";

const CATEGORIES: { type: PropertyType; label: string; icon: string }[] = [
  { type: "villa", label: "Residential Home", icon: "Home" },
  { type: "apartment", label: "Apartment", icon: "Building2" },
  { type: "office", label: "Commercial", icon: "Briefcase" },
  // "Custom" covers every business type that isn't an office — clinic,
  // restaurant, retail, temple, etc. (see config/project-types/custom.json)
  { type: "commercial", label: "Custom", icon: "Store" },
];

export function WelcomeScreen({ displayName }: { displayName: string | null }) {
  const [pickedType, setPickedType] = useState<PropertyType | null>(null);

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6">
      <WelcomeCarousel />

      <div className="relative z-10 flex flex-col items-center text-center">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          {displayName ? `Hello, ${displayName}` : "Hello"}
        </h1>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground/90 sm:text-3xl">
          Welcome to Vastos
        </p>
        <p className="mt-4 max-w-md text-sm text-muted">What are you working on today?</p>

        <div className="mt-9 grid grid-cols-2 gap-3 sm:gap-4">
          {CATEGORIES.map((c) => (
            <button
              key={c.label}
              onClick={() => setPickedType(c.type)}
              className="glass group relative flex w-40 flex-col items-center gap-3 overflow-hidden rounded-2xl px-5 py-6 transition-all duration-200 hover:-translate-y-1 hover:border-white/25 cursor-pointer sm:w-44"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{ background: "radial-gradient(120px 90px at 50% 0%, rgba(31,140,100,0.18), transparent 70%)" }}
              />
              <span className="relative grid size-11 place-items-center rounded-xl bg-white/[0.06] text-foreground transition-transform duration-200 group-hover:scale-110">
                <Icon name={c.icon} className="size-5" />
              </span>
              <span className="relative text-sm font-medium text-foreground">{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      <NewProjectModal
        key={pickedType ?? "closed"}
        open={pickedType !== null}
        onClose={() => setPickedType(null)}
        initialType={pickedType ?? "apartment"}
        lockType
      />
    </div>
  );
}
