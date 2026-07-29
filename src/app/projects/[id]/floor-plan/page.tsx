"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export default function FloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);

  if (!project) return null;

  const goSketch = () => router.push(`/projects/${id}/sketch`);

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
          <Button className="mt-6" iconRight="ArrowRight" onClick={goSketch}>
            Sketch your floor plan
          </Button>
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
