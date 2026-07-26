"use client";

import { useCallback, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { parsePlanViaApi, type DetectProgress } from "@/lib/parse-plan-client";
import type { DetectedGeometry, Room } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DetectionOverlay,
  type LayerToggles,
} from "@/components/project/detection-overlay";
import { cn } from "@/lib/utils";

type Stage = "idle" | "selected" | "detecting" | "done";

interface Selected {
  file: File;
  name: string;
  /** raster preview URL — present for images, absent for PDFs */
  url?: string;
  isImage: boolean;
}

export default function UploadPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);

  const [stage, setStage] = useState<Stage>("idle");
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [progress, setProgress] = useState<DetectProgress | null>(null);
  const [geometry, setGeometry] = useState<DetectedGeometry | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [calibrated, setCalibrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Import another" discards the current analysis — a small inline confirm
  // step (not a full modal) so an accidental click doesn't silently lose it.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [layers, setLayers] = useState<LayerToggles>({
    walls: true,
    doors: true,
    windows: true,
    rooms: true,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const url = isImage ? URL.createObjectURL(file) : undefined;
    setSelected({ file, name: file.name, url, isImage });
    setGeometry(null);
    setError(null);
    setStage("selected");
  }, []);

  /** Run server-side detection (OpenCV, or the labeled EasyOCR detector) on the selected image. */
  const runDetection = useCallback(async () => {
    if (!selected) return;
    setError(null);

    // PDFs aren't raster — detection needs an image. Ask for a real raster
    // instead of fabricating a plan that wouldn't match the uploaded document.
    if (!selected.isImage) {
      setError(
        "PDFs can't be analyzed yet — export the plan as a PNG or JPG and re-import for real detection.",
      );
      return;
    }

    setStatus(id, "parsing");
    setStage("detecting");
    try {
      const result = await parsePlanViaApi(
        selected.file,
        { projectId: id },
        (p) => setProgress(p),
      );
      setGeometry(result.geometry);
      setConfidence(result.confidence);
      setCalibrated(result.calibrated);
      // Detected rooms land straight on the plan — reviewed, renamed and
      // corrected on the next screen (Room Confirmation), not confirmed here.
      setFloorPlan(id, result.plan);
      setStatus(id, "parsed");
      setStage("done");
    } catch (e) {
      // No fabricated fallback — surface the real error and let the user retry
      // with a clearer plan. The project keeps whatever state it had.
      setError(e instanceof Error ? e.message : "Detection failed");
      setStatus(id, "draft");
      setProgress(null);
      setStage("selected");
    }
  }, [selected, id, setFloorPlan, setStatus]);

  const reset = useCallback(() => {
    setSelected(null);
    setGeometry(null);
    setProgress(null);
    setError(null);
    setCalibrated(false);
    setConfirmingReset(false);
    setStage("idle");
  }, []);

  if (!project) return null;

  const plan = project.floorPlan;

  // ---- DONE: detection result over the real image ----
  if (stage === "done" && plan) {
    const isDetected = plan.meta?.source === "opencv" || plan.meta?.source === "merged";
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-10">
          <div className="animate-fade-up mb-7 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-success/12 text-success ring-1 ring-success/20">
                <Icon name="CircleCheck" className="size-6" />
              </span>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Floor plan analyzed</h2>
                <p className="mt-0.5 text-sm text-muted">
                  {`${plan.walls?.length ?? 0} walls · ${plan.rooms.length} rooms · ${plan.doors.length} doors · ${plan.windows?.length ?? 0} windows`}
                </p>
              </div>
            </div>
            {isDetected && <ConfidenceBadge value={confidence} />}
          </div>

          {isDetected && !calibrated && (
            <div className="animate-fade-up mb-6 flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning/5 px-4 py-3.5 text-sm text-warning">
              <Icon name="Ruler" className="mt-0.5 size-4 shrink-0" />
              <span>
                Dimensions are <strong>estimated</strong> — no real measurement was
                given, so scale is approximate. Adjust room sizes in Room Confirmation, or
                re-import with the longest dimension filled in for exact scale.
              </span>
            </div>
          )}

          <div className="animate-fade-up hover-lift overflow-hidden rounded-3xl border border-border bg-surface transition-colors">
            <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
              <span className="text-sm font-semibold">Detected geometry</span>
              {geometry && <LayerLegend layers={layers} onChange={setLayers} />}
            </div>
            <div className="relative aspect-[16/10] w-full overflow-hidden bg-grid bg-bg">
              {selected?.url && geometry ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selected.url}
                    alt="Uploaded floor plan"
                    className="absolute inset-0 h-full w-full object-contain opacity-85"
                  />
                  <DetectionOverlay geometry={geometry} layers={layers} />
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-sm text-faint">
                  No preview available
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon="Grid3x3" label="Walls" value={plan.walls?.length ?? 0} />
            <Stat icon="PanelsTopLeft" label="Rooms" value={plan.rooms.length} />
            <Stat icon="DoorClosed" label="Doors" value={plan.doors.length} />
            <Stat icon="Frame" label="Windows" value={plan.windows?.length ?? 0} />
          </div>

          {plan.rooms.length > 0 ? (
            <div className="mt-4">
              <RoomList rooms={plan.rooms} />
            </div>
          ) : (
            <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-dashed border-border bg-surface/60 px-4 py-3.5 text-sm text-muted">
              <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0 text-faint" />
              No rooms were detected on this plan. You can add them manually in Room
              Confirmation.
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {confirmingReset ? (
              <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-1.5 text-xs text-warning">
                <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                This discards the current analysis.
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
              <Button variant="outline" icon="RefreshCw" onClick={() => setConfirmingReset(true)}>
                Import another
              </Button>
            )}
            <Link href={`/projects/${id}/review`} className="ml-auto">
              <Button iconRight="ArrowRight">Continue to Room Confirmation</Button>
            </Link>
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
    );
  }

  // ---- DETECTING: live detection pipeline progress ----
  if (stage === "detecting") {
    const pct = Math.round((progress?.progress ?? 0) * 100);
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-md">
          <div className="relative mx-auto mb-8 aspect-[16/10] w-full overflow-hidden rounded-2xl border border-border bg-grid bg-bg">
            {selected?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selected.url}
                alt=""
                className="absolute inset-0 h-full w-full object-contain opacity-50"
              />
            )}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-1/3 animate-[vasto-pulse_1.4s_ease-in-out_infinite] bg-gradient-to-b from-accent/30 to-transparent" />
            <div className="absolute inset-0 ring-1 ring-inset ring-accent/30" />
          </div>

          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Icon name="Loader2" className="size-4 animate-spin text-accent" />
              {progress?.message ?? "Analyzing…"}
            </span>
            <span className="tabular-nums text-muted">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            Detecting walls, rooms, doors and windows on the server.
          </p>
        </div>
      </div>
    );
  }

  // ---- SELECTED: preview + Analyze button ----
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
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
                <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {!selected.isImage && (
              <p className="mt-2 text-xs text-warning">
                PDFs can&apos;t be analyzed automatically. Export the plan as a PNG or
                JPG for real wall/room detection.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="ghost" icon="ArrowLeft" onClick={reset}>
                Choose another
              </Button>
              <Button icon="Sparkles" onClick={runDetection}>
                Analyze floor plan
              </Button>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            Detects walls, doors, windows and room boundaries automatically — dimensions
            are estimated and can be corrected in Room Confirmation.
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
          <p className="mt-2 text-muted">
            Vastos detects walls, rooms and dimensions automatically.
          </p>
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

        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-faint">
          <Icon name="Sparkles" className="size-3.5 text-accent" />
          Tip: clean, high-contrast plans with solid black walls detect best.
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

/** Compact chips of detected rooms with their assigned type. */
function RoomList({ rooms }: { rooms: Room[] }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted">
        Rooms
      </span>
      <div className="flex flex-wrap gap-1.5">
        {rooms.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs"
          >
            <span className="size-2 rounded-sm" style={{ background: r.color }} />
            <span className="font-medium">{r.name}</span>
            {r.type && r.type !== "other" && (
              <span className="text-[10px] uppercase tracking-wide text-faint">{r.type}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="hover-lift flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 transition-colors">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.66 ? "text-success bg-success/12" : value >= 0.33 ? "text-warning bg-warning/12" : "text-danger bg-danger/12";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium", tone)}>
      <Icon name="Sparkles" className="size-3.5" />
      {pct}% confidence
    </span>
  );
}

const LAYER_META: { key: keyof LayerToggles; label: string; color: string }[] = [
  { key: "walls", label: "Walls", color: "#ff5c8a" },
  { key: "rooms", label: "Rooms", color: "#5cc98a" },
  { key: "doors", label: "Doors", color: "#f0b429" },
  { key: "windows", label: "Windows", color: "#5cc9e2" },
];

function LayerLegend({
  layers,
  onChange,
}: {
  layers: LayerToggles;
  onChange: (l: LayerToggles) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {LAYER_META.map((m) => {
        const on = layers[m.key];
        return (
          <button
            key={m.key}
            onClick={() => onChange({ ...layers, [m.key]: !on })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer",
              on
                ? "border-border-strong bg-surface-2 text-foreground"
                : "border-border bg-transparent text-faint",
            )}
          >
            <span
              className="size-2 rounded-sm"
              style={{ background: on ? m.color : "transparent", border: `1px solid ${m.color}` }}
            />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
