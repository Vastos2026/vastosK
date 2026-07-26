# Frontend Polish + Generate Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a batch of frontend polish items (copy, validation, room-type data, room-row layout, icon reuse, design-page visuals, colour-prompt fidelity) plus a backend latency fix and a rebuilt Generate page that auto-starts image generation the moment Design Planning finishes and shows a per-room loading animation instead of a manual click-to-generate flow.

**Architecture:** No new dependencies. The Generate rebuild's key architectural change: room-image generation calls move from being triggered by a click on the Generate page to being fired (fire-and-forget, in parallel) from the Design page's `confirm()` handler, immediately after Design Planning resolves and before navigation. A new non-persisted Zustand slice tracks "which rooms currently have a generation in flight" so the Generate page — which no longer owns the trigger — can render the right state (loading / image / error) purely from store data.

**Tech Stack:** Next.js App Router, Zustand, Tailwind utility classes (existing `.input`/`.glass`/`hover-lift` conventions), Lucide icons via the existing `Icon` registry.

## Global Constraints

- No em dashes in UI copy (existing project rule).
- Motion must be `transform`/`opacity` only (existing project rule, see `vasto-sweep`).
- No test runner exists in this repo — verify with `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- Every task's diff must leave `npm run build` passing (catches client/server-boundary issues `tsc` alone misses).
- Room type config files (`config/project-types/*.json`) are the only source of truth for room-type dropdowns and walkthrough order — never hardcode a room-type list in a component.
- The `Icon` component (`src/components/ui/icon.tsx`) only renders icons already imported into its `REGISTRY` — importing a new Lucide icon requires adding it to both the import list and `REGISTRY`.

---

### Task 1: Copy fix + duplicate project name validation

**Files:**
- Modify: `src/lib/data.ts:10` (PROPERTY_TYPES villa label)
- Modify: `src/components/new-project-modal.tsx`

**Interfaces:**
- No new exports. `NewProjectModal` already reads `useVasto((s) => s.projects)` indirectly via `createProject`; add a direct `useVasto((s) => s.projects)` read for the duplicate check.

- [ ] **Step 1: Rename the Villa label**

In `src/lib/data.ts`, line 10 currently reads:

```ts
  { id: "villa", label: "Villa", description: "Independent houses & bungalows", icon: "Home" },
```

Change `label` to match the welcome screen's existing wording (`src/components/welcome-screen.tsx:10` already says `"Residential Home"` for the same property type — this is the only other place the label appears, so match it exactly for consistency):

```ts
  { id: "villa", label: "Residential Home", description: "Independent houses & bungalows", icon: "Home" },
```

- [ ] **Step 2: Add duplicate-name detection to the New Project modal**

In `src/components/new-project-modal.tsx`, add a `projects` read and a duplicate check. Full updated file:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { PROPERTY_TYPES } from "@/lib/data";
import { useVasto } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { PropertyType } from "@/lib/types";

export function NewProjectModal({
  open,
  onClose,
  initialType = "apartment",
  /** Skip re-asking the property type — the welcome screen's category cards
   *  already collected it; re-showing the same picker one screen later was
   *  a redundant step. A "Change" link still reveals it if needed. */
  lockType = false,
}: {
  open: boolean;
  onClose: () => void;
  initialType?: PropertyType;
  lockType?: boolean;
}) {
  const router = useRouter();
  const projects = useVasto((s) => s.projects);
  const createProject = useVasto((s) => s.createProject);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>(initialType);
  const [showPicker, setShowPicker] = useState(!lockType);
  const chosen = PROPERTY_TYPES.find((p) => p.id === type);

  const trimmedName = name.trim();
  const isDuplicate =
    trimmedName.length > 0 &&
    projects.some((p) => p.name.trim().toLowerCase() === trimmedName.toLowerCase());

  const submit = () => {
    if (!trimmedName || isDuplicate) return;
    const id = createProject(trimmedName, type);
    onClose();
    setName("");
    setType(initialType);
    setShowPicker(!lockType);
    router.push(`/projects/${id}/floor-plan`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description={lockType ? "Name your project to get started." : "Name your project and choose a property type to get started."}
    >
      <div className="space-y-5 px-6 py-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Project name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Prestige Lakeside Villa"
            className={cn(
              "w-full rounded-lg border bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint",
              isDuplicate
                ? "border-danger/60 focus:border-danger focus:ring-2 focus:ring-danger/20"
                : "border-border focus:border-accent/60 focus:ring-2 focus:ring-accent/20",
            )}
          />
          {isDuplicate && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-danger">
              <Icon name="CircleAlert" className="size-3.5 shrink-0" />
              You already have a project named &quot;{trimmedName}&quot;. Choose a different name.
            </p>
          )}
        </div>

        {!showPicker && chosen ? (
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 p-3">
            <span className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/20 text-accent">
                <Icon name={chosen.icon} className="size-[18px]" />
              </span>
              <span>
                <span className="block text-sm font-medium">{chosen.label}</span>
                <span className="block text-xs text-muted">{chosen.description}</span>
              </span>
            </span>
            <button
              onClick={() => setShowPicker(true)}
              className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline cursor-pointer"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Property type</label>
            <div className="grid grid-cols-2 gap-2.5">
              {PROPERTY_TYPES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setType(p.id)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer hover:-translate-y-0.5",
                    type === p.id
                      ? "border-accent/60 bg-accent/10"
                      : "border-border bg-surface-2 hover:border-border-strong",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-lg",
                      type === p.id ? "bg-accent/20 text-accent" : "bg-surface-3 text-muted",
                    )}
                  >
                    <Icon name={p.icon} className="size-[18px]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.label}</span>
                    <span className="block truncate text-xs text-muted">{p.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} iconRight="ArrowRight" disabled={!trimmedName || isDuplicate}>
          Create project
        </Button>
      </div>
    </Modal>
  );
}
```

Note the behavior change from the original: `submit()` used to fall back to `"Untitled Project"` when the name was empty (`name.trim() || "Untitled Project"`). The button is now `disabled` when the name is empty, so that fallback path is unreachable — remove it (already removed above, `submit` now no-ops if `!trimmedName`).

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit`. Then manually: open the New Project modal, create a project named "Test", close, reopen and type "Test" again — the field should show the red border + warning and the Create button should be disabled. Typing a different name should clear both.

- [ ] **Step 4: Commit**

```bash
git add src/lib/data.ts src/components/new-project-modal.tsx
git commit -m "feat: rename Villa label, warn + block on duplicate project name"
```

---

### Task 2: Add missing room types to project-type configs

**Files:**
- Modify: `config/project-types/residential.json`
- Modify: `config/project-types/apartment.json`

**Interfaces:** None — pure data files, already consumed by `getProjectTypeConfig`/`orderRoomsForWalkthrough` (`src/lib/project-types/config.ts`), no code changes needed.

- [ ] **Step 1: Expand residential.json**

Replace the file's `roomTypes` and `walkthroughOrder` arrays (adds "Store Room", "Guest Room", "Foyer" — "Pooja Room" and "Garage" already present):

```json
{
  "category": "Residential",
  "label": "Individual Home",
  "planningPersona": "Residential",
  "subcategories": ["Independent House", "Villa", "Farmhouse", "Duplex"],
  "roomTypes": [
    "Living Room",
    "Dining Room",
    "Master Bedroom",
    "Bedroom",
    "Guest Room",
    "Kitchen",
    "Bathroom",
    "Study",
    "Pooja Room",
    "Foyer",
    "Utility",
    "Store Room",
    "Balcony",
    "Garage"
  ],
  "walkthroughOrder": [
    "Foyer",
    "Living Room",
    "Dining Room",
    "Kitchen",
    "Master Bedroom",
    "Bedroom",
    "Guest Room",
    "Study",
    "Pooja Room",
    "Bathroom",
    "Balcony",
    "Utility",
    "Store Room",
    "Garage"
  ]
}
```

- [ ] **Step 2: Expand apartment.json**

Replace the file's `roomTypes` and `walkthroughOrder` arrays (adds "Pooja Room", "Guest Room", "Foyer", "Store Room" — the reported gap):

```json
{
  "category": "Apartment",
  "label": "Apartment",
  "planningPersona": "Apartment",
  "subcategories": ["1BHK", "2BHK", "3BHK", "4BHK+", "Studio"],
  "roomTypes": [
    "Living Room",
    "Dining Room",
    "Master Bedroom",
    "Bedroom",
    "Guest Room",
    "Kitchen",
    "Bathroom",
    "Study",
    "Pooja Room",
    "Foyer",
    "Utility",
    "Store Room",
    "Balcony"
  ],
  "walkthroughOrder": [
    "Foyer",
    "Living Room",
    "Dining Room",
    "Kitchen",
    "Master Bedroom",
    "Bedroom",
    "Guest Room",
    "Study",
    "Pooja Room",
    "Bathroom",
    "Balcony",
    "Utility",
    "Store Room"
  ]
}
```

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit` (config is typed as `ProjectTypeConfig` on import, so a malformed JSON edit would fail the build, not tsc — also run `npm run build`). Manually: create a project as Apartment or Villa type, reach Room Confirmation, open the Type dropdown on any room, confirm "Pooja Room", "Guest Room", "Foyer", "Store Room" all appear.

- [ ] **Step 4: Commit**

```bash
git add config/project-types/residential.json config/project-types/apartment.json
git commit -m "feat: add Pooja Room, Guest Room, Foyer, Store Room to residential/apartment room types"
```

---

### Task 3: Room Confirmation row + Add Room form redesign

**Files:**
- Modify: `src/lib/store.ts` (new `setOpeningCount` action)
- Modify: `src/app/projects/[id]/review/page.tsx`

**Interfaces:**
- Produces: `setOpeningCount: (id: string, roomId: string, kind: "door" | "window", count: number) => void` on `VastoState` — adjusts `room.openings` to have exactly `count` entries of that `kind` (removing from the end when shrinking, appending generic `{ type: kind, side: "north", connectsTo: null }` entries when growing — a manually-entered count has no real wall position, "north" is a placeholder default, not a detection claim).
- Consumes: `RoomOpening`/`OpeningSide` from `src/lib/pipeline/assign-openings.ts` (already imported by `types.ts`).

- [ ] **Step 1: Add the `setOpeningCount` store action**

In `src/lib/store.ts`, add to the `VastoState` interface (near the other room-editing actions, after `resizeRoom`):

```ts
  /** Set the number of door/window openings on a room (Room Confirmation's editable count field) — pads with generic entries or truncates from the end. */
  setOpeningCount: (id: string, roomId: string, kind: "door" | "window", count: number) => void;
```

Add the implementation in the store body (after `resizeRoom`'s implementation, before `setStatus`):

```ts
      setOpeningCount: (id, roomId, kind, count) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            const room = p.floorPlan.rooms.find((r) => r.id === roomId);
            if (!room) return p;
            const target = Math.max(0, Math.round(count));
            const current = room.openings ?? [];
            const ofKind = current.filter((o) => o.type === kind);
            const others = current.filter((o) => o.type !== kind);
            let nextOfKind: typeof ofKind;
            if (ofKind.length > target) {
              nextOfKind = ofKind.slice(0, target);
            } else {
              nextOfKind = [
                ...ofKind,
                ...Array.from({ length: target - ofKind.length }, () => ({
                  type: kind,
                  side: "north" as const,
                  connectsTo: null,
                })),
              ];
            }
            const rooms = p.floorPlan.rooms.map((r) =>
              r.id === roomId ? { ...r, openings: [...others, ...nextOfKind] } : r,
            );
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms } });
          }),
        })),
