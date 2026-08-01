"use client";

import { useCallback, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { parsePlanViaApi } from "@/lib/parse-plan-client";
import { emptyPlan } from "@/lib/pipeline/empty-plan";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Stage = "idle" | "selected" | "detecting";

interface Selected {
  file: File;
  name: string;
  url?: string;
  isImage: boolean;
}

export default function UploadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);

  const [stage, setStage] = useState<Stage>("idle");
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const url = isImage ? URL.createObjectURL(file) : undefined;
    setSelected({ file, name: file.name, url, isImage });
    setError(null);
    setUnreadable(false);
    setConfirmingReset(false);
    setStage("selected");
  }, []);

  const runDetection = useCallback(async () => {
    if (!selected || !project) return;
    setError(null);
    setUnreadable(false);

    if (!selected.isImage) {
      setError("PDFs can't be analyzed yet. Export the plan as a PNG or JPG and re-import.");
      return;
    }

    setStatus(id, "parsing");
    setStage("detecting");
    try {
      const category = categoryForPropertyType(project.propertyType);
      const roomTypeHints = getProjectTypeConfig(category)?.roomTypes ?? [];
      const result = await parsePlanViaApi(selected.file, { roomTypeHints });
      if (!result.readable) {
        setUnreadable(true);
        setStatus(id, "draft");
        setStage("selected");
        return;
      }
      // selected.url is a blob: URL (createObjectURL) — not durable across a
      // reload, but Room Confirmation's reference panel only needs it for
      // the current continuous upload → review hop, so that's fine.
      setFloorPlan(id, selected.url ? { ...result.plan, previewUrl: selected.url } : result.plan);
      setStatus(id, "parsed");
      router.push(`/projects/${id}/plan`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed");
      setStatus(id, "draft");
      setStage("selected");
    }
  }, [selected, project, id, setFloorPlan, setStatus, router]);

  const goManual = useCallback(() => {
    setFloorPlan(id, emptyPlan());
    setStatus(id, "parsed");
    router.push(`/projects/${id}/plan`);
  }, [id, setFloorPlan, setStatus, router]);

  const reset = useCallback(() => {
    setSelected(null);
    setError(null);
    setUnreadable(false);
    setConfirmingReset(false);
    setStage("idle");
  }, []);

  if (!project) return null;

  // ---- DETECTING: single-call extraction in flight ----
  if (stage === "detecting") {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-md">
          <div className="relative mx-auto mb-8 aspect-[16/10] w-full overflow-hidden rounded-2xl border border-border bg-grid bg-bg">
            {selected?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selected.url}
                alt=""
                className="absolute inset-0 h-full w-full object-contain opacity-60"
              />
            )}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute inset-x-0 h-1/3 animate-[vasto-sweep_1.8s_ease-in-out_infinite] bg-gradient-to-b from-transparent via-accent/25 to-transparent" />
            </div>
            <div className="absolute inset-0 ring-1 ring-inset ring-accent/30" />
          </div>
          <p className="flex items-center justify-center gap-2 text-sm font-medium">
            <Icon name="ScanLine" className="size-4 text-accent" />
            Reading your floor plan…
          </p>
          <p className="mt-2 text-center text-xs text-faint">
            Finding rooms, dimensions, doors and windows.
          </p>
        </div>
      </div>
    );
  }

  // ---- SELECTED: preview + Analyze button (also the low-confidence retry state) ----
  if (stage === "selected" && selected) {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-xl">
          <div className="hover-lift rounded-2xl border border-border bg-surface p-4 transition-colors">
            <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border bg-grid bg-bg">
              {selected.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.url}
                  alt={selected.name}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center">
                  <div className="text-center">
                    <Icon name="FileUp" className="mx-auto size-10 text-faint" />
                    <p className="mt-2 text-sm text-muted">PDF document</p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center gap-2 text-sm">
              <Icon name="Image" className="size-4 text-accent" />
              <span className="truncate font-medium">{selected.name}</span>
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-3 text-xs text-danger">
                <p className="flex items-start gap-2">
                  <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </p>
                <Button size="sm" variant="outline" className="mt-2.5" icon="ListPlus" onClick={goManual}>
                  Switch to manual entry
                </Button>
              </div>
            )}

            {unreadable && (
              <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-3 text-sm text-warning">
                <p className="flex items-center gap-2 font-medium">
                  <Icon name="CircleAlert" className="size-4 shrink-0" />
                  This plan couldn&apos;t be read automatically.
                </p>
                <p className="mt-1 text-xs">
                  Try a clearer image, or switch to manual entry and add your rooms yourself.
                </p>
                <Button size="sm" variant="outline" className="mt-2.5" icon="ListPlus" onClick={goManual}>
                  Switch to manual entry
                </Button>
              </div>
            )}

            {!selected.isImage && (
              <p className="mt-2 text-xs text-warning">
                PDFs can&apos;t be analyzed automatically. Export the plan as a PNG or JPG.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              {confirmingReset ? (
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                  <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                  <span className="flex-1">This will discard the current analysis.</span>
                  <button
                    onClick={reset}
                    className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
                  >
                    Discard
                  </button>
                  <button
                    onClick={() => setConfirmingReset(false)}
                    className="cursor-pointer text-faint hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <Button variant="ghost" icon="ArrowLeft" onClick={() => setConfirmingReset(true)}>
                  Choose another
                </Button>
              )}
              <Button icon="ScanLine" onClick={runDetection}>
                Analyze floor plan
              </Button>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            Reads rooms, dimensions, doors and windows automatically. Everything is
            reviewable and editable on the next screen.
          </p>
        </div>
      </div>
    );
  }

  // ---- IDLE: dropzone ----
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-2xl">
        <div className="mb-7 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Upload your floor plan</h2>
          <p className="mt-2 text-muted">Vastos reads rooms, dimensions and openings automatically.</p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "group cursor-pointer rounded-3xl border-2 border-dashed bg-surface/40 px-6 py-20 text-center transition-all duration-200",
            drag
              ? "scale-[1.01] border-accent bg-accent/5"
              : "border-border hover:border-border-strong hover:bg-surface/60",
          )}
        >
          <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent/10 text-accent transition-transform duration-200 group-hover:scale-110">
            <Icon name="Upload" className="size-8" />
          </div>
          <p className="mt-4 text-lg font-medium">
            Drag & drop, or <span className="text-accent">browse</span>
          </p>
          <p className="mt-1 text-sm text-muted">Supports JPG, PNG and PDF · up to 25 MB</p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
    </div>
  );
}
