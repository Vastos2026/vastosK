"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { PlanEditor } from "@/components/project/plan-editor";
import { analyzePlan, tidyLayout, type PlanIssues } from "@/lib/plan-geometry";
import { fitViolations, roundFt } from "@/lib/furniture-fit";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const updateRoom = useVasto((s) => s.updateRoom);
  const resizeRoom = useVasto((s) => s.resizeRoom);
  const updateItem = useVasto((s) => s.updateItem);
  const removeItem = useVasto((s) => s.removeItem);
  const setStatus = useVasto((s) => s.setStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  // Room-by-room review: isolate zooms onto the selected room with only its
  // own furniture; prev/next steps through every room in order.
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
  const items = project.placedItems.filter((it) => !it.ghost);
  const selectedItem = items.find((it) => it.id === selectedItemId) ?? null;
  const roomItems = selected ? items.filter((it) => it.roomId === selected.id) : [];
  const clean = issueIds.size === 0;

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
    setSelectedItemId(null);
  };

  // Align rooms to a shared grid + separate overlaps (positions only — sizes
  // stay exactly as read from the printed dimensions).
  const tidy = () => {
    for (const { id: roomId, patch } of tidyLayout(plan)) updateRoom(id, roomId, patch);
  };

  // 2D Review hands off DIRECTLY to Rooms — the reviewed plan (room dimensions,
  // furniture sizes + placements, door/window positions) is the single source of
  // truth the render prompts are built from. No 3D Studio step in between.
  const goToRooms = () => {
    setStatus(id, "designing");
    router.push(`/projects/${id}/rooms`);
  };

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Icon name="Ruler" className="size-4 text-accent" />
            <span className="font-medium">2D Review</span>
            <span className="text-faint">·</span>
            <span className="hidden text-muted sm:inline">
              {isolate && selected
                ? `${selected.name} · ${selected.width} × ${selected.height} ft`
                : `${plan.planWidth} × ${plan.planHeight} ft`}
            </span>
          </div>
          <div className="flex items-center gap-2">
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
              items={items}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
              onChangeItem={(itemId, patch) => updateItem(id, itemId, patch)}
              focusId={isolate ? selectedId : null}
            />
          </div>
        </div>
      </div>

      {/* Inspector */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          {selectedItem ? (
            <div className="animate-fade-up space-y-4">
              <div className="flex items-center gap-2">
                <span className="size-3 rounded-sm" style={{ background: selectedItem.color }} />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">
                  Furniture
                </h3>
              </div>

              <Field label="Name">
                <input
                  value={selectedItem.name}
                  onChange={(e) => updateItem(id, selectedItem.id, { name: e.target.value })}
                  className="input"
                />
              </Field>

              <div className="grid grid-cols-3 gap-2">
                <Field label="Width (ft)">
                  <NumberInput
                    value={selectedItem.w}
                    onChange={(v) => updateItem(id, selectedItem.id, { w: v })}
                  />
                </Field>
                <Field label="Depth (ft)">
                  <NumberInput
                    value={selectedItem.d}
                    onChange={(v) => updateItem(id, selectedItem.id, { d: v })}
                  />
                </Field>
                <Field label="Height (ft)">
                  <NumberInput
                    value={selectedItem.h}
                    onChange={(v) => updateItem(id, selectedItem.id, { h: v })}
                  />
                </Field>
              </div>

              {/* Flag a piece bigger than its room (or the ceiling) — it can't be
                  placed validly. Same check as the room design page. */}
              {(() => {
                const itemRoom = plan.rooms.find((r) => r.id === selectedItem.roomId);
                const violations = itemRoom ? fitViolations(selectedItem, itemRoom) : [];
                if (!violations.length) return null;
                return (
                  <div className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-[11px] text-warning">
                    <Icon name="CircleAlert" className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {violations
                        .map((v) => `${v.full} ${roundFt(v.value)} ft exceeds ${v.against} ${roundFt(v.limit)} ft`)
                        .join("; ")}
                      . Reduce it to place the piece correctly.
                    </span>
                  </div>
                );
              })()}

              <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
                In room:{" "}
                <span className="text-foreground">
                  {plan.rooms.find((r) => r.id === selectedItem.roomId)?.name ?? "—"}
                </span>
              </div>

              <p className="text-xs text-faint">
                Edit width / depth / height above; drag the item on the plan to move it, or drop it in
                another room to re-home it.
              </p>

              <Button
                size="sm"
                variant="outline"
                icon="Trash2"
                onClick={() => {
                  removeItem(id, selectedItem.id);
                  setSelectedItemId(null);
                }}
              >
                Remove item
              </Button>
            </div>
          ) : selected ? (
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

              <div className="grid grid-cols-2 gap-3">
                {/* Parametric: resizing also rescales the furniture inside */}
                <Field label="Width (ft)">
                  <NumberInput
                    value={selected.width}
                    onChange={(v) => resizeRoom(id, selected.id, { width: v })}
                  />
                </Field>
                <Field label="Height (ft)">
                  <NumberInput
                    value={selected.height}
                    onChange={(v) => resizeRoom(id, selected.id, { height: v })}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="X (ft)">
                  <NumberInput value={selected.x} onChange={(v) => updateRoom(id, selected.id, { x: v })} />
                </Field>
                <Field label="Y (ft)">
                  <NumberInput value={selected.y} onChange={(v) => updateRoom(id, selected.id, { y: v })} />
                </Field>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-muted">
                Area ≈ <span className="text-foreground">{Math.round(selected.width * selected.height * 10) / 10} sq ft</span>
              </div>

              {/* Furniture inventory extracted for this room */}
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  In this room · {roomItems.length}
                </h4>
                {roomItems.length > 0 ? (
                  <div className="space-y-1">
                    {roomItems.map((it) => (
                      <button
                        key={it.id}
                        onClick={() => setSelectedItemId(it.id)}
                        className="flex w-full items-center justify-between rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-accent/50 cursor-pointer"
                      >
                        <span className="flex items-center gap-2">
                          <span className="size-2 rounded-sm" style={{ background: it.color }} />
                          {it.name}
                        </span>
                        <span className="text-faint">{it.w}×{it.d} ft</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-border px-2.5 py-2 text-xs text-faint">
                    No furniture detected in this room.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">
              <Icon name="Move" className="mx-auto mb-2 size-5 text-faint" />
              Select a room to edit its name and dimensions, drag a wall to resize it, or
              drag furniture to move it between rooms.
            </div>
          )}

          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">
              Rooms · {plan.rooms.length}
            </h3>
            <div className="space-y-1">
              {plan.rooms.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors cursor-pointer",
                    r.id === selectedId ? "bg-accent/10 text-accent" : "hover:bg-surface-2",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-sm" style={{ background: r.color }} />
                    {r.name}
                    {issueIds.has(r.id) && (
                      <Icon name="CircleAlert" className="size-3.5 text-danger" />
                    )}
                  </span>
                  <span className="text-xs text-faint">{r.width}×{r.height}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-border p-4">
          <Button className="w-full" iconRight="ArrowRight" onClick={goToRooms}>
            Continue to Rooms
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

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      className="input"
    />
  );
}
