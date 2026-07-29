"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { emptyPlan } from "@/lib/pipeline/empty-plan";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { fromFeet, ftInToFeet, feetToFtIn, toFeet } from "@/lib/units";
import { UNITS } from "@/lib/data";
import { ROOM_PALETTE, uid, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import type { Room, Unit } from "@/lib/types";

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
  const setOpeningCount = useVasto((s) => s.setOpeningCount);
  const addRoom = useVasto((s) => s.addRoom);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const patchProject = useVasto((s) => s.patchProject);
  const [addingRoom, setAddingRoom] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [planModalOpen, setPlanModalOpen] = useState(false);

  if (!project) return null;

  const plan = project.floorPlan;
  const rooms = plan?.rooms ?? [];
  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];
  const referenceImage = plan?.previewUrl;
  // Only sum rooms with both dimensions known — a room still missing a
  // dimension contributes 0 rather than turning the whole total into NaN.
  const totalSqFt = rooms.reduce(
    (sum, r) => sum + (r.width !== undefined && r.height !== undefined ? r.width * r.height : 0),
    0,
  );

  const goToDesign = () => router.push(`/projects/${id}/design`);

  const confirmDelete = (roomId: string) => {
    removeRoom(id, roomId);
    setPendingDeleteId(null);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Room Confirmation</h2>
            <p className="mt-1 text-sm text-muted">
              {rooms.length > 0
                ? `${rooms.length} room${rooms.length === 1 ? "" : "s"} found. Review and correct anything below.`
                : "No rooms yet. Add your first one below."}
            </p>
            {rooms.length > 0 && (
              <p className="mt-1 text-xs text-faint">
                Only the rooms confirmed here will get an AI-generated image later, so remove anything you don&apos;t need.
              </p>
            )}
          </div>
          {rooms.length > 0 && (
            <Badge icon="Ruler" className="hidden shrink-0 sm:inline-flex">
              {Math.round(totalSqFt).toLocaleString()} sq ft total
            </Badge>
          )}
        </div>

        {referenceImage && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
            <button
              type="button"
              onClick={() => setPlanModalOpen(true)}
              aria-label="View floor plan"
              className="group relative h-16 w-24 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-grid bg-bg transition-colors hover:border-accent/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceImage} alt="Uploaded floor plan" className="h-full w-full object-contain" />
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                <Icon name="Maximize2" className="size-4 text-white" />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Uploaded floor plan</p>
              <p className="text-xs text-muted">Reference only, not used for generation.</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon="Maximize2"
              className="shrink-0"
              aria-label="View floor plan full size"
              onClick={() => setPlanModalOpen(true)}
            >
              <span className="hidden sm:inline">View full size</span>
            </Button>
          </div>
        )}

        <Modal
          open={planModalOpen}
          onClose={() => setPlanModalOpen(false)}
          title="Uploaded Floor Plan"
          className="max-w-3xl"
        >
          <div className="p-6 pt-4">
            {referenceImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={referenceImage}
                alt="Uploaded floor plan"
                className="mx-auto max-h-[80vh] w-full object-contain"
              />
            )}
          </div>
        </Modal>

        <div className="space-y-2.5">
          {rooms.map((room, i) => {
            const { doors, windows } = openingCounts(room);
            // Derived live, not a stored flag — so filling in a dimension
            // below clears the warning immediately instead of it going stale.
            const dimensionsMissing = room.width === undefined || room.height === undefined;
            return (
              <div
                key={room.id}
                className="hover-lift animate-fade-up rounded-2xl border border-border bg-surface p-4 transition-colors"
                style={{ animationDelay: `${Math.min(i, 10) * 60}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span className="size-3 shrink-0 rounded-sm" style={{ background: room.color }} />
                  <input
                    value={room.name}
                    onChange={(e) => updateRoom(id, room.id, { name: e.target.value })}
                    className="input min-w-0 flex-1 font-medium"
                    aria-label={`${room.name || "Room"} name`}
                  />
                  {dimensionsMissing && (
                    <span
                      className="inline-flex shrink-0 items-center text-warning"
                      title="Dimensions weren't given for this room, so its size in the generated image may be inaccurate."
                    >
                      <Icon name="CircleAlert" className="size-3.5" />
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    icon="Trash2"
                    aria-label="Delete room"
                    onClick={() => setPendingDeleteId(room.id)}
                  />
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 pl-6">
                  <RoomTypeField
                    value={room.type ?? ""}
                    onChange={(v) => updateRoom(id, room.id, { type: v || undefined })}
                    roomTypes={roomTypes}
                    emptyOptionLabel="Unset type"
                    className="input w-40 shrink-0"
                    ariaLabel={`${room.name || "Room"} type`}
                  />

                  <div className="flex items-center gap-2.5">
                    <DimensionInline
                      label="W"
                      feet={room.width}
                      unit={unit}
                      onChange={(v) => resizeRoom(id, room.id, { width: v })}
                    />
                    <DimensionInline
                      label="H"
                      feet={room.height}
                      unit={unit}
                      onChange={(v) => resizeRoom(id, room.id, { height: v })}
                    />
                  </div>

                  <div className="flex items-center gap-2.5 sm:ml-auto sm:border-l sm:border-border sm:pl-3">
                    <OpeningCountField
                      label="Doors"
                      value={doors}
                      onChange={(v) => setOpeningCount(id, room.id, "door", v)}
                    />
                    <OpeningCountField
                      label="Windows"
                      value={windows}
                      onChange={(v) => setOpeningCount(id, room.id, "window", v)}
                    />
                  </div>
                </div>

                {pendingDeleteId === room.id && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                    <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                    <span className="flex-1">
                      This room will be deleted. You can still add it back with Add room.
                    </span>
                    <button
                      onClick={() => confirmDelete(room.id)}
                      className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setPendingDeleteId(null)}
                      className="cursor-pointer text-faint hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {rooms.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center">
              <Icon name="ListPlus" className="mx-auto size-7 text-faint" />
              <p className="mt-3 text-sm text-muted">Add your first room to get started.</p>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <UnitSelect value={unit} onChange={(u) => patchProject(id, { units: u })} />
        </div>

        <div className="mt-2.5">
          {addingRoom ? (
            <AddRoomForm
              roomTypes={roomTypes}
              paletteIndex={rooms.length}
              onAdd={(room) => {
                if (!project.floorPlan) {
                  setFloorPlan(id, { ...emptyPlan(), rooms: [room] });
                } else {
                  addRoom(id, room);
                }
                setAddingRoom(false);
              }}
              onCancel={() => setAddingRoom(false)}
            />
          ) : (
            <button
              onClick={() => setAddingRoom(true)}
              className="hover-lift flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface/60 py-4 text-sm font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              <Icon name="Plus" className="size-4" /> Add room
            </button>
          )}
        </div>

        <div className="mt-8 flex justify-end">
          <Button iconRight="ArrowRight" disabled={rooms.length === 0} onClick={goToDesign}>
            Continue to Design
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A small labelled number input for door/window counts — editable, not just a read-out. */
function OpeningCountField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
      {label}
      <input
        type="number"
        min={0}
        max={20}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="input w-14 text-center"
        aria-label={label}
      />
    </span>
  );
}

function AddRoomForm({
  roomTypes,
  paletteIndex,
  onAdd,
  onCancel,
}: {
  roomTypes: string[];
  paletteIndex: number;
  onAdd: (room: Room) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [width, setWidth] = useState("10");
  const [height, setHeight] = useState("10");

  const submit = () => {
    const w = Math.max(2, Number(width) || 10);
    const h = Math.max(2, Number(height) || 10);
    onAdd({
      id: uid("room"),
      name: name.trim() || "New room",
      type: type || undefined,
      x: 0,
      y: 0,
      width: w,
      height: h,
      color: ROOM_PALETTE[paletteIndex % ROOM_PALETTE.length],
    });
  };

  return (
    <div className="space-y-2.5 rounded-2xl border border-border bg-surface-2 p-4">
      <div className="flex gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name"
          className="input min-w-0 flex-1"
        />
        <RoomTypeField
          value={type}
          onChange={setType}
          roomTypes={roomTypes}
          emptyOptionLabel="Type"
          className="input w-36 shrink-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex flex-1 items-center gap-1.5 text-xs text-muted">
          W
          <input
            type="number"
            inputMode="decimal"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className="input"
            aria-label="Width"
          />
          <span className="text-faint">ft</span>
        </span>
        <span className="flex flex-1 items-center gap-1.5 text-xs text-muted">
          H
          <input
            type="number"
            inputMode="decimal"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className="input"
            aria-label="Height"
          />
          <span className="text-faint">ft</span>
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" icon="Plus" onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * Room type field — a `<select>` constrained to the project category's fixed
 * room-type list, or a free-text `<input>` when the category has none (e.g.
 * Custom). Was hand-duplicated at both call sites (the room row, the Add
 * Room form) with only the width/placeholder/aria-label differing.
 */
function RoomTypeField({
  value,
  onChange,
  roomTypes,
  emptyOptionLabel,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  roomTypes: string[];
  emptyOptionLabel: string;
  className: string;
  ariaLabel?: string;
}) {
  if (roomTypes.length > 0) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(className, "cursor-pointer")}
        aria-label={ariaLabel}
      >
        <option value="">{emptyOptionLabel}</option>
        {roomTypes.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Room type"
      className={className}
      aria-label={ariaLabel}
    />
  );
}

function UnitSelect({ value, onChange }: { value: Unit; onChange: (u: Unit) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Units
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Unit)}
        className="input cursor-pointer !w-auto !py-1.5 text-xs"
        aria-label="Units"
      >
        {UNITS.map((u) => (
          <option key={u.id} value={u.id}>{u.label}</option>
        ))}
      </select>
    </label>
  );
}

function DimensionInline({
  label,
  feet,
  unit,
  onChange,
}: {
  label: string;
  /** undefined when this dimension wasn't given (not printed on the plan, not filled in yet) — renders as a blank input, never a fake "10". */
  feet: number | undefined;
  unit: Unit;
  onChange: (feet: number) => void;
}) {
  if (unit === "ft-in") {
    const { ft, inches } = feetToFtIn(feet);
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
        {label}
        <input
          type="number"
          value={ft ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches ?? 0))}
          className="input w-14"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(ft ?? 0, Number(e.target.value) || 0))}
          className="input w-12"
          aria-label={`${label} inches`}
        />
        <span className="text-faint">in</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
      {label}
      <input
        type="number"
        value={fromFeet(feet, unit) ?? ""}
        placeholder="—"
        onChange={(e) => onChange(toFeet(Number(e.target.value) || 0, unit))}
        className="input w-16"
        aria-label={label}
      />
      <span className="text-faint">{unit}</span>
    </span>
  );
}
