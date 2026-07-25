"use client";

import { useCallback, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import {
  parsePlanViaApi,
  type DetectProgress,
  type ParseResult,
} from "@/lib/parse-plan-client";
import type { DetectedGeometry, FloorPlan, Room } from "@/lib/types";
import type { PlanValidation } from "@/lib/pipeline/types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PlanThumb } from "@/components/plan-thumb";
import { PlanEditor } from "@/components/project/plan-editor";
import {
  DetectionOverlay,
  type LayerToggles,
} from "@/components/project/detection-overlay";
import { LassoSelect } from "@/components/project/lasso-select";
import {
  extractLassoRegion,
  ROOM_PALETTE,
  type LassoExtraction,
  type Pt,
} from "@/lib/lasso-extract";
import { cn, uid } from "@/lib/utils";

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
  const updateRoom = useVasto((s) => s.updateRoom);
  const addRoom = useVasto((s) => s.addRoom);

  const [stage, setStage] = useState<Stage>("idle");
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [progress, setProgress] = useState<DetectProgress | null>(null);
  const [geometry, setGeometry] = useState<DetectedGeometry | null>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [calibrated, setCalibrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selRoom, setSelRoom] = useState<string | null>(null);
  // "Import another" discards the current analysis — a small inline confirm
  // step (not a full modal) so an accidental click doesn't silently lose it.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [layers, setLayers] = useState<LayerToggles>({
    walls: true,
    doors: true,
    windows: true,
    rooms: true,
  });
  // Lasso room-selection state: draw a loop on the plan image → the region's
  // walls/labels/furniture become an editable room proposal.
  const [lassoOn, setLassoOn] = useState(false);
  const [lasso, setLasso] = useState<LassoExtraction | null>(null);
  const [lassoName, setLassoName] = useState("");
  const [lassoW, setLassoW] = useState("");
  const [lassoH, setLassoH] = useState("");
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

  /** Run server-side Python OpenCV detection on the selected image. */
  const runDetection = useCallback(async () => {
    if (!selected) return;
    setError(null);

    // PDFs aren't raster — Python OpenCV needs an image. Ask for a real raster
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
      setParse(result);
      setConfidence(result.confidence);
      setCalibrated(result.calibrated);
      // The reconstructed plan starts EMPTY: detection only supplies candidates.
      // The user lassos each room on the image — only confirmed selections are
      // placed on the plan, so every room is user-verified.
      setFloorPlan(id, { ...result.plan, rooms: [] });
      setLassoOn(true);
      setLasso(null);
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
    setParse(null);
    setProgress(null);
    setError(null);
    setCalibrated(false);
    setConfirmingReset(false);
    setStage("idle");
  }, []);

  if (!project) return null;

  const plan = project.floorPlan;

  /** Lasso closed → isolate walls/labels inside it into a room proposal. */
  const onLassoComplete = (polygon: Pt[]) => {
    if (!geometry || !plan) return;
    const ext = extractLassoRegion({ polygon, geometry, plan, ocr: parse?.ocr });
    setLasso(ext);
    setLassoName(ext.name ?? "");
    setLassoW(String(ext.widthFt));
    setLassoH(String(ext.heightFt));
  };

  /** Confirm the proposal: add (or update) the room. */
  const confirmLasso = () => {
    if (!lasso || !plan) return;
    const w = Math.max(2, Number(lassoW) || lasso.widthFt);
    const h = Math.max(2, Number(lassoH) || lasso.heightFt);
    const name = lassoName.trim() || lasso.name || `Room ${plan.rooms.length + 1}`;
    const x = Math.max(0, Math.min(lasso.rectFt.x, plan.planWidth - w));
    const y = Math.max(0, Math.min(lasso.rectFt.y, plan.planHeight - h));

    if (lasso.matchedRoomId) {
      // The loop re-traced an auto-detected room — correct it instead of duplicating.
      updateRoom(id, lasso.matchedRoomId, {
        name,
        width: w,
        height: h,
        x,
        y,
        ...(lasso.type ? { type: lasso.type } : {}),
      });
    } else {
      addRoom(id, {
        id: uid("room"),
        name,
        type: lasso.type,
        x,
        y,
        width: w,
        height: h,
        color: ROOM_PALETTE[plan.rooms.length % ROOM_PALETTE.length],
      });
    }
    setLasso(null);
  };

  // ---- DONE: detection result over the real image ----
  if (stage === "done" && plan) {
    const isDetected = plan.meta?.source === "opencv" || plan.meta?.source === "merged";
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-success/15 text-success">
                <Icon name="CircleCheck" className="size-5" />
              </span>
              <div>
                <h2 className="font-semibold">2D design imported</h2>
                <p className="text-sm text-muted">
                  {`${plan.walls?.length ?? 0} walls · ${plan.rooms.length} rooms · ${plan.doors.length} doors · ${plan.windows?.length ?? 0} windows`}
                </p>
              </div>
            </div>
            {isDetected && <ConfidenceBadge value={confidence} />}
          </div>

          {isDetected && parse && <PipelineStagesStrip parse={parse} plan={plan} />}

          {isDetected && parse?.validation && <ValidationChips validation={parse.validation} />}

          {isDetected && !calibrated && (
            <div className="mb-5 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
              <Icon name="Ruler" className="mt-0.5 size-4 shrink-0" />
              <span>
                Dimensions are <strong>estimated</strong> — no real measurement was
                given, so scale is approximate. Adjust room sizes in 2D Review, or
                re-import with the longest dimension filled in for exact scale.
              </span>
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            {/* Detection over the actual uploaded image */}
            <div className="rounded-2xl border border-border bg-surface p-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Detected geometry
                </span>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {selected?.url && geometry && (
                    <button
                      onClick={() => {
                        setLassoOn((on) => !on);
                        setLasso(null);
                      }}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer",
                        lassoOn
                          ? "border-accent/50 bg-accent/10 text-accent"
                          : "border-border bg-transparent text-muted hover:border-border-strong",
                      )}
                    >
                      <Icon name="Lasso" className="size-3" />
                      Lasso room
                    </button>
                  )}
                  {geometry && <LayerLegend layers={layers} onChange={setLayers} />}
                </div>
              </div>
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-grid bg-bg">
                {selected?.url && geometry ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={selected.url}
                      alt="Uploaded floor plan"
                      className="absolute inset-0 h-full w-full object-contain opacity-80"
                    />
                    <DetectionOverlay geometry={geometry} layers={layers} />
                    {lassoOn && (
                      <LassoSelect
                        imageWidth={geometry.imageWidth}
                        imageHeight={geometry.imageHeight}
                        active={lassoOn}
                        onComplete={onLassoComplete}
                        preview={
                          lasso
                            ? {
                                polygon: lasso.polygon,
                                rect: lasso.snappedPx,
                                label: lassoName || lasso.name,
                              }
                            : null
                        }
                      />
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 p-6">
                    <PlanThumb plan={plan} showLabels />
                  </div>
                )}
              </div>

              {lassoOn && (
                <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3">
                  {lasso ? (
                    <LassoProposal
                      lasso={lasso}
                      matchedName={
                        lasso.matchedRoomId
                          ? plan.rooms.find((r) => r.id === lasso.matchedRoomId)?.name
                          : undefined
                      }
                      name={lassoName}
                      w={lassoW}
                      h={lassoH}
                      onName={setLassoName}
                      onW={setLassoW}
                      onH={setLassoH}
                      onConfirm={confirmLasso}
                      onDiscard={() => setLasso(null)}
                    />
                  ) : (
                    <p className="flex items-start gap-2 text-xs text-muted">
                      <Icon name="Lasso" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                      Draw a loop around one room on the plan. Its walls set the
                      boundary, the printed label fills the name + dimensions, and
                      any furniture inside is tagged to the room — review it in the
                      panel that appears here.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Normalized plan + actions */}
            <div className="flex flex-col gap-5">
              <div className="rounded-2xl border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">
                    Reconstructed plan · {plan.planWidth} × {plan.planHeight} ft
                  </span>
                  <span className="hidden text-[11px] text-faint sm:inline">
                    {plan.rooms.length > 0 ? "Drag walls to adjust" : "Fills as you lasso rooms"}
                  </span>
                </div>
                <div className="relative aspect-[4/3] rounded-xl border border-border bg-grid bg-bg p-2">
                  <PlanEditor
                    plan={plan}
                    selectedId={selRoom}
                    onSelect={setSelRoom}
                    onChangeRoom={(roomId, patch) => updateRoom(id, roomId, patch)}
                    shell
                  />
                  {plan.rooms.length === 0 && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 grid place-items-center p-3">
                      <div className="rounded-xl border border-dashed border-border bg-surface/85 px-4 py-2.5 text-center text-xs text-muted backdrop-blur">
                        <Icon name="Lasso" className="mx-auto mb-1 size-4 text-accent" />
                        Detected walls, doors &amp; windows shown. Lasso each room on
                        the left to place it here with its dimensions.
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Stat icon="Grid3x3" label="Walls" value={plan.walls?.length ?? 0} />
                  <Stat icon="PanelsTopLeft" label="Rooms" value={plan.rooms.length} />
                  <Stat icon="DoorClosed" label="Doors" value={plan.doors.length} />
                  <Stat icon="Frame" label="Windows" value={plan.windows?.length ?? 0} />
                </div>
              </div>

              {isDetected && plan.rooms.length > 0 && <RoomList rooms={plan.rooms} />}

              <div className="flex flex-wrap items-center gap-3">
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
                {parse && (
                  <span className="text-xs tabular-nums text-faint">
                    {plan.rooms.length} of ~{parse.plan.rooms.length} detected rooms placed
                  </span>
                )}
                {plan.rooms.length > 0 ? (
                  <Link href={`/projects/${id}/review`} className="ml-auto">
                    <Button iconRight="ArrowRight">Continue to 2D Review</Button>
                  </Link>
                ) : (
                  <Button className="ml-auto" iconRight="ArrowRight" disabled>
                    Continue to 2D Review
                  </Button>
                )}
              </div>
            </div>
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

  // ---- DETECTING: live OpenCV pipeline progress ----
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
              {progress?.message ?? "Starting OpenCV…"}
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
            Running Python OpenCV on the server for accurate geometry.
          </p>
        </div>
      </div>
    );
  }

  // ---- SELECTED: preview + Import 2D Design button ----
  if (stage === "selected" && selected) {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-xl">
          <div className="rounded-2xl border border-border bg-surface p-4">
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
                PDFs can&apos;t be analyzed by OpenCV. Export the plan as a PNG or
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
            are estimated and can be corrected in 2D Review.
          </p>
        </div>
      </div>
    );
  }

  // ---- IDLE: dropzone ----
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Upload your floor plan</h2>
          <p className="mt-1 text-muted">
            Vasto runs OpenCV to detect walls, rooms and dimensions automatically.
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
            "group cursor-pointer rounded-2xl border-2 border-dashed bg-surface/40 px-6 py-16 text-center transition-colors",
            drag ? "border-accent bg-accent/5" : "border-border hover:border-border-strong",
          )}
        >
          <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent/10 text-accent transition-transform group-hover:scale-105">
            <Icon name="Upload" className="size-8" />
          </div>
          <p className="mt-4 font-medium">
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

/** Horizontal strip mirroring the pipeline: S3 → OCR → Gemini → OpenCV → Merge. */
function PipelineStagesStrip({ parse, plan }: { parse: ParseResult; plan: FloorPlan }) {
  const steps: { icon: string; label: string; value: string }[] = [
    { icon: "Upload", label: "AWS S3", value: parse.storage?.backend === "s3" ? "S3" : "local" },
    { icon: "Eye", label: "OCR", value: `${parse.ocr?.tokens.length ?? 0} labels` },
    { icon: "Sparkles", label: "Gemini Flash", value: `${parse.semantic?.rooms.length ?? 0} rooms` },
    {
      icon: "Grid3x3",
      label: "OpenCV",
      value: `${plan.walls?.length ?? 0}w · ${plan.rooms.length}r`,
    },
    { icon: "GitCompare", label: "Merge", value: `${parse.roomsNamed ?? 0} named` },
  ];
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2">
            <span className="grid size-7 place-items-center rounded-lg bg-accent/10 text-accent">
              <Icon name={s.icon} className="size-3.5" />
            </span>
            <div className="leading-tight">
              <p className="text-[11px] font-medium">{s.label}</p>
              <p className="text-[11px] tabular-nums text-muted">{s.value}</p>
            </div>
          </div>
          {i < steps.length - 1 && (
            <Icon name="ChevronRight" className="size-4 shrink-0 text-faint" />
          )}
        </div>
      ))}
    </div>
  );
}