```

(This sits inside the same `set()`-based action group as `resizeRoom` — match its existing style exactly, including the `touch()` wrapper and the `if (p.id !== id || !p.floorPlan) return p;` early-return pattern already used throughout this file.)

- [ ] **Step 2: Rewrite the Room Confirmation page**

Replace `src/app/projects/[id]/review/page.tsx` in full:

```tsx
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
```

What changed from the original, precisely:
- Each room row is now two lines: line 1 = swatch + full-width name input + estimated-size warning + delete button; line 2 (indented `pl-6` to align under the name) = type select, W/H dimension fields (already had `ft`/`in` unit labels via `DimensionInline`, unchanged), and the two new `OpeningCountField` editable number inputs replacing the old icon badges.
- Door/window badges (`Icon name="DoorClosed"` / `Icon name="Frame"` pill badges) are gone, replaced by `OpeningCountField` — a labelled, editable `<input type="number">` wired to the new `setOpeningCount` store action.
- The page-header `UnitSelect` is gone from the top; a single `UnitSelect` now sits directly above the Add Room button/form, right where dimension entry actually happens. Its internal markup changed from a bare `<select>` to a `<label>`-wrapped one with a visible "Units" text label (previously relied solely on `aria-label`, invisible on screen).
- `AddRoomForm`: the room-name input no longer sits alone on its own full-width row — it now shares a row with the Type select (`flex gap-2`, name `flex-1`, type `w-36`). Width/Height moved to their own row below, each now showing a `ft` unit suffix (previously bare numbers with only a placeholder hint).

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Manually: on Room Confirmation, confirm a room name up to ~40 characters is fully visible on its own line; confirm the Doors/Windows fields are editable number inputs that persist (reload the page — store is localStorage-persisted) and that editing them changes what `openingCounts()` reports; confirm the Units selector now appears just above "Add room", not at the top of the page; confirm the Add Room form's Name+Type share a row and Width/Height show "ft".

- [ ] **Step 4: Commit**

```bash
git add src/lib/store.ts "src/app/projects/[id]/review/page.tsx"
git commit -m "feat: redesign Room Confirmation row + Add Room form, editable door/window counts"
```

---

### Task 4: Icon consolidation — stop overloading Sparkles

**Files:**
- Modify: `src/lib/data.ts` (PROPERTY_TYPES "Custom" entry icon)
- Modify: `src/components/welcome-screen.tsx` (CATEGORIES "Custom" entry icon)
- Modify: `src/components/ui/badge.tsx` (`rendered` status icon)
- Modify: `src/app/projects/[id]/upload/page.tsx` (detecting-state icon, Analyze button icon)
- Modify: `src/app/projects/[id]/design/page.tsx` (Confirm & Plan Design button icon)

**Interfaces:** None — pure icon-name swaps, all icons used below (`Wand2`, `ScanLine`... see below) already exist or are added to the registry in Step 1.

- [ ] **Step 1: Register one new icon**

`ScanLine` isn't in the registry yet (needed for the upload "detecting" state — a scanning motif distinct from Sparkles). In `src/components/ui/icon.tsx`, add `ScanLine` to both the import list and `REGISTRY`:

```ts
import {
  LayoutDashboard, Plus, Search, Bell, Settings, ChevronRight, ChevronLeft,
  ChevronDown, MoreVertical, X, Check, Trash2, ArrowLeft, ArrowRight, Sparkles,
  Wand2, Download, Undo2, Redo2, Eye, Layers, Image as ImageIcon, Upload, FileUp,
  RotateCw, Move, Maximize2, Grid3x3, Box, Sun, Lasso, Palette, Camera,
  SlidersHorizontal, Pencil, Copy, GitCompare, History, Star, Clock, Loader2,
  CircleCheck, CircleDashed, CircleAlert, Building2, Home, Briefcase, Store,
  Armchair, Table, BedDouble, DoorClosed, Tv, BookOpen, Lamp, Lightbulb, Frame,
  Sprout, Flame, Sofa, Maximize, ZoomIn, ZoomOut, RefreshCw, Crop, Paintbrush,
  PanelsTopLeft, Ruler, Trash, ImagePlus, Clapperboard, ListChecks, EyeOff,
  LogOut, Mail, UserRound, ScanLine,
  type LucideIcon,
} from "lucide-react";

