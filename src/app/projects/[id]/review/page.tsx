"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { emptyPlan } from "@/lib/pipeline/empty-plan";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { fromFeet, ftInToFeet, feetToFtIn, toFeet } from "@/lib/units";
import { UNITS } from "@/lib/data";
import { ROOM_PALETTE, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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

  if (!project) return null;

  const plan = project.floorPlan;
  const rooms = plan?.rooms ?? [];
  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];
  const referenceImage = plan?.previewUrl;

  const goToDesign = () => router.push(`/projects/${id}/design`);

  const confirmDelete = (roomId: string) => {
    removeRoom(id, roomId);
    setPendingDeleteId(null);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Room Confirmation</h2>
          <p className="mt-1 text-sm text-muted">
            {rooms.length > 0
              ? `${rooms.length} room${rooms.length === 1 ? "" : "s"} found. Review and correct anything below.`
              : "No rooms yet. Add your first one below."}
          </p>
        </div>

        {referenceImage && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
            <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-grid bg-bg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceImage} alt="Uploaded floor plan" className="h-full w-full object-contain" />
            </div>
            <p className="text-xs text-muted">Your uploaded plan, for reference only.</p>
          </div>
        )}

        <div className="space-y-2.5">
          {rooms.map((room, i) => {
            const { doors, windows } = openingCounts(room);
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
                  {room.dimensionsEstimated && (
                    <span
                      className="inline-flex shrink-0 items-center text-warning"
                      title="Dimensions weren't printed on the plan — estimated as a default 10 x 10 ft. Please verify."
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

                <div className="mt-2.5 flex flex-wrap items-center gap-2.5 pl-6">
                  <select
                    value={room.type ?? ""}
                    onChange={(e) => updateRoom(id, room.id, { type: e.target.value || undefined })}
                    className="input w-40 shrink-0 cursor-pointer"
                    aria-label={`${room.name || "Room"} type`}
                  >
                    <option value="">Unset type</option>
                    {roomTypes.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>

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
        <select value={type} onChange={(e) => setType(e.target.value)} className="input w-36 shrink-0 cursor-pointer">
          <option value="">Type</option>
          {roomTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
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
  feet: number;
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
          value={ft}
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches))}
          className="input w-14"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches}
          onChange={(e) => onChange(ftInToFeet(ft, Number(e.target.value) || 0))}
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
        value={fromFeet(feet, unit)}
        onChange={(e) => onChange(toFeet(Number(e.target.value) || 0, unit))}
        className="input w-16"
        aria-label={label}
      />
      <span className="text-faint">{unit}</span>
    </span>
  );
}
