"use client";

import { useState } from "react";
import { WelcomeCarousel } from "./welcome-carousel";
import { NewProjectModal } from "./new-project-modal";
import { Icon } from "./ui/icon";
import type { PropertyType } from "@/lib/types";

const CATEGORIES: { type: PropertyType; label: string; icon: string }[] = [
  { type: "villa", label: "Individual home", icon: "Home" },
  { type: "apartment", label: "Apartment", icon: "Building2" },
  { type: "office", label: "Commercial office", icon: "Briefcase" },
  { type: "commercial", label: "Custom", icon: "Store" },
];

export function WelcomeScreen({ displayName }: { displayName: string | null }) {
  const [pickedType, setPickedType] = useState<PropertyType | null>(null);

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6">
      <WelcomeCarousel />

      <div className="relative z-10 flex flex-col items-center text-center">
        <p className="text-sm font-medium text-muted">
          {displayName ? `Hello, ${displayName}` : "Hello"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Welcome to Vastos
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted">What are you working on today?</p>

        <div className="mt-9 grid grid-cols-2 gap-3 sm:gap-4">
          {CATEGORIES.map((c) => (
            <button
              key={c.label}
              onClick={() => setPickedType(c.type)}
              className="group flex w-40 flex-col items-center gap-3 rounded-2xl border border-border-strong bg-surface/80 px-5 py-6 backdrop-blur-sm transition-colors hover:border-accent/50 hover:bg-surface-2 cursor-pointer sm:w-44"
            >
              <span className="grid size-11 place-items-center rounded-xl bg-accent/10 text-accent transition-colors group-hover:bg-accent/20">
                <Icon name={c.icon} className="size-5" />
              </span>
              <span className="text-sm font-medium text-foreground">{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      <NewProjectModal
        key={pickedType ?? "closed"}
        open={pickedType !== null}
        onClose={() => setPickedType(null)}
        initialType={pickedType ?? "apartment"}
      />
    </div>
  );
}