const REGISTRY: Record<string, LucideIcon> = {
  LayoutDashboard, Plus, Search, Bell, Settings, ChevronRight, ChevronLeft,
  ChevronDown, MoreVertical, X, Check, Trash2, ArrowLeft, ArrowRight, Sparkles,
  Wand2, Download, Undo2, Redo2, Eye, Layers, Image: ImageIcon, Upload, FileUp,
  RotateCw, Move, Maximize2, Grid3x3, Box, Sun, Lasso, Palette, Camera,
  SlidersHorizontal, Pencil, Copy, GitCompare, History, Star, Clock, Loader2,
  CircleCheck, CircleDashed, CircleAlert, Building2, Home, Briefcase, Store,
  Armchair, Table, BedDouble, DoorClosed, Tv, BookOpen, Lamp, Lightbulb, Frame,
  Sprout, Flame, Sofa, Maximize, ZoomIn, ZoomOut, RefreshCw, Crop, Paintbrush,
  PanelsTopLeft, Ruler, Trash, ImagePlus, Clapperboard, ListChecks, EyeOff,
  LogOut, Mail, UserRound, ScanLine,
};
```

- [ ] **Step 2: "Custom" category icon → Store**

`Store` is already imported/registered (see icon.tsx above) and reads clearly as a generic "other business" icon once it's no longer competing with Sparkles-as-magic elsewhere. In `src/lib/data.ts` line 14:

```ts
  { id: "commercial", label: "Custom", description: "Clinics, restaurants, retail & more", icon: "Store" },
```

In `src/components/welcome-screen.tsx`, update the `CATEGORIES` array's Custom entry and its now-stale comment:

```ts
const CATEGORIES: { type: PropertyType; label: string; icon: string }[] = [
  { type: "villa", label: "Residential Home", icon: "Home" },
  { type: "apartment", label: "Apartment", icon: "Building2" },
  { type: "office", label: "Commercial", icon: "Briefcase" },
  // "Custom" covers every business type that isn't an office — clinic,
  // restaurant, retail, temple, etc. (see config/project-types/custom.json)
  { type: "commercial", label: "Custom", icon: "Store" },
];
```

- [ ] **Step 3: "Rendered" status badge icon → CircleCheck**

In `src/components/ui/badge.tsx`, the `rendered` entry in `PROJECT_STATUS` (line 35) currently uses `"Sparkles"`. Every other terminal/success state in this same map (`RENDER_STATUS.completed`, line 56) already uses `"CircleCheck"` — match that existing convention instead of introducing a new one:

```ts
  rendered: { label: "Rendered", cls: "text-success border-success/30 bg-success/10", icon: "CircleCheck" },