/** Pass/warn chips for the reconstruction sanity checks (advisory, non-blocking). */
function ValidationChips({ validation }: { validation: PlanValidation }) {
  const passed = validation.checks.filter((c) => c.ok).length;
  return (
    <div className="mb-5 rounded-2xl border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Reconstruction checks
        </span>
        <span className="text-[11px] tabular-nums text-faint">
          {passed}/{validation.checks.length} passed
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {validation.checks.map((c) => (
          <span
            key={c.label}
            title={c.detail}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
              c.ok
                ? "border-success/30 bg-success/10 text-success"
                : "border-warning/30 bg-warning/10 text-warning",
            )}
          >
            <Icon name={c.ok ? "CircleCheck" : "CircleAlert"} className="size-3" />
            <span className="font-medium">{c.label}</span>
            <span className="opacity-70">{c.detail}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The editable proposal built from a lasso selection: name + parametric
 * dimensions (printed label first, measured otherwise), and confirm/discard
 * actions.
 */
function LassoProposal({
  lasso,
  matchedName,
  name,
  w,
  h,
  onName,
  onW,
  onH,
  onConfirm,
  onDiscard,
}: {
  lasso: LassoExtraction;
  /** name of the existing room this selection would update, if any */
  matchedName?: string;
  name: string;
  w: string;
  h: string;
  onName: (v: string) => void;
  onW: (v: string) => void;
  onH: (v: string) => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
          <Icon name="Lasso" className="size-3.5" />
          Room from selection
        </span>
        <span className="text-[11px] text-faint">
          {lasso.labelDims
            ? `dimensions read from the plan's printed label`
            : `dimensions measured from the selection`}
        </span>
      </div>

      {matchedName && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
          This selection overlaps the detected room “{matchedName}” — confirming
          updates that room instead of adding a new one.
        </p>
      )}

      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted">Room name</span>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="e.g. Kitchen"
            className="input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted">Width (ft)</span>
          <input
            type="number"
            inputMode="decimal"
            value={w}
            onChange={(e) => onW(e.target.value)}
            className="input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted">Height (ft)</span>
          <input
            type="number"
            inputMode="decimal"
            value={h}
            onChange={(e) => onH(e.target.value)}
            className="input"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
          <Icon name="Grid3x3" className="size-3" /> {lasso.counts.walls} walls
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
          <Icon name="DoorClosed" className="size-3" /> {lasso.counts.doors} doors
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
          <Icon name="Frame" className="size-3" /> {lasso.counts.windows} windows
        </span>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" icon="X" onClick={onDiscard}>
          Discard
        </Button>
        <Button size="sm" icon={matchedName ? "Check" : "Plus"} onClick={onConfirm}>
          {matchedName ? `Update ${matchedName}` : "Add room"}
        </Button>
      </div>
    </div>
  );
}

/** Compact chips of detected rooms with their Gemini-assigned type. */
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
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-base font-semibold leading-none tabular-nums">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.66 ? "text-success bg-success/12" : value >= 0.33 ? "text-warning bg-warning/12" : "text-danger bg-danger/12";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium", tone)}>
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
