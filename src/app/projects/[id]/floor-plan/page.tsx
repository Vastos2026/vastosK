"use client";

import { useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { emptyPlan } from "@/lib/pipeline/empty-plan";
import { setPendingUploadFile } from "@/lib/pending-upload";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export default function FloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hands the picked file to pending-upload.ts and moves on — see that
  // file's doc comment for why the File itself, not another click, is what
  // crosses the route change to /upload. An empty FileList means the user
  // cancelled the native dialog; nothing happens and they stay here, with
  // the manual "Continue to upload" button below still available as a
  // fallback path.
  const onFileChosen = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setPendingUploadFile(file);
    router.push(`/projects/${id}/upload`);
  };

  if (!project) return null;

  // Restored the original pre-sketch-tool flow (2026-07-30): straight to
  // Room Confirmation's manual "Add room" form, same as Upload page's own
  // "enter rooms manually" fallback (`goManual` there) — see that page for
  // the identical pattern. The sketch tool (`/projects/[id]/sketch`) is left
  // in place but unlinked, per an explicit product decision to keep it
  // dormant rather than delete it.
  const goManual = () => {
    setFloorPlan(id, emptyPlan());
    setStatus(id, "parsed");
    router.push(`/projects/${id}/review`);
  };

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-lg text-center">
        <h2 className="text-2xl font-bold tracking-tight">Do you have a floor plan?</h2>
        <p className="mt-2 text-sm text-muted">
          A real plan gives the most accurate rooms, dimensions and openings.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-4">
          <button
            onClick={() => {
              // setChoice first so the card's selected state and the
              // fallback button below are already visible the instant the
              // native file dialog is dismissed, cancelled, or backgrounded.
              // The click() call right after is still the SAME synchronous
              // gesture, so the dialog opens directly from this one click.
              setChoice("yes");
              fileInputRef.current?.click();
            }}
            className={cn(
              "hover-lift group flex flex-col items-center gap-3 rounded-2xl border px-6 py-8 transition-colors cursor-pointer",
              choice === "yes" ? "border-accent/60 bg-accent/5" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="grid size-12 place-items-center rounded-xl bg-accent/10 text-accent transition-transform group-hover:scale-110">
              <Icon name="FileUp" className="size-6" />
            </span>
            <span className="font-medium">Yes, upload it</span>
            {/* No size ceiling stated: MAX_UPLOAD_BYTES in
                /api/parse-plan/route.ts enforces 20MB server-side, and this
                page used to claim "up to 25 MB" — a real cap the server would
                then reject, wrong in the direction that misleads. PDF is
                deliberately not listed: it's selectable but /upload's
                runDetection rejects it outright before analysis (PDFs are
                rejected outright — export to PNG/JPG first, per CLAUDE.md),
                so naming it here would promise something that doesn't work. */}
            <span className="text-xs text-faint">Supports PNG, JPEG</span>
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
          <Button className="mt-6" icon="ListPlus" onClick={goManual}>
            Enter rooms manually
          </Button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          className="hidden"
          onChange={(e) => onFileChosen(e.target.files)}
        />
      </div>
    </div>
  );
}