```

- [ ] **Step 4: Upload page — detecting icon and Analyze button**

In `src/app/projects/[id]/upload/page.tsx`:

Line ~113-116 (the "detecting" state's status line) currently uses `Sparkles`:

```tsx
          <p className="flex items-center justify-center gap-2 text-sm font-medium">
            <Icon name="Sparkles" className="size-4 text-accent" />
            Reading your floor plan…
          </p>
```

Change to `ScanLine` (matches the scanning-sweep animation already in that panel):

```tsx
          <p className="flex items-center justify-center gap-2 text-sm font-medium">
            <Icon name="ScanLine" className="size-4 text-accent" />
            Reading your floor plan…
          </p>
```

Line ~191-193, the "Analyze floor plan" button currently uses `Sparkles`:

```tsx
              <Button icon="Sparkles" onClick={runDetection}>
                Analyze floor plan
              </Button>
```

Change to `ScanLine` (this is a read/extract action, not an image-generation action):

```tsx
              <Button icon="ScanLine" onClick={runDetection}>
                Analyze floor plan
              </Button>
```

- [ ] **Step 5: Design page — Confirm & Plan Design button**

In `src/app/projects/[id]/design/page.tsx`, line 240 currently uses `Sparkles`:

```tsx
          <Button icon="Sparkles" iconRight="ArrowRight" onClick={confirm} loading={busy} disabled={busy}>
            {busy ? "Planning the design…" : "Confirm & plan design"}
          </Button>
```

Change to `Wand2` (already registered, already used nowhere else in the app for a primary action — reads as "apply/transform", distinct from Sparkles' "generate an image" meaning):

```tsx
          <Button icon="Wand2" iconRight="ArrowRight" onClick={confirm} loading={busy} disabled={busy}>
            {busy ? "Planning the design…" : "Confirm & plan design"}
          </Button>
```

- [ ] **Step 6: Verify Sparkles' remaining footprint**

Run:

```bash
grep -rn '"Sparkles"' src
```

Expected remaining matches: only the two literal image-generation buttons — `src/app/projects/[id]/generate/page.tsx` (Generate button, will be replaced by Task 9's rebuild, leave as-is for now since Task 9 owns that file) and `src/app/projects/[id]/generate/[roomId]/page.tsx` (the lasso-edit Generate button). Everything else must be gone.

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/icon.tsx src/lib/data.ts src/components/welcome-screen.tsx src/components/ui/badge.tsx "src/app/projects/[id]/upload/page.tsx" "src/app/projects/[id]/design/page.tsx"
git commit -m "refactor: stop overloading the Sparkles icon, give each action its own icon"
```

---

### Task 5: Design page — drop Style colours, restyle Colour Palette, fix colour-prompt fidelity

**Files:**
- Modify: `src/lib/data.ts` (`COLOUR_PALETTES` gets a `description` field)
- Modify: `src/app/projects/[id]/design/page.tsx` (Style cards lose swatches, Colour Palette cards restyled, richer colour string sent to Design Planning)

**Interfaces:**
- Produces: `COLOUR_PALETTES[number].description: string` — consumed by `design/page.tsx`'s `confirm()` to build the string passed as `design.colourPalette`.

- [ ] **Step 1: Add descriptions to COLOUR_PALETTES**

In `src/lib/data.ts`, replace the `COLOUR_PALETTES` array:

```ts
/** Colour palette presets for the Design step's global colour picker. */
export const COLOUR_PALETTES: { id: string; label: string; swatch: string[]; description: string }[] = [
  { id: "Warm White", label: "Warm White", swatch: ["#f3ead3", "#c8a06a", "#7a5236"], description: "cream and warm white walls, honey oak tones, soft walnut brown accents" },
  { id: "Cool Grey", label: "Cool Grey", swatch: ["#e9e6e1", "#9c8c7c", "#3a3a3d"], description: "soft greige and cool grey surfaces, warm taupe accents, charcoal detailing" },
  { id: "Earthy Terracotta", label: "Earthy Terracotta", swatch: ["#e9d6b0", "#a8431f", "#3a1d12"], description: "sandy cream base, burnt terracotta orange accents, deep umber brown" },
  { id: "Deep Jewel", label: "Deep Jewel", swatch: ["#caa64a", "#3a2f5e", "#14110d"], description: "brushed gold accents, deep indigo-purple, near-black charcoal base" },
  { id: "Sage & Sand", label: "Sage & Sand", swatch: ["#e6e3d6", "#7fa08a", "#4f4a3a"], description: "warm sand base, muted sage green accents, deep olive-brown detailing" },
  { id: "Charcoal & Brass", label: "Charcoal & Brass", swatch: ["#d4972a", "#4f4f52", "#161616"], description: "near-black charcoal base, warm brass gold accents, mid-grey surfaces" },
];
```

- [ ] **Step 2: Style cards — drop the colour swatch strip**

In `src/app/projects/[id]/design/page.tsx`, the Style section (lines ~145-170) currently renders a `flex h-10` swatch strip above the name/tagline. Remove that strip entirely:

```tsx
        <Section title="Style">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => setStyleId(s.id)}
                className={cn(
                  "cursor-pointer rounded-2xl border p-3.5 text-left transition-colors",
                  s.id === styleId
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <p className="text-sm font-medium">{s.name}</p>
                <p className="mt-0.5 text-xs text-muted">{s.tagline}</p>
              </button>
            ))}
          </div>
        </Section>
```

(This removes the `overflow-hidden`/`group` classes and the `<div className="flex h-10 overflow-hidden">...palette swatches...</div>` block that used to sit above the text — the card is now text-only, matching the plain padded-card look used by the Luxury Level section right below it.)

- [ ] **Step 3: Colour Palette — restyle to match the (now-plain) card structure**

Replace the Colour Palette section so its cards use the same vertical card structure as Style/Luxury Level (full-width clickable card, swatch strip as a small header block, not an inline row):

```tsx
        <Section title="Colour palette">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {COLOUR_PALETTES.map((c) => (
              <button
                key={c.id}
                onClick={() => setColourPalette(c.id)}
                className={cn(
                  "group cursor-pointer overflow-hidden rounded-2xl border text-left transition-colors",
                  c.id === colourPalette
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <div className="flex h-10 overflow-hidden">
                  {c.swatch.map((sw, i) => (
                    <div key={i} className="flex-1" style={{ background: sw }} />
                  ))}
                </div>
                <div className="p-3">
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.description}</p>
                </div>
              </button>
            ))}
          </div>
        </Section>
```

