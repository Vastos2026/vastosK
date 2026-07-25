"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Floor Plan step (revamp Workstream 8.5, flow step 4) — the Yes/No branch
 * that was missing entirely before this pass. Yes goes straight to the
 * existing upload flow. No shows a plain placeholder: the Sketch Tool
 * (Workstream 8.6) is the real answer here, not built yet, and the user was
 * explicit that no interim stopgap (not even a simple form) should be built
 * ahead of it.
 */
export default function FloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);

  if (!project) return null;

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-lg text-center">
        <h2 className="text-2xl font-bold tracking-tight">Do you have a floor plan?</h2>
        <p className="mt-2 text-sm text-muted">
          A real plan gives the most accurate rooms, dimensions and openings.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-4">
          <button
            onClick={() => setChoice("yes")}
            className={cn(
              "hover-lift group flex flex-col items-center gap-3 rounded-2xl border px-6 py-8 transition-colors cursor-pointer",
              choice === "yes" ? "border-accent/60 bg-accent/5" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="grid size-12 place-items-center rounded-xl bg-accent/10 text-accent transition-transform group-hover:scale-110">
              <Icon name="FileUp" className="size-6" />
            </span>
            <span className="font-medium">Yes, I have one</span>
          </button>
          <button
            onClick={() => setChoice("no")}
            className={cn(
              "hover-lift group flex flex-col items-center gap-3 rounded-2xl border px-6 py-8 transition-colors cursor-pointer",
              choice === "no" ? "border-accent/60 bg-accent/5" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="grid size-12 place-items-center rounded-xl bg-surface-2 text-muted transition-transform group-hover:scale-110">
              <Icon name="Pencil" className="size-6" />
            </span>
            <span className="font-medium">No, not yet</span>
          </button>
        </div>

        {choice === "no" && (
          <div className="mt-6 rounded-2xl border border-border bg-surface-2 p-5 text-left">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Icon name="Sparkles" className="size-4 text-accent" />
              Sketch tool coming soon
            </p>
            <p className="mt-1.5 text-sm text-muted">
              A quick sketch tool for laying out rooms without a real plan is on the way. For now,
              upload a floor plan to continue.
            </p>
          </div>
        )}

        {choice === "yes" && (
          <Button
            className="mt-6"
            iconRight="ArrowRight"
            onClick={() => router.push(`/projects/${id}/upload`)}
          >
            Continue to upload
          </Button>
        )}
      </div>
    </div>
  );
}
