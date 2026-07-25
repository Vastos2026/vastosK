"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { PlanEditor } from "@/components/project/plan-editor";
import { analyzePlan, tidyLayout, type PlanIssues } from "@/lib/plan-geometry";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { formatLength, fromFeet, ftInToFeet, feetToFtIn, toFeet } from "@/lib/units";
import { UNITS } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Room, Unit } from "@/lib/types";

/** Door/window counts detected + assigned to this room (best-effort, never asserts zero). */
function openingCounts(room: Room) {
  const openings = room.openings ?? [];
  return {
    doors: openings.filter((o) => o.type === "door").length,
    windows: openings.filter((o) => o.type === "window").length,
  };
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const updateRoom = useVasto((s) => s.updateRoom);
  const removeRoom = useVasto((s) => s.removeRoom);
  const resizeRoom = useVasto((s) => s.resizeRoom);
  const patchProject = useVasto((s) => s.patchProject);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isolate, setIsolate] = useState(false);

  // Hooks must run on every render — before the early returns below (Rules of
  // Hooks). Guard against a not-yet-loaded plan.
  const floorPlan = project?.floorPlan ?? null;
  const issues = useMemo<PlanIssues>(
    () =>
      floorPlan
        ? analyzePlan(floorPlan)
        : { overlapIds: new Set(), outOfBoundsIds: new Set(), overlapPairs: 0, coverage: 0 },
    [floorPlan],
  );
  const issueIds = useMemo(
    () => new Set<string>([...issues.overlapIds, ...issues.outOfBoundsIds]),
    [issues],
  );

  if (!project) return null;

  if (!project.floorPlan) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
            <Icon name="Ruler" className="size-7" />
          </div>
          <h2 className="mt-4 text-lg font-medium">No floor plan yet</h2>
          <p className="mt-1 text-sm text-muted">Upload a plan to start reviewing.</p>
          <Link href={`/projects/${id}/upload`}>
            <Button className="mt-4" icon="Upload">Upload floor plan</Button>
          </Link>
        </div>
      </div>
    );
  }

  const plan = project.floorPlan;
  const selected = plan.rooms.find((r) => r.id === selectedId) ?? null;
  const clean = issueIds.size === 0;
  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];

  /** Step to the previous/next room (wraps), keeping isolate mode if on. */
  const stepRoom = (dir: 1 | -1) => {
    if (!plan.rooms.length) return;
    const i = plan.rooms.findIndex((r) => r.id === selectedId);
    const next =
      i < 0
        ? dir > 0
          ? 0
          : plan.rooms.length - 1
        : (i + dir + plan.rooms.length) % plan.rooms.length;
    setSelectedId(plan.rooms[next].id);
  };

  // Align rooms to a shared grid + separate overlaps (positions only — sizes
  // stay exactly as read from the printed dimensions).
  const tidy = () => {
    for (const { id: roomId, patch } of tidyLayout(plan)) updateRoom(id, roomId, patch);
  };

  const goToDesign = () => router.push(`/projects/${id}/design`);

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Icon name="Ruler" className="size-4 text-accent" />
            <span className="font-medium">Room Confirmation</span>
            <span className="text-faint">·</span>
            <span className="hidden text-muted sm:inline">
              {isolate && selected
                ? `${selected.name} · ${formatLength(selected.width, unit)} × ${formatLength(selected.height, unit)}`
                : `${formatLength(plan.planWidth, unit)} × ${formatLength(plan.planHeight, unit)}`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UnitSelect value={unit} onChange={(u) => patchProject(id, { units: u })} />
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon="ChevronLeft" onClick={() => stepRoom(-1)} />
              <span className="min-w-16 text-center text-xs tabular-nums text-muted">
                {selected
                  ? `${plan.rooms.findIndex((r) => r.id === selected.id) + 1} / ${plan.rooms.length}`
                  : `${plan.rooms.length} rooms`}
              </span>
              <Button size="sm" variant="ghost" icon="ChevronRight" onClick={() => stepRoom(1)} />
            </div>
            <Button
              size="sm"
              variant={isolate ? "primary" : "outline"}
              icon={isolate ? "Grid3x3" : "Maximize2"}
              onClick={() => setIsolate((v) => !v)}
              disabled={!selected}
            >
              {isolate ? "Full plan" : "Isolate room"}
            </Button>
            {clean ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                <Icon name="CircleCheck" className="size-3.5" /> Layout clean
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
                <Icon name="CircleAlert" className="size-3.5" />
                {issues.overlapPairs > 0 && `${issues.overlapPairs} overlap${issues.overlapPairs > 1 ? "s" : ""}`}
                {issues.overlapPairs > 0 && issues.outOfBoundsIds.size > 0 && " · "}
                {issues.outOfBoundsIds.size > 0 && `${issues.outOfBoundsIds.size} off-plan`}
              </span>
            )}
            <Button size="sm" variant="outline" icon="Wand2" onClick={tidy} disabled={clean}>
              Tidy layout
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-bg p-6">
          <div className="mx-auto h-full max-w-4xl">
            <PlanEditor
              plan={plan}
              selectedId={selectedId}
              onSelect={(rid) => {
                setSelectedId(rid);
                if (!rid) setIsolate(false);
              }}
              onChangeRoom={(roomId, patch) => updateRoom(id, roomId, patch)}
              issueIds={issueIds}
              focusId={isolate ? selectedId : null}
            />
          </div>
        </div>
      </div>

      {/* Inspector */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          {selected ? (
            <div className="animate-fade-up space-y-4">
              <div className="flex items-center gap-2">
                <span className="size-3 rounded-sm" style={{ background: selected.color }} />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">
                  Room properties
                </h3>
              </div>

              <Field label="Name">
                <input
                  value={selected.name}
                  onChange={(e) => updateRoom(id, selected.id, { name: e.target.value })}
                  className="input"
                />
              </Field>

              <Field label="Type">
                <select
                  value={selected.type ?? ""}
                  onChange={(e) => updateRoom(id, selected.id, { type: e.target.value || undefined })}
                  className="input w-full cursor-pointer"
                >
                  <option value="">Unset</option>
                  {roomTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <p className="-mt-2 text-[11px] text-faint">
                The room&apos;s category tag — separate from its name, used for walkthrough
                ordering and the design prompt when the name alone isn&apos;t a reliable signal.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <DimensionField
                  label="Width"
                  feet={selected.width}
                  unit={unit}
                  onChange={(v) => resizeRoom(id, selected.id, { width: v })}
                />
                <DimensionField
                  label="Height"
                  feet={selected.height}
                  unit={unit}
                  onChange={(v) => resizeRoom(id, selected.id, { height: v })}
                />
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
                Area ≈{" "}
                <span className="text-foreground">
                  {Math.round(selected.width * selected.height * 10) / 10} sq ft
                </span>
              </div>

              {(() => {
                const { doors, windows } = openingCounts(selected);
                return (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
                      <Icon name="DoorClosed" className="size-3" /> {doors} door{doors === 1 ? "" : "s"}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5">
                      <Icon name="Frame" className="size-3" /> {windows} window{windows === 1 ? "" : "s"}
                    </span>
                  </div>
                );
              })()}

              <Button
                size="sm"
                variant="outline"
                icon="Trash2"
                onClick={() => {
                  removeRoom(id, selected.id);
                  setSelectedId(null);
                }}
              >
                Delete room
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">
              <Icon name="Move" className="mx-auto mb-2 size-5 text-faint" />
              Select a room to edit its name, type and dimensions, or drag a wall to resize it.
            </div>
          )}

          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
              Rooms · {plan.rooms.length}
            </h3>
            <div className="space-y-1">
              {plan.rooms.map((r) => {
                const { doors, windows } = openingCounts(r);
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors cursor-pointer",
                      r.id === selectedId ? "bg-accent/10 text-accent" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                      <span className="truncate">{r.name}</span>
                      {issueIds.has(r.id) && (
                        <Icon name="CircleAlert" className="size-3.5 shrink-0 text-danger" />
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-faint">
                      {formatLength(r.width, unit)} × {formatLength(r.height, unit)} · {windows}W · {doors}D
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="border-t border-border p-4">
          <Button className="w-full" iconRight="ArrowRight" onClick={goToDesign}>
            Continue to Design
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function UnitSelect({ value, onChange }: { value: Unit; onChange: (u: Unit) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Unit)}
      className="input cursor-pointer !py-1.5 text-xs"
      aria-label="Units"
    >
      {UNITS.map((u) => (
        <option key={u.id} value={u.id}>{u.label}</option>
      ))}
    </select>
  );
}

/** A room dimension editor: two fields (ft, in) for ft-in, one decimal field otherwise. */
function DimensionField({
  label,
  feet,
  unit,
  onChange,
}: {
  label: string;
  feet: number;
  unit: Unit;
  onChange: (feet: number) => void;
}) {
  if (unit === "ft-in") {
    const { ft, inches } = feetToFtIn(feet);
    return (
      <div>
        <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={ft}
            onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches))}
            className="input w-full"
            aria-label={`${label} feet`}
          />
          <span className="text-xs text-faint">ft</span>
          <input
            type="number"
            min={0}
            max={11}
            value={inches}
            onChange={(e) => onChange(ftInToFeet(ft, Number(e.target.value) || 0))}
            className="input w-full"
            aria-label={`${label} inches`}
          />
          <span className="text-xs text-faint">in</span>
        </div>
      </div>
    );
  }
  return (
    <Field label={`${label} (${unit === "m" ? "m" : unit === "cm" ? "cm" : "ft"})`}>
      <input
        type="number"
        value={fromFeet(feet, unit)}
        onChange={(e) => onChange(toFeet(Number(e.target.value) || 0, unit))}
        className="input"
      />
    </Field>
  );
}