This is now visually identical in structure to the Style cards used to be (swatch header block + padded text body), just kept only on the section where colour information is actually decision-relevant.

- [ ] **Step 4: Pass the richer colour description into Design Planning**

In the same file, `confirm()` currently sends `design: { style: style.name, luxuryLevel, colourPalette }` where `colourPalette` is the bare id/label (e.g. `"Warm White"`). Find the matching palette and compose a descriptive string instead. Update the top of `confirm()`:

```ts
  const confirm = async () => {
    if (busy) return;
    if (!subcategory.trim()) {
      setError("Choose or enter a project subcategory.");
      return;
    }
    const palette = COLOUR_PALETTES.find((c) => c.id === colourPalette) ?? COLOUR_PALETTES[0];
    setBusy(true);
    setError(null);
    try {
      const { universalInput, designSpec } = await runDesignPlan({
        projectId: id,
        category,
        subcategory,
        rooms: rooms.map((r) => ({
          name: r.name,
          widthFt: r.width,
          heightFt: r.height,
          additionalNotes: additionalRequirements.trim() || undefined,
          openings: r.openings,
        })),
        design: {
          style: style.name,
          luxuryLevel,
          colourPalette: `${palette.label} (${palette.description})`,
        },
      });
```

The rest of `confirm()` is unchanged — `setDesignPlan` still stores the plain `colourPalette` id (not the composite string) so the Colour Palette card selection state survives a reload correctly; only the string sent to `runDesignPlan` (and therefore into the AI prompt via `colour_palette`) is enriched.

- [ ] **Step 5: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Manually: on the Design page, confirm Style cards show only name + tagline (no colour strip), confirm Colour Palette cards now look like small versions of the Style cards (swatch header + text body, not an inline row), confirm selecting a colour palette and running Confirm & Plan Design still works end to end (check the server log / a debugger to see `colour_palette` in the assembled prompt now reads like `"Warm White (cream and warm white walls, honey oak tones, soft walnut brown accents)"` rather than just `"Warm White"`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/data.ts "src/app/projects/[id]/design/page.tsx"
git commit -m "feat: drop Style card colours, restyle Colour Palette cards, enrich colour prompt fidelity"
```

---

### Task 6: Design Planning latency — minimal thinking

**Files:**
- Modify: `src/lib/ai/provider.ts` (`generateStructured`)

**Interfaces:** None — internal call-site change only, `generateStructured<T>(prompt, schema, ctx)`'s public signature is unchanged.

- [ ] **Step 1: Add `thinkingBudget: 0` to the design-planning Gemini call**

In `src/lib/ai/provider.ts`, `generateStructured` (around line 355-368) currently calls `generateJson` with only `temperature` and `responseSchema`:

```ts
export async function generateStructured<T>(
  prompt: string,
  schema: object,
  ctx?: CallContext,
): Promise<T> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  return instrumented("planning", model, ctx, async () => {
    const parts: GeminiPart[] = [{ text: prompt }];
    const out = await generateJson<T>(parts, { temperature: 0.4, responseSchema: schema });
    if (out === null) throw new ProviderError("AiProviderError", "structured generation failed");
    return out;
  });
}
```

With no `thinkingBudget` set, Gemini uses its model default thinking level — for the current default model that's a non-trivial amount of extra reasoning before it starts producing the (already schema-constrained) structured output, on top of a fairly large prompt (the whole `UniversalInput` JSON). The Design Planning call is exactly this kind of schema-constrained structured generation that the extraction call already treats the same way — apply the same `thinkingBudget: 0` (translated per-model-generation by `gemini-client.ts`'s existing logic, no changes needed there):

```ts
export async function generateStructured<T>(
  prompt: string,
  schema: object,
  ctx?: CallContext,
): Promise<T> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  return instrumented("planning", model, ctx, async () => {
    const parts: GeminiPart[] = [{ text: prompt }];
    const out = await generateJson<T>(parts, {
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 8192,
      responseSchema: schema,
    });
    if (out === null) throw new ProviderError("AiProviderError", "structured generation failed");
    return out;
  });
}
```

`maxOutputTokens: 8192` is added defensively (Design Specification output includes one `roomGuidelines` entry per room — a large room count could otherwise hit the model's default cap and truncate, the same class of bug just fixed for extraction in `extractFloorPlan`). 8192 is generous for this schema's shape (7 short-to-medium prose fields + N short room guidance strings) without going as large as extraction's 65536, since a truncated Design Specification is a much smaller/simpler payload than a dense room list.

Note this function is generic — used by any future `generateStructured` caller, not just Design Planning. Confirm there is currently only the one caller (`design-planning.ts`'s `runDesignPlanning`) before applying this globally:

```bash
grep -rn "generateStructured(" src/lib
```

If a second caller exists that specifically needs full thinking (unlikely, but check), stop and flag it instead of applying this change — this task assumes Design Planning is the only caller of this function today.

- [ ] **Step 2: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Functional verification requires a real `GEMINI_API_KEY` and hitting "Confirm & plan design" — note in the task report whether that was possible in this environment; if not, this task's correctness rests on the type-check/build passing plus the fact that `extractFloorPlan` already proves this exact `thinkingBudget: 0` pattern works against the live API (verified end-to-end earlier this session).

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/provider.ts
git commit -m "perf: minimal thinking + output cap on Design Planning's Gemini call"
```

---

### Task 7: Rotating-dot generation loader component

**Files:**
- Create: `src/components/ui/generating-loader.tsx`
- Modify: `src/app/globals.css` (one new keyframe)

**Interfaces:**
- Produces: `<GeneratingLoader className?: string />` — a self-contained, purely decorative loading indicator (no props beyond `className`), reused by Task 9's Generate page.

- [ ] **Step 1: Add the orbit keyframe**

`globals.css` already has `vasto-spin` (simple 360° rotation) and `vasto-pulse` (opacity pulse) — reuse both rather than inventing new keyframes. Add one new keyframe for the dots' individual scale-pulse (distinct from `vasto-pulse`'s opacity-only pulse, so the dot animation reads as more physical/photographic rather than a flat blink) right after `vasto-pulse` in `src/app/globals.css`:

