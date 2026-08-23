"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
  const confirmRooms = useVasto((s) => s.confirmRooms);
  const [addingRoom, setAddingRoom] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Set when the user clicks delete on a room that already has generated
  // images. The button stays clickable (an unclickable disabled button just
  // looks broken) but the click surfaces this message instead of deleting.
  const [deleteBlockedId, setDeleteBlockedId] = useState<string | null>(null);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  // Continue below is a router.push, not a <Link>, so it isn't covered by
  // Next's automatic viewport prefetch. Which of the two next steps applies
  // depends on project.planSkipped (goForward's own branch below), so warm
  // only the one this project will actually land on rather than both.
  const projectLoaded = !!project;
  const planSkipped = !!project?.planSkipped;
  useEffect(() => {
    if (!projectLoaded) return;
    router.prefetch(`/projects/${id}/${planSkipped ? "design" : "furnish"}`);
  }, [router, id, projectLoaded, planSkipped]);

  if (!project) return null;

  const plan = project.floorPlan;
  const rooms = plan?.rooms ?? [];
  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];
  // Derived live, not a stored flag — same reasoning as the per-room
  // dimensionsMissing check inside the room .map() below — so filling in a
  // box clears this list (and re-enables Continue, on a non-skipped plan)
  // on the very next render instead of it going stale.
  const roomsMissingDimensions = rooms.filter(
    (r) => r.width === undefined || r.height === undefined,
  );
  // plan.previewUrl (a blob: URL from the browser tab that did the upload,
  // see upload/page.tsx) only survives that one tab's lifetime — dead on any
  // reload or later visit for a project that never got a durable
  // meta.storageKey. imageFailed catches that (and any other load failure,
  // e.g. a since-deleted storage key) via onError below, so the panel
  // disappears instead of showing a permanently broken image icon.
  const referenceImage =
    imageFailed
      ? undefined
      : plan?.meta?.storageKey
        ? `/api/render?key=${encodeURIComponent(plan.meta.storageKey)}`
        : plan?.previewUrl;

  // The real "user confirmed their rooms" signal (see Project.roomsConfirmedAt
  // and computeDoneMap in workspace-frame.tsx) — set here, on Continue, not on
  // mount, so just opening this page without proceeding doesn't count.
  //
  // A plan-skipped project has no greybox for any room, so Furnish has
  // nothing to arrange and its routes refuse to open (see furnish/page.tsx's
  // guard); Design is the next real step. confirmRooms still runs either way
  // — it records that the user confirmed their rooms, which is unrelated to
  // which step follows.
  //
  // The two branches also treat missing width/height differently, and
  // deliberately so:
  // - Not skipped: Furnish comes next and builds a real 3D greybox straight
  //   from each room's width/height. A fabricated dimension would silently
  //   corrupt that geometry, so this function never invents one — the
  //   Continue button below is disabled instead while any room is missing a
  //   dimension, so this branch is only ever reached once every room has
  //   both.
  // - Skipped: there's no Furnish step and no greybox at all for this
  //   project, so a fabricated dimension feeds into nothing — defaulting it
  //   is harmless, and blocking the user on a step they already opted out of
  //   buys nothing. So instead of disabling anything, every room still
  //   missing a dimension is defaulted to 10x10ft here before navigating.
  //   zustand's `set` is synchronous, so these resizeRoom calls are
  //   guaranteed to have landed by the time router.push runs below.
  const goForward = () => {
    if (project.planSkipped) {
      for (const room of roomsMissingDimensions) {
        const size: { width?: number; height?: number } = {};
        if (room.width === undefined) size.width = 10;
        if (room.height === undefined) size.height = 10;
        resizeRoom(id, room.id, size);
      }
    }
    confirmRooms(id);
    router.push(`/projects/${id}/${project.planSkipped ? "design" : "furnish"}`);
  };

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
              <img
                src={referenceImage}
                alt="Uploaded floor plan"
                className="h-full w-full object-contain"
                onError={() => setImageFailed(true)}
              />
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
                onError={() => setImageFailed(true)}
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
            // A room with at least one generated image can't be deleted here
            // anymore — deleting it would orphan real generated work, and
            // re-adding a room with the same name wouldn't restore it.
            const hasGenerations = (project.roomCards.find((c) => c.roomId === room.id)?.generations.length ?? 0) > 0;
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
                    title={hasGenerations ? "This room already has generated images and can't be deleted" : undefined}
                    aria-label={hasGenerations ? "This room already has generated images and can't be deleted" : "Delete room"}
                    onClick={() => {
                      if (hasGenerations) {
                        setDeleteBlockedId(room.id);
                      } else {
                        setDeleteBlockedId(null);
                        setPendingDeleteId(room.id);
                      }
                    }}
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

                {deleteBlockedId === room.id && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                    <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                    <span className="flex-1">
                      This room has already been generated and cannot be deleted.
                    </span>
                    <button
                      onClick={() => setDeleteBlockedId(null)}
                      className="cursor-pointer text-faint hover:text-foreground"
                    >
                      Dismiss
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
              projectId={id}
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

        <div className="mt-8 flex flex-col items-end gap-2">
          {roomsMissingDimensions.length > 0 && (
            project.planSkipped ? (
              <p className="text-right text-xs text-faint">
                Rooms without dimensions will use 10 × 10 ft:{" "}
                {roomsMissingDimensions.map((r) => r.name || "Unnamed room").join(", ")}.
              </p>
            ) : (
              <p className="flex items-center gap-1.5 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                Missing dimensions: {roomsMissingDimensions.map((r) => r.name || "Unnamed room").join(", ")}
              </p>
            )
          )}
          <Button
            iconRight="ArrowRight"
            disabled={rooms.length === 0 || (!project.planSkipped && roomsMissingDimensions.length > 0)}
            onClick={goForward}
          >
            {project.planSkipped ? "Continue to Design" : "Continue to Furnish"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Number input with a local string buffer, so it can hold intermediate
 * states ("", "-", a trailing-dot decimal like "0.") that don't parse to a
 * number without instantly stomping them. The old direct-controlled pattern
 * (`value={n}` with `onChange={(e) => onChange(Number(e.target.value) || 0)}`)
 * meant `Number("")` is 0, so clearing the box snapped it straight back to
 * "0" and select-all+retype landed on "01" instead of "1"; for decimals,
 * `Number("0.")` is also 0, so the field snapped mid-keystroke and "0.5" was
 * never reachable.
 *
 * `value` is the external, canonical number (or undefined for "not given
 * yet" — DimensionInline's blank-means-unset dimensions). The buffer resyncs
 * from it whenever it changes for a reason OTHER than this field's own edits
 * (unit switch rewriting the display, another field like ft/inches changing
 * the derived value) via React's documented "adjust state during render"
 * pattern — comparing a stored previous `value` and updating state inline —
 * rather than a useEffect, since a bare effect calling setState here would
 * both trip this repo's react-hooks/set-state-in-effect rule and flash the
 * stale buffer for one extra frame before the effect ran.
 *
 * Second-generation bug, now also fixed: with `min`/`max` in play (e.g.
 * `resizeRoom` in store.ts clamping width/height to `Math.max(2, ...)`),
 * typing "1" meaning to type "10" instantly became "2". `onChange` commits
 * on EVERY keystroke, so `onCommit(1)` fired immediately, the store clamped
 * it to 2, the external `value` prop changed to 2, and the render-phase
 * resync above — which used to run unconditionally — overwrote the buffer
 * the user was mid-keystroke into with "2" before they could type the next
 * digit. An external clamp in the store, plus a per-keystroke commit, plus
 * an unconditional render-phase resync, equals a field that fights the user
 * mid-word. The fix: track whether the field is focused, and skip the
 * buffer resync (though `prevValue` still updates, so the field doesn't
 * fall permanently out of sync once focus leaves) while it is. The buffer
 * only ever reconciles against the external value again on blur, which is
 * also why `onBlur` now resyncs from `value` rather than from the
 * locally-parsed number — the store, not the last keystroke, is the source
 * of truth for what the clamped value actually is.
 */
function BufferedNumberInput({
  value,
  onCommit,
  min,
  max,
  className,
  ariaLabel,
  placeholder = "—",
}: {
  value: number | undefined;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [buffer, setBuffer] = useState(value === undefined ? "" : String(value));
  const [prevValue, setPrevValue] = useState(value);
  // While the field has focus, an external value change (e.g. this same
  // field's own commit getting clamped by the store) must NOT overwrite
  // what the user is actively typing — see the doc comment above.
  const [focused, setFocused] = useState(false);
  if (value !== prevValue) {
    setPrevValue(value);
    if (!focused) {
      setBuffer(value === undefined ? "" : String(value));
    }
  }

  const clamp = (n: number) => {
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={buffer}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        setBuffer(raw);
        const n = Number(raw);
        // Only push a value up once the buffer is a complete, valid number.
        // "", "-", and partial decimals like "0." all fail Number.isFinite
        // (or, for "", get skipped outright) and stay purely local so the
        // user can keep typing instead of the field snapping mid-edit.
        if (raw !== "" && Number.isFinite(n)) {
          onCommit(clamp(n));
        }
      }}
      onBlur={() => {
        setFocused(false);
        // The store is the source of truth once the field loses focus, not
        // the locally-parsed buffer — onCommit above may have clamped to
        // something the buffer never displayed (typing "1" commits a
        // clamped 2 while the buffer still shows "1"). Resyncing from
        // `value` unconditionally here — the same fallback empty/unparseable
        // input used to take — is what makes the box end up showing what
        // the store actually holds instead of a stale pre-clamp digit.
        setBuffer(value === undefined ? "" : String(value));
      }}
      className={className}
      aria-label={ariaLabel}
    />
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
      <BufferedNumberInput
        value={value}
        min={0}
        max={20}
        onCommit={onChange}
        className="input w-14 text-center"
        ariaLabel={label}
        placeholder="0"
      />
    </span>
  );
}

function AddRoomForm({
  roomTypes,
  paletteIndex,
  projectId,
  onAdd,
  onCancel,
}: {
  roomTypes: string[];
  paletteIndex: number;
  projectId: string;
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
      {/* Manually added rooms have no wall/opening geometry read from the
          uploaded plan, so ensure-greybox-key.ts falls back to evenly
          spacing doors/windows along the walls (seedPlacedOpenings) rather
          than the positions extraction would have found. Not a bug, just a
          guess worth calling out before the user relies on it. */}
      <p className="text-xs text-muted">
        Rooms added here aren&apos;t on the uploaded plan, so their doors and windows will be
        evenly spaced guesses. You can reposition them in the{" "}
        <Link
          href={`/projects/${projectId}/plan`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Plan Editor
        </Link>
        .
      </p>
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
        <BufferedNumberInput
          value={ft}
          // inches ?? 0 reads the OTHER field's current value at commit time,
          // same as the original directly-controlled version did — editing ft
          // doesn't touch whatever's already in the inches box.
          onCommit={(v) => onChange(ftInToFeet(v, inches ?? 0))}
          className="input w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          ariaLabel={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <BufferedNumberInput
          value={inches}
          min={0}
          max={11}
          onCommit={(v) => onChange(ftInToFeet(ft ?? 0, v))}
          className="input w-16 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          ariaLabel={`${label} inches`}
        />
        <span className="text-faint">in</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
      {label}
      <BufferedNumberInput
        value={fromFeet(feet, unit)}
        onCommit={(v) => onChange(toFeet(v, unit))}
        className="input w-16"
        ariaLabel={label}
      />
      <span className="text-faint">{unit}</span>
    </span>
  );
}