```css
@keyframes vasto-dot-pulse {
  0%, 100% { transform: scale(0.6); opacity: 0.35; }
  50% { transform: scale(1); opacity: 1; }
}
```

- [ ] **Step 2: Build the component**

Create `src/components/ui/generating-loader.tsx`:

```tsx
import { cn } from "@/lib/utils";

/**
 * A ring of dots that orbits (outer container spins via the existing
 * `vasto-spin` keyframe) while each dot individually scale-pulses on a
 * staggered delay — the "AI is generating an image" motif (ChatGPT-style),
 * built entirely from transform/opacity so it stays compositor-only.
 */
export function GeneratingLoader({ className }: { className?: string }) {
  const dots = Array.from({ length: 8 });
  return (
    <div className={cn("relative size-10", className)} role="status" aria-label="Generating">
      <div className="absolute inset-0 animate-[vasto-spin_2.4s_linear_infinite]">
        {dots.map((_, i) => {
          const angle = (360 / dots.length) * i;
          return (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
              style={{
                transform: `rotate(${angle}deg) translate(0, -16px)`,
                animation: `vasto-dot-pulse 1.2s ease-in-out ${(i / dots.length) * 1.2}s infinite`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
```

(Each dot's base position comes from an inline `transform: rotate(...) translate(...)` — inline styles because the angle/delay are per-index computed values, not fixed Tailwind classes; the outer container's spin and each dot's pulse are both plain CSS `animation`/Tailwind `animate-[...]`, so this never touches `top`/`left`/`width`/`height` per the project's transform/opacity-only motion rule.)

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. This component has no page wired to it yet (Task 9 does that) — verify by temporarily dropping `<GeneratingLoader />` into any page during a local check, or defer visual verification to Task 9's manual check. Note in the task report which you did.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/generating-loader.tsx src/app/globals.css
git commit -m "feat: add rotating-dot GeneratingLoader component"
```

---

### Task 8: Auto-fire room-image generation from Design Planning, track in-flight state

**Files:**
- Modify: `src/lib/store.ts` (new non-persisted `generatingRoomIds` slice + actions)
- Modify: `src/app/projects/[id]/design/page.tsx` (fire all room generations right after Design Planning resolves)

**Interfaces:**
- Produces on `VastoState`: `generatingRoomIds: Record<string, string[]>` (projectId → array of roomIds currently generating), `startGenerating: (projectId: string, roomId: string) => void`, `stopGenerating: (projectId: string, roomId: string) => void`.
- Consumes (Task 9): `generatingRoomIds` to render the loading state per room; `useVasto.getState()` for the fire-and-forget calls issued outside a component's render (same pattern the codebase already uses — see `useVasto.getState().setStyle(...)` in `design/page.tsx`'s existing `confirm()`).

**Note:** `generatingRoomIds` is deliberately NOT part of the persisted state (`partialize` only keeps `projects`, see `store.ts`'s `persist()` config) — an in-flight generation is inherently a this-tab-this-session fact; if the page reloads mid-generation, the fetch is gone anyway and there's nothing meaningful to resume. Task 9 must treat "room has no card and is not in `generatingRoomIds`" as an error/empty state, not silently forever-loading.

- [ ] **Step 1: Add the in-flight tracking slice**

In `src/lib/store.ts`, add to the `VastoState` interface (after `setWalkthrough`):

```ts
  /** Rooms currently generating an image, per project — session-only, never persisted (see store.ts comment). */
  generatingRoomIds: Record<string, string[]>;
  startGenerating: (projectId: string, roomId: string) => void;
  stopGenerating: (projectId: string, roomId: string) => void;
```

Add `generatingRoomIds: {}` to the initial state object (right after `projects: [],`):

```ts
      projects: [],
      generatingRoomIds: {},
```

Add the two actions (after `setWalkthrough`'s implementation, before the closing `}),` of the store body):

```ts
      startGenerating: (projectId, roomId) =>
        set((s) => {
          const existing = s.generatingRoomIds[projectId] ?? [];
          if (existing.includes(roomId)) return s;
          return { generatingRoomIds: { ...s.generatingRoomIds, [projectId]: [...existing, roomId] } };
        }),

      stopGenerating: (projectId, roomId) =>
        set((s) => {
          const existing = s.generatingRoomIds[projectId];
          if (!existing) return s;
          return {
            generatingRoomIds: {
              ...s.generatingRoomIds,
              [projectId]: existing.filter((id) => id !== roomId),
            },
          };
        }),
```

Update `partialize` (it must keep only persisting `projects` — no change needed to the function itself since it already does `partialize: (s) => ({ projects: s.projects })`, which naturally excludes `generatingRoomIds`; just confirm this by reading the existing `partialize` line — do not add `generatingRoomIds` to it).

- [ ] **Step 2: Fire all room generations from the Design page's confirm handler**

In `src/app/projects/[id]/design/page.tsx`, `confirm()` currently ends with `setDesignPlan(...)`, `useVasto.getState().setStyle(...)`, `useVasto.getState().setStatus(...)`, then `router.push('/generate')`. Insert the fire-and-forget generation loop right after `setDesignPlan` and before the navigation. Full updated `confirm()`:

```tsx
  const confirm = async () => {
    if (busy) return;
    if (!subcategory.trim()) {
      setError("Choose or enter a project subcategory.");
      return;
    }
    const palette = COLOUR_PALETTES.find((c) => c.id === colourPalette) ?? COLOUR_PALETTES[0];
    setBusy(true);
    setError(null);
    try {
      const { universalInput, designSpec } = await runDesignPlan({
        projectId: id,
        category,
        subcategory,
        rooms: rooms.map((r) => ({
          name: r.name,
          widthFt: r.width,
          heightFt: r.height,
          additionalNotes: additionalRequirements.trim() || undefined,
          openings: r.openings,
        })),
        design: {
          style: style.name,
          luxuryLevel,
          colourPalette: `${palette.label} (${palette.description})`,
        },
      });
      setDesignPlan(id, {
        subcategory,
        luxuryLevel,
        colourPalette,
        additionalRequirements: additionalRequirements.trim() || undefined,
        universalInput,
        designSpec,
      });
      useVasto.getState().setStyle(id, styleId);
      useVasto.getState().setStatus(id, "designing");

      // Fire every room's first image generation now, in parallel, so it's
      // already in flight before the user even sees the Generate page — not
      // awaited: the Generate page (rebuilt in a later task) reads progress
      // from the store (generatingRoomIds + roomCards), not from this promise.
      for (const room of rooms) {
        useVasto.getState().startGenerating(id, room.id);
        generateRoomImage({
          projectId: id,
          universalInput,
          room: {
            name: room.name,
            size: `${room.width} x ${room.height} ft`,
            additional_notes: universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes,
            openings: room.openings,
          },
          designSpec,
        })
          .then((gen) => {
            useVasto.getState().addGeneration(id, room.id, {
              id: uid("gen"),
              createdAt: new Date().toISOString(),
              imageUrl: gen.imageUrl,
              imageKey: gen.key,
              prompt: gen.prompt,
            });
          })
          .catch((e) => {
            console.warn(`[generate] room "${room.name}" failed:`, e instanceof Error ? e.message : e);
          })
          .finally(() => {
            useVasto.getState().stopGenerating(id, room.id);
          });
      }

      router.push(`/projects/${id}/generate`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Design planning failed");
    } finally {
      setBusy(false);
    }
  };
```

Add the two new imports this needs at the top of the file:

```ts
import { runDesignPlan, generateRoomImage } from "@/lib/design-plan-client";
import { uid } from "@/lib/utils";
```

(`runDesignPlan` was already imported; add `generateRoomImage` alongside it, and add the new `uid` import.)

A failed generation (`.catch`) is deliberately swallowed here rather than surfacing an error on the Design page (which has already navigated away by the time most of these settle) — Task 9's Generate page must treat "room has no card and is not in `generatingRoomIds`" as that room's failure state and offer a retry, per the note in Task 8's Interfaces section above.

- [ ] **Step 3: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Functional verification needs a real `GEMINI_API_KEY` (image generation) — if unavailable in this environment, verify structurally: confirm `startGenerating`/`stopGenerating` type-check against the store, confirm the loop's shape matches the existing manual-generate call it's modeled on (`src/app/projects/[id]/generate/page.tsx`'s current `onGenerate` handler — same `generateRoomImage` input shape, same `addGeneration` call shape), and note in the task report that live-API verification was skipped and why.

- [ ] **Step 4: Commit**

```bash
git add src/lib/store.ts "src/app/projects/[id]/design/page.tsx"
git commit -m "feat: auto-fire all room image generations from Design Planning completion"
```

---

### Task 9: Rebuild the Generate page — per-room sections, no manual first-click

**Files:**
- Modify: `src/app/projects/[id]/generate/page.tsx`

**Interfaces:**
- Consumes: `GeneratingLoader` (Task 7), `generatingRoomIds` (Task 8), existing `generateRoomImage`/`addGeneration` for the "Generate More" action (unchanged mechanism, new visual treatment).

- [ ] **Step 1: Rewrite the Generate page**

Replace `src/app/projects/[id]/generate/page.tsx` in full:

```tsx
"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { generateRoomImage } from "@/lib/design-plan-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GeneratingLoader } from "@/components/ui/generating-loader";
import { uid, cn } from "@/lib/utils";
import type { Room, RoomCard } from "@/lib/types";

/**
 * Room Generation Gallery (rebuilt) — one SECTION per room. Each section has
 * a hero card (the latest generation, or a loading/error state) and a
 * "Generate More" card beside it. The first generation for every room is
 * fired automatically from the Design page the moment Design Planning
 * finishes (see design/page.tsx's confirm()) — this page only ever reads
 * progress from the store, it never itself triggers a room's FIRST image.
 */
export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);
  const generatingIds = useVasto((s) => s.generatingRoomIds[id] ?? []);
  const startGenerating = useVasto((s) => s.startGenerating);
  const stopGenerating = useVasto((s) => s.stopGenerating);

  if (!project) return null;

  const rooms = project.floorPlan?.rooms ?? [];

  if (!project.floorPlan || rooms.length === 0) {
    return (
      <EmptyState
        icon="Ruler"
        text="Confirm your rooms first."
        href={`/projects/${id}/review`}
        cta="Go to Room Confirmation"
      />
    );
  }
  if (!project.universalInput || !project.designSpec) {
    return (
      <EmptyState
        icon="Palette"
        text="Plan the design first."
        href={`/projects/${id}/design`}
        cta="Go to Design"
      />
    );
  }

  const universalInput = project.universalInput;
  const designSpec = project.designSpec;
  const cardOf = (roomId: string) => project.roomCards.find((c) => c.roomId === roomId);
  const allHaveImages = rooms.every((r) => (cardOf(r.id)?.generations.length ?? 0) > 0);

  const generateMore = async (room: Room, note?: string) => {
    startGenerating(id, room.id);
    try {
      const gen = await generateRoomImage({
        projectId: id,
        universalInput,
        room: {
          name: room.name,
          size: `${room.width} x ${room.height} ft`,
          additional_notes: [universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes, note]
            .filter(Boolean)
            .join(". ") || undefined,
          openings: room.openings,
        },
        designSpec,
      });
      addGeneration(id, room.id, {
        id: uid("gen"),
        createdAt: new Date().toISOString(),
        imageUrl: gen.imageUrl,
        imageKey: gen.key,
        prompt: gen.prompt,
        note,
      });
    } finally {
      stopGenerating(id, room.id);
    }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Generate</h2>
            <p className="mt-1 text-sm text-muted">
              One image per room, same design language throughout.
            </p>
          </div>
          <Link href={`/projects/${id}/approve`}>
            <Button iconRight="ArrowRight" disabled={!allHaveImages}>
              Continue to Approval
            </Button>
          </Link>
        </div>
        <p className="mb-8 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Sizes can appear a little larger or smaller than expected — confirm with the sq ft
          figure for accuracy.
        </p>

        <div className="space-y-10">
          {rooms.map((room) => (
            <RoomSection
              key={room.id}
              room={room}
              card={cardOf(room.id)}
              generating={generatingIds.includes(room.id)}
              onGenerateMore={(note) => generateMore(room, note)}
              onRetryFirst={() => generateMore(room)}
              onView={() => router.push(`/projects/${id}/generate/${room.id}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomSection({
  room,
  card,
  generating,
  onGenerateMore,
  onRetryFirst,
  onView,
}: {
  room: Room;
  card?: RoomCard;
  generating: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
  onRetryFirst: () => Promise<void>;
  onView: () => void;
}) {
  const latest = card?.generations.at(-1);
  const failed = !latest && !generating;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-lg font-semibold tracking-tight">{room.name}</h3>
        <p className="text-xs text-muted">
          {Math.round(room.width)} × {Math.round(room.height)} ft
          {card && card.generations.length > 1 && ` · ${card.generations.length} versions`}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <HeroCard room={room} latest={latest} generating={generating && !latest} failed={failed} onRetry={onRetryFirst} onView={onView} />
        <GenerateMoreCard disabled={!latest} onGenerateMore={onGenerateMore} />
      </div>
    </section>
  );
}

function HeroCard({
  room,
  latest,
  generating,
  failed,
  onRetry,
  onView,
}: {
  room: Room;
  latest?: RoomCard["generations"][number];
  generating: boolean;
  failed: boolean;
  onRetry: () => Promise<void>;
  onView: () => void;
}) {
  return (
    <div className="hover-lift group relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-surface">
      {latest ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={latest.imageUrl}
            alt={room.name}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <button
            onClick={onView}
            className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-all duration-200 hover:bg-black/50 group-hover:opacity-100 cursor-pointer"
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium backdrop-blur">
              <Icon name="Eye" className="size-4 text-accent" /> Tap to View or Edit
            </span>
          </button>
        </>
      ) : generating ? (
        <div className="absolute inset-0 grid place-items-center bg-grid">
          <div className="flex flex-col items-center gap-3">
            <GeneratingLoader />
            <p className="text-xs text-muted">Generating {room.name}…</p>
          </div>
        </div>
      ) : failed ? (
        <div className="absolute inset-0 grid place-items-center bg-grid">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <Icon name="CircleAlert" className="size-6 text-danger" />
            <p className="text-xs text-muted">Generation failed.</p>
            <Button size="sm" variant="outline" icon="RefreshCw" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GenerateMoreCard({
  disabled,
  onGenerateMore,
}: {
  disabled: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onGenerateMore(note.trim() || undefined);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "relative aspect-[4/3] overflow-hidden rounded-2xl border border-dashed border-border bg-surface/40 transition-opacity",
        disabled && "opacity-40",
      )}
    >
      {busy ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <GeneratingLoader />
            <p className="text-xs text-muted">Generating another version…</p>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
          <Icon name="RefreshCw" className="size-6 text-faint" />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            disabled={disabled}
            placeholder="Other requirements for this version, e.g. make it brighter"
            className="input w-full resize-none text-xs disabled:cursor-not-allowed"
          />
          {error && <p className="text-[11px] text-danger">{error}</p>}
          <Button size="sm" variant="outline" disabled={disabled} onClick={run}>
            Generate More
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon, text, href, cta }: { icon: string; text: string; href: string; cta: string }) {
  return (
    <div className="grid h-full place-items-center text-center">
      <div>
        <Icon name={icon} className="mx-auto size-8 text-faint" />
        <p className="mt-3 text-sm text-muted">{text}</p>
        <Link href={href}>
          <Button className="mt-4" variant="outline">{cta}</Button>
        </Link>
      </div>
    </div>
  );
}
```

What changed from the original, precisely:
- The small `size-10` colour-tinted square placeholder (`<span style={{ background: room.color, opacity: 0.4 }} />`) is gone entirely.
- The old single `RoomCardTile` grid (one card per room, "Generate" button shown until the first image exists) is replaced by `RoomSection` — one full-width section per room with an `<h3>{room.name}</h3>` heading, containing exactly two side-by-side cards: `HeroCard` (the generated image, or the `GeneratingLoader` while the auto-fired first generation is in flight, or a Retry button if it failed) and `GenerateMoreCard` (the dashed, lower-opacity card — `opacity-40` until a hero image exists, per "less transparency" — that triggers additional versions, showing `GeneratingLoader` while busy).
- There is no manual "Generate" button for a room's first image anywhere on this page any more — that trigger moved entirely to Task 8's Design-page auto-fire. If a room's first generation fails, `HeroCard` shows a Retry button that calls the same `generateRoomImage` path (via `onRetryFirst`), not a different code path.
- `Sparkles` icon is gone from this file (Task 4 scoped it out of this file specifically because this task rewrites it) — no icon is used on the "Generate More" button; a plain `RefreshCw` glyph sits above the note field.

- [ ] **Step 2: Verify**

Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Manually (needs a working `GEMINI_API_KEY` to see real images; without one, verify the loading/failed states render correctly since every `generateRoomImage` call will reject): go from Design page's "Confirm & plan design" through to the Generate page, confirm each room renders as its own section with a heading, confirm the hero card shows `GeneratingLoader` immediately (not a colored square) for rooms still in flight, confirm a room whose auto-generation call rejects shows the Retry state, confirm "Generate More" is disabled (and dimmed) until a room has a hero image, and confirm clicking it shows the same rotating-dot loader inside its own card.

- [ ] **Step 3: Commit**

```bash
git add "src/app/projects/[id]/generate/page.tsx"
git commit -m "feat: rebuild Generate page as per-room sections with auto-start loading animation"
```

---

## Post-plan whole-branch review scope

The final whole-branch review (per subagent-driven-development) should pay particular attention to:
- Task 8 + Task 9's interface contract: `generatingRoomIds` semantics must exactly match what `HeroCard`/`GenerateMoreCard` expect (a room with no card and not in `generatingRoomIds` = failed, not still-loading).
- Confirm no other file still references the room-row icon badges removed in Task 3, or the pre-redesign `RoomCardTile` component name removed in Task 9 (search `grep -rn "RoomCardTile" src`).
- Confirm `grep -rn '"Sparkles"' src` returns only the two intentional survivors noted in Task 4 Step 6, now that Task 9 has also touched `generate/page.tsx`.
