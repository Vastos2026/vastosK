# Phase A — Openings End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can draw each room's real footprint over the uploaded plan image, place its doors/windows on its walls, and have the generated room image put those openings in the matching position — replacing today's word-only "a door on the south wall."

**Architecture:** A new `/projects/[id]/plan` step (between Upload and Room Confirmation) lets the user assign each extracted room a rectangle on the plan image and place/drag doors and windows on its edges. On "Continue," that geometry is derived into the existing `RoomOpening[]` shape (so every downstream consumer is untouched) and saved. The greybox renderer (already built in Phase 0) is hardened — closed doors, cleaner corners — and wired into `/api/generate-room-image` as a reference image alongside a strict geometry-preservation prompt clause.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, three.js (already added), Zustand store, Runware/Gemini via the existing provider layer.

**Spec:** `docs/superpowers/specs/2026-08-01-greybox-full-build-plan.md` (Phase A section) and `2026-08-01-greybox-opening-placement-design.md` (Phase 0 result, sections 2.1/2.2).

## Global Constraints

- No test runner in this repo (CLAUDE.md). Verification is `npx tsc --noEmit`, `npm run lint`, and direct dev-server observation via the preview tooling.
- `t` on every opening is measured in the plan's reading order — west→east on north/south walls, north→south on east/west walls — matching the convention already implemented and verified in `src/lib/greybox/build-scene.ts`'s `wallFrame`. The plan-editor geometry MUST use the identical convention, or a room's doors will land on the wrong side once rendered.
- A room with no `shape` must keep working exactly as it does today (text-only openings clause) — this is additive, not a migration.
- `prompt_templates` (Supabase, manually-applied SQL) is NOT touched in this phase — the strict geometry clause is a hardcoded constant in `prompt-builder.ts`, the same layer `describeOpenings` (also hardcoded, deterministic, non-persona text) already lives in. Only `builder.intro`/`cameraPrefix`/`negativePrefix` are template-driven; this clause is not persona wording, so it doesn't belong there.
- Reuse `distToSegment` from `src/lib/sketch/geometry.ts` rather than reimplementing point-to-segment distance.
- Greybox render size stays `1376x768` (16:9, matching `GEMINI_IMAGE_DIMENSIONS.sd` in `runware-client.ts`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/types.ts` (modify) | `PlacedOpening`, `Room.shape`/`placedOpenings`/`greyboxKey` |
| `src/lib/plan-editor/geometry.ts` (new) | Pure geometry: rect hit-testing/resize/move, wall hit-testing, opening clamping, `deriveOpenings` (adjacency → `RoomOpening[]`), `seedPlacedOpenings` (from extraction counts) |
| `src/lib/store.ts` (modify) | `applyPlanLayout` action |
| `src/components/project/plan-editor-canvas.tsx` (new) | The drawing surface — rooms, handles, openings. Same pattern as `sketch-canvas.tsx` |
| `src/app/projects/[id]/plan/page.tsx` (new) | The page: sidebar room list, canvas, Continue/Skip |
| `src/lib/nav.ts` (modify) | `PHASES` gains `"plan"` between upload and review |
| `src/lib/types.ts` (modify) | `Phase` gains `"plan"` |
| `src/components/project/workspace-frame.tsx` (modify) | `computeDoneMap`/`backHref` learn about `"plan"` |
| `src/app/projects/[id]/upload/page.tsx` (modify) | Both forward-navigation paths go to `/plan` instead of `/review` |
| `src/lib/greybox/build-scene.ts` (modify) | Closed door leaf + frame reveal; corner posts |
| `src/app/api/upload-greybox/route.ts` (new) | Client-rendered greybox PNG → storage key |
| `src/lib/projects/approved-rooms.ts` (modify) | `allProjectStorageKeys` learns about `room.greyboxKey` |
| `src/app/api/generate-room-image/route.ts` (modify) | Accepts `greyboxKey`, loads bytes, passes as a reference image |
| `src/lib/ai/prompting/prompt-builder.ts` (modify) | Strict geometry clause when a greybox is present; `cameraGuidelines` demoted |
| `src/app/spike/`, `src/app/api/spike-greybox/` (delete) | Throwaway Phase 0 scaffolding, no longer needed once A3 is visually verified |
| `src/proxy.ts` (modify) | Remove the `SPIKE_ENABLED` branch |

---

### Task 6: Data model + plan-editor geometry

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/plan-editor/geometry.ts`
- Modify: `src/lib/store.ts`

**Interfaces:**
- Produces: `PlacedOpening`, `Room.shape`/`placedOpenings`/`greyboxKey`; `EditorShape`, `ResizeHandle`, `deriveOpenings(rooms): Record<string, RoomOpening[]>`, `seedPlacedOpenings(openings: RoomOpening[]): PlacedOpening[]`, `moveShape`, `resizeShape`, `hitTestHandle`, `pointInShape`, `wallHitTest`, `clampOpeningSpan`; `useVasto.applyPlanLayout(id, rooms)`.

- [ ] **Step 1: Add the data model to `src/lib/types.ts`**

Add near the top (after the `Unit`/`Phase` exports), and extend `Room`:

```ts
import type { GreyboxWall } from "./greybox/types";

export type Phase = "upload" | "plan" | "review" | "design" | "generate" | "approve" | "walkthrough";

/** A door/window placed by hand on a room's wall in the Plan Editor. */
export interface PlacedOpening {
  id: string;
  type: "door" | "window";
  wall: GreyboxWall;
  /** 0..1 centre along the wall, in the plan's reading order (west->east on
   *  north/south, north->south on east/west) — MUST match build-scene.ts's
   *  wallFrame convention, or the greybox render will put this on the wrong side. */
  t: number;
  /** 0..1 fraction of the wall's length. */
  span: number;
}
```

Inside `Room`, add after `openings`:

```ts
  /**
   * Normalised [0,1] rect on the uploaded plan image — the Plan Editor's
   * output. Undefined until the user places this room there; a room without
   * one keeps using the text-only openings clause (see prompt-builder.ts).
   */
  shape?: { x: number; y: number; w: number; h: number };
  /**
   * Hand-placed doors/windows, the Plan Editor's source of truth once set.
   * `openings` above is DERIVED from this (see plan-editor/geometry.ts's
   * deriveOpenings) so every existing consumer (Room Confirmation's counts,
   * prompt-builder.ts) keeps reading the same shape it always has.
   */
  placedOpenings?: PlacedOpening[];
  /** Storage key of this room's rendered perspective greybox reference image. */
  greyboxKey?: string;
```

- [ ] **Step 2: Verify the `Phase` change compiles**

```bash
npx tsc --noEmit
```

Expected: FAILS — `nav.ts`'s `PHASES` array and `resumePhase` don't handle `"plan"` yet, and neither does `workspace-frame.tsx`'s `computeDoneMap` (both are `Record<Phase, ...>` / exhaustive). This is expected; those are fixed in Task 9. Confirm the errors are ONLY in those two files (`nav.ts`, `workspace-frame.tsx`) — if anything else errors, the `Room`/`PlacedOpening` additions themselves have a mistake.

- [ ] **Step 3: Write `src/lib/plan-editor/geometry.ts`**

```ts
/**
 * Pure geometry for the Plan Editor's canvas (src/components/project/
 * plan-editor-canvas.tsx) — rectangle hit-testing/move/resize, wall
 * hit-testing for placing openings, and the two conversions that make this
 * screen's output compatible with the rest of the app:
 *
 *   - deriveOpenings: PlacedOpening[] (position-based) -> RoomOpening[]
 *     (side + connectsTo) — the shape Room Confirmation, build-universal-input.ts
 *     and prompt-builder.ts already read.
 *   - seedPlacedOpenings: RoomOpening[] (Gemini's side-only guess, no
 *     position) -> PlacedOpening[] at reasonable default positions, so a
 *     newly-placed room starts with markers to drag into place instead of a
 *     blank room the user has to populate from scratch.
 *
 * Framework-free, like sketch/geometry.ts — this file only computes numbers,
 * the canvas component owns rendering and event handling.
 */

import { distToSegment, type Pt } from "@/lib/sketch/geometry";
import type { GreyboxWall } from "@/lib/greybox/types";
import type { PlacedOpening, RoomOpening } from "@/lib/types";

export interface EditorShape {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_SIZE = 0.04;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const OPPOSITE: Record<GreyboxWall, GreyboxWall> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

/** Default along-wall fraction for a newly-placed opening. */
const DEFAULT_SPAN: Record<PlacedOpening["type"], number> = { door: 0.12, window: 0.18 };

export function moveShape(shape: EditorShape, dx: number, dy: number): EditorShape {
  return {
    ...shape,
    x: clamp(shape.x + dx, 0, 1 - shape.w),
    y: clamp(shape.y + dy, 0, 1 - shape.h),
  };
}

/** Resizes from one of 8 handles, keeping the OPPOSITE edge fixed. */
export function resizeShape(shape: EditorShape, handle: ResizeHandle, dx: number, dy: number): EditorShape {
  let { x, y, w, h } = shape;
  if (handle.includes("e")) w = clamp(w + dx, MIN_SIZE, 1 - x);
  if (handle.includes("w")) {
    const newX = clamp(x + dx, 0, x + w - MIN_SIZE);
    w = w + (x - newX);
    x = newX;
  }
  if (handle.includes("s")) h = clamp(h + dy, MIN_SIZE, 1 - y);
  if (handle.includes("n")) {
    const newY = clamp(y + dy, 0, y + h - MIN_SIZE);
    h = h + (y - newY);
    y = newY;
  }
  return { x, y, w, h };
}

const HANDLE_POINTS = (s: EditorShape): { h: ResizeHandle; p: Pt }[] => [
  { h: "nw", p: [s.x, s.y] },
  { h: "n", p: [s.x + s.w / 2, s.y] },
  { h: "ne", p: [s.x + s.w, s.y] },
  { h: "e", p: [s.x + s.w, s.y + s.h / 2] },
  { h: "se", p: [s.x + s.w, s.y + s.h] },
  { h: "s", p: [s.x + s.w / 2, s.y + s.h] },
  { h: "sw", p: [s.x, s.y + s.h] },
  { h: "w", p: [s.x, s.y + s.h / 2] },
];

/** `tol` is in the SAME normalised units as `shape` — the caller converts a pixel tolerance once, per axis. */
export function hitTestHandle(shape: EditorShape, pt: Pt, tol: { x: number; y: number }): ResizeHandle | null {
  for (const { h, p } of HANDLE_POINTS(shape)) {
    if (Math.abs(pt[0] - p[0]) <= tol.x && Math.abs(pt[1] - p[1]) <= tol.y) return h;
  }
  return null;
}

export function pointInShape(shape: EditorShape, pt: Pt): boolean {
  return pt[0] >= shape.x && pt[0] <= shape.x + shape.w && pt[1] >= shape.y && pt[1] <= shape.y + shape.h;
}

/**
 * Absolute [x,y] of `wall`'s two endpoints, in the SAME reading-order
 * convention build-scene.ts's wallFrame uses: north/south run west->east,
 * east/west run north->south. Getting this wrong would place an opening on
 * the correct wall but mirrored along it once rendered.
 */
export function wallEndpoints(shape: EditorShape, wall: GreyboxWall): [Pt, Pt] {
  const { x, y, w, h } = shape;
  switch (wall) {
    case "north":
      return [[x, y], [x + w, y]];
    case "south":
      return [[x, y + h], [x + w, y + h]];
    case "west":
      return [[x, y], [x, y + h]];
    case "east":
      return [[x + w, y], [x + w, y + h]];
  }
}

export function openingPoint(shape: EditorShape, o: { wall: GreyboxWall; t: number }): Pt {
  const [a, b] = wallEndpoints(shape, o.wall);
  return [a[0] + (b[0] - a[0]) * o.t, a[1] + (b[1] - a[1]) * o.t];
}

function nearestWall(shape: EditorShape, p: Pt): { wall: GreyboxWall; dist: number } {
  let best: { wall: GreyboxWall; dist: number } | null = null;
  (["north", "south", "east", "west"] as GreyboxWall[]).forEach((wall) => {
    const [a, b] = wallEndpoints(shape, wall);
    const d = distToSegment(p, a, b);
    if (!best || d < best.dist) best = { wall, dist: d };
  });
  return best!;
}

/** `tol` is normalised (same units as the shape). Returns null when `pt` isn't within `tol` of any wall. */
export function wallHitTest(shape: EditorShape, pt: Pt, tol: number): { wall: GreyboxWall; t: number } | null {
  const { wall, dist } = nearestWall(shape, pt);
  if (dist > tol) return null;
  const [a, b] = wallEndpoints(shape, wall);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (len2 < 1e-12) return null;
  const t = clamp(((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / len2, 0, 1);
  return { wall, t };
}

/** Keeps an opening fully on its wall — same halfSpan-clamp shape as lib/openings.ts's snapToWall. */
export function clampOpeningSpan(t: number, span: number): { t: number; span: number } {
  const s = clamp(span, 0.04, 0.9);
  const half = s / 2;
  return { t: clamp(t, half, 1 - half), span: s };
}

/**
 * Resolves every room's placedOpenings into RoomOpening[] (side + connectsTo).
 * Hand-drawn rectangles rarely share an EXACT edge, so "connects to room B"
 * means: the opening's point sits within TOLERANCE of B's boundary AND B's
 * nearest wall there FACES this opening (north<->south, east<->west) — not
 * just "any nearby wall", which would also match a perpendicular room across
 * a corner.
 */
const CONNECT_TOLERANCE = 0.035;

export function deriveOpenings(
  rooms: { id: string; name: string; shape?: EditorShape; placedOpenings?: PlacedOpening[] }[],
): Record<string, RoomOpening[]> {
  const placed = rooms.filter((r): r is typeof r & { shape: EditorShape } => !!r.shape);
  const result: Record<string, RoomOpening[]> = {};
  for (const room of rooms) {
    if (!room.shape || !room.placedOpenings?.length) {
      result[room.id] = [];
      continue;
    }
    const shape = room.shape;
    result[room.id] = room.placedOpenings.map((o) => {
      const p = openingPoint(shape, o);
      let connectsTo: string | null = "exterior";
      for (const other of placed) {
        if (other.id === room.id) continue;
        const { wall: nearWall, dist } = nearestWall(other.shape, p);
        if (dist <= CONNECT_TOLERANCE && nearWall === OPPOSITE[o.wall]) {
          connectsTo = other.name.trim() || null;
          break;
        }
      }
      return { type: o.type, side: o.wall, connectsTo };
    });
  }
  return result;
}

/**
 * Seeds PlacedOpening[] from a room's EXTRACTION-time openings (Gemini's
 * side-only guess, no position) so a newly-placed room starts with draggable
 * markers instead of a blank wall — the user's job becomes "drag this to the
 * right spot," not "remember every door and window from scratch." Multiple
 * openings of the same type on the same wall are spread evenly so they don't
 * start stacked on top of each other.
 */
export function seedPlacedOpenings(openings: RoomOpening[]): PlacedOpening[] {
  const byWall = new Map<string, RoomOpening[]>();
  for (const o of openings) {
    const key = `${o.side}:${o.type}`;
    byWall.set(key, [...(byWall.get(key) ?? []), o]);
  }
  const out: PlacedOpening[] = [];
  let seq = 0;
  for (const [key, group] of byWall) {
    const [wall, type] = key.split(":") as [GreyboxWall, PlacedOpening["type"]];
    group.forEach((_, i) => {
      const t = (i + 1) / (group.length + 1);
      out.push({ id: `seed-${seq++}`, type, wall, t, span: DEFAULT_SPAN[type] });
    });
  }
  return out;
}
```

- [ ] **Step 4: Sanity-check the pure functions with a throwaway node script**

No test runner exists in this repo, so this is a manual, one-off check — not a permanent test file.

```bash
node -e "
const { deriveOpenings, seedPlacedOpenings, wallHitTest, resizeShape } = require('./src/lib/plan-editor/geometry.ts');
" 2>&1 | head -5
```

This will fail directly (`node` can't run `.ts`) — instead verify via `tsc` (below) plus a quick manual trace: with two adjacent rooms A `{x:0,y:0,w:0.5,h:0.5}` and B `{x:0.5,y:0,w:0.5,h:0.5}`, an opening on A's `east` wall at `t=0.5` should resolve `connectsTo` to B's name (B's nearest wall to that point is `west`, `OPPOSITE.east === "west"` ✓). Trace this by hand against the code above; if the logic reads correctly, proceed — Task 8's live canvas is the real verification.

- [ ] **Step 5: Add `applyPlanLayout` to the store**

In `src/lib/store.ts`, add to the `VastoState` interface (near `updateRoom`):

```ts
  /**
   * Bulk-replaces the plan's room list — the Plan Editor's "Continue".
   * Unlike setFloorPlan, this does NOT reset roomCards/designSpec/
   * universalInput/walkthrough: a user can revisit Plan after Generate has
   * already run (e.g. fixing one missed opening), and that must not wipe
   * paid generation work just because room geometry changed.
   */
  applyPlanLayout: (id: string, rooms: Room[]) => void;
```

And the implementation (near `updateRoom`'s):

```ts
      applyPlanLayout: (id, rooms) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms } });
          }),
        })),
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
```

Expected: same two pre-existing failures as Step 2 (`nav.ts`, `workspace-frame.tsx`) — `store.ts`, `types.ts` and the new `geometry.ts` must show NO errors.

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/plan-editor/geometry.ts src/lib/store.ts
git commit -m "feat: plan-editor data model and geometry helpers"
```

---

### Task 7: Route plumbing — new "plan" phase

**Files:**
- Modify: `src/lib/nav.ts`
- Modify: `src/components/project/workspace-frame.tsx`
- Modify: `src/app/projects/[id]/upload/page.tsx`

**Interfaces:**
- Consumes: `Phase` (Task 6).
- Produces: `/projects/[id]/plan` reachable from the stepper and from Upload; `resumePhase` unchanged (still resumes to `"review"` — see rationale below).

- [ ] **Step 1: Add `"plan"` to `PHASES` in `src/lib/nav.ts`**

```ts
export const PHASES: { id: Phase; label: string; icon: string }[] = [
  { id: "upload", label: "Upload", icon: "FileUp" },
  { id: "plan", label: "Plan", icon: "DoorClosed" },
  { id: "review", label: "Review", icon: "Ruler" },
  { id: "design", label: "Design", icon: "Palette" },
  { id: "generate", label: "Generate", icon: "Image" },
  { id: "approve", label: "Approve", icon: "ListChecks" },
  { id: "walkthrough", label: "Walkthrough", icon: "Clapperboard" },
];
```

`resumePhase` is deliberately left UNCHANGED — a returning user (status `"parsed"`) still resumes at `"review"`, the more common continuation point. The `"plan"` pill stays reachable any time from the stepper for anyone who wants to revisit it (openings are meant to be adjustable, per the design decision). Only first-time forward navigation (Task 7 Step 3) passes through it.

- [ ] **Step 2: Teach `workspace-frame.tsx` about `"plan"`**

In `computeDoneMap` (currently line ~23-32), add:

```ts
    plan: (project?.floorPlan?.rooms ?? []).some((r) => !!r.shape),
```

In the `backHref` IIFE (currently line ~54-61), add a case before the generic `PHASES` fallback:

```ts
    if (step === "plan") return `/projects/${params.id}/upload`;
```

And change the existing `review` case from `/upload` to `/plan`:

```ts
    if (step === "review") return `/projects/${params.id}/plan`;
```

- [ ] **Step 3: Route Upload's forward navigation through `/plan`**

In `src/app/projects/[id]/upload/page.tsx`, `runDetection`'s success path (currently `router.push(\`/projects/${id}/review\`)`) and `goManual` (currently the same) both change to:

```ts
router.push(`/projects/${id}/plan`);
```

The Plan page itself (Task 9) handles the case where there's no reference image to draw on (manual entry / unreadable) with its own empty state and a direct Continue button — so this one route change covers both paths without an upload-page branch.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
```

Expected: FAILS only on the still-missing `/app/projects/[id]/plan/page.tsx` import inside... actually there is no import yet (Link/router.push to a route that doesn't exist yet doesn't fail typecheck, Next resolves routes at runtime not compile time). Expected: **0 errors** — Task 6's two pre-existing failures are now fixed by this task's `nav.ts`/`workspace-frame.tsx` changes.

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nav.ts src/components/project/workspace-frame.tsx src/app/projects/[id]/upload/page.tsx
git commit -m "feat: wire the Plan phase into navigation"
```

---

### Task 8: Plan editor canvas component

**Files:**
- Create: `src/components/project/plan-editor-canvas.tsx`

**Interfaces:**
- Consumes: everything from `src/lib/plan-editor/geometry.ts` (Task 6).
- Produces:
  ```ts
  export interface EditorRoom {
    id: string;
    name: string;
    color: string;
    shape: EditorShape;
    placedOpenings: PlacedOpening[];
  }
  export interface PlanEditorCanvasProps {
    rooms: EditorRoom[];       // only PLACED rooms (have a shape)
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onShapeChange: (id: string, shape: EditorShape) => void;
    onOpeningsChange: (id: string, openings: PlacedOpening[]) => void;
  }
  ```

- [ ] **Step 1: Write the component**

Follows `sketch-canvas.tsx`'s established pattern: wrapping div + `<canvas>` + `ResizeObserver` + normalised `[0,1]` coordinates + render-on-state-change (no rAF loop — nothing here animates continuously).

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampOpeningSpan,
  hitTestHandle,
  moveShape,
  openingPoint,
  pointInShape,
  resizeShape,
  wallHitTest,
  type EditorShape,
  type ResizeHandle,
} from "@/lib/plan-editor/geometry";
import type { PlacedOpening } from "@/lib/types";
import type { Pt } from "@/lib/sketch/geometry";

/**
 * The Plan Editor's drawing surface. Renders room rectangles over the
 * uploaded plan image (the background image itself is rendered by the PARENT
 * page, behind this transparent canvas — see plan/page.tsx) and handles every
 * pointer interaction: select/move/resize a room, and place/drag/resize an
 * opening on the SELECTED room's walls.
 *
 * Follows sketch-canvas.tsx's wrapping-div + canvas + ResizeObserver +
 * normalized-[0,1] + render-on-state-change pattern.
 */

export interface EditorRoom {
  id: string;
  name: string;
  color: string;
  shape: EditorShape;
  placedOpenings: PlacedOpening[];
}

const DOOR_COLOR = "#e6c15c";
const WINDOW_COLOR = "#6da8e2";
const ACCENT = "#f2f2f2";
const HANDLE_PX = 7;
const WALL_HIT_PX = 12;
const OPENING_END_PX = 8;
const CLICK_SLOP_PX = 4;

type DragMode =
  | { kind: "move-room"; id: string; startShape: EditorShape; startPt: Pt }
  | { kind: "resize-room"; id: string; handle: ResizeHandle; startShape: EditorShape; startPt: Pt }
  | { kind: "move-opening"; roomId: string; openingId: string; startT: number; wallLenPx: number; startPt: Pt }
  | { kind: "resize-opening"; roomId: string; openingId: string; end: "a" | "b"; startPt: Pt }
  | null;

export function PlanEditorCanvas({
  rooms,
  selectedId,
  onSelect,
  onShapeChange,
  onOpeningsChange,
}: {
  rooms: EditorRoom[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onShapeChange: (id: string, shape: EditorShape) => void;
  onOpeningsChange: (id: string, openings: PlacedOpening[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const renderRef = useRef<() => void>(() => {});
  const dragRef = useRef<DragMode>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<Pt | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: r.width, h: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderRef.current();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);
      const px = (p: Pt): Pt => [p[0] * w, p[1] * h];

      for (const room of rooms) {
        const selected = room.id === selectedId;
        const { x, y, w: rw, h: rh } = room.shape;
        const [x0, y0] = px([x, y]);
        const [x1, y1] = px([x + rw, y + rh]);

        ctx.fillStyle = `${room.color}2e`;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.strokeStyle = room.color;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

        ctx.fillStyle = room.color;
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(room.name || "Room", x0 + 6, y0 + 5);

        if (selected) {
          for (const [hx, hy] of cornerAndEdgeHandles(room.shape).map(px)) {
            ctx.beginPath();
            ctx.arc(hx, hy, HANDLE_PX, 0, Math.PI * 2);
            ctx.fillStyle = ACCENT;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#0a0a0a";
            ctx.stroke();
          }
        }

        for (const o of room.placedOpenings) {
          const [ax, ay] = px(wallPointAt(room.shape, o, "a"));
          const [bx, by] = px(wallPointAt(room.shape, o, "b"));
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.lineWidth = 6;
          ctx.strokeStyle = o.type === "door" ? DOOR_COLOR : WINDOW_COLOR;
          ctx.stroke();
          if (selected) {
            ctx.beginPath();
            ctx.arc(ax, ay, 4, 0, Math.PI * 2);
            ctx.arc(bx, by, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#0a0a0a";
            ctx.fill();
          }
        }

        // Hover preview: where a click would add a new opening on the
        // selected room, if not currently over an existing one.
        if (selected && pointer) {
          const hit = wallHitTest(room.shape, pointer, WALL_HIT_PX / Math.max(w, h));
          const onExisting = room.placedOpenings.some(
            (o) => Math.hypot(...subPx(px(openingPoint(room.shape, o)), px(pointer))) < 14,
          );
          if (hit && !onExisting && !dragRef.current) {
            const [hx, hy] = px(openingPoint(room.shape, hit));
            ctx.beginPath();
            ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
    };
    renderRef.current = render;
    render();
  }, [rooms, selectedId, pointer]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const tolNorm = () => {
    const { w, h } = sizeRef.current;
    return { x: HANDLE_PX / Math.max(w, 1), y: HANDLE_PX / Math.max(h, 1) };
  };

  const selected = rooms.find((r) => r.id === selectedId) ?? null;

  return (
    <div ref={wrapRef} className="absolute inset-0 h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ cursor: dragRef.current ? "grabbing" : "default", touchAction: "none" }}
        onPointerMove={(e) => {
          const p = toNorm(e);
          setPointer(p);
          const drag = dragRef.current;
          if (!drag) return;
          const { w, h } = sizeRef.current;

          if (drag.kind === "move-room") {
            const dx = p[0] - drag.startPt[0];
            const dy = p[1] - drag.startPt[1];
            onShapeChange(drag.id, moveShape(drag.startShape, dx, dy));
          } else if (drag.kind === "resize-room") {
            const dx = p[0] - drag.startPt[0];
            const dy = p[1] - drag.startPt[1];
            onShapeChange(drag.id, resizeShape(drag.startShape, drag.handle, dx, dy));
          } else if (drag.kind === "move-opening") {
            const room = rooms.find((r) => r.id === drag.roomId);
            if (!room) return;
            const opening = room.placedOpenings.find((o) => o.id === drag.openingId);
            if (!opening) return;
            const hit = wallHitTest(room.shape, p, 1); // unconstrained tolerance while dragging along its own wall
            if (!hit || hit.wall !== opening.wall) return;
            const { t, span } = clampOpeningSpan(hit.t, opening.span);
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, t, span } : o)),
            );
          } else if (drag.kind === "resize-opening") {
            const room = rooms.find((r) => r.id === drag.roomId);
            if (!room) return;
            const opening = room.placedOpenings.find((o) => o.id === drag.openingId);
            if (!opening) return;
            const hit = wallHitTest(room.shape, p, 1);
            if (!hit || hit.wall !== opening.wall) return;
            // Dragging one end moves that end while the OTHER end stays put.
            const otherT = drag.end === "a" ? opening.t + opening.span / 2 : opening.t - opening.span / 2;
            const newT = (hit.t + otherT) / 2;
            const newSpan = Math.abs(hit.t - otherT);
            const { t, span } = clampOpeningSpan(newT, newSpan);
            onOpeningsChange(
              drag.roomId,
              room.placedOpenings.map((o) => (o.id === opening.id ? { ...o, t, span } : o)),
            );
          }
          void w;
          void h;
        }}
        onPointerLeave={() => setPointer(null)}
        onPointerDown={(e) => {
          const p = toNorm(e);
          downRef.current = { x: e.clientX, y: e.clientY };
          const { w, h } = sizeRef.current;

          if (selected) {
            // Opening end-handles take priority (finest-grained target).
            for (const o of selected.placedOpenings) {
              const a = wallPointAt(selected.shape, o, "a");
              const b = wallPointAt(selected.shape, o, "b");
              if (pxDist(a, p, w, h) <= OPENING_END_PX) {
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "a", startPt: p };
                return;
              }
              if (pxDist(b, p, w, h) <= OPENING_END_PX) {
                dragRef.current = { kind: "resize-opening", roomId: selected.id, openingId: o.id, end: "b", startPt: p };
                return;
              }
            }
            // Opening body — move it along its wall.
            for (const o of selected.placedOpenings) {
              const center = openingPoint(selected.shape, o);
              if (pxDist(center, p, w, h) <= 10) {
                dragRef.current = {
                  kind: "move-opening",
                  roomId: selected.id,
                  openingId: o.id,
                  startT: o.t,
                  wallLenPx: 0,
                  startPt: p,
                };
                return;
              }
            }
            // Resize handle.
            const handle = hitTestHandle(selected.shape, p, tolNorm());
            if (handle) {
              dragRef.current = { kind: "resize-room", id: selected.id, handle, startShape: selected.shape, startPt: p };
              return;
            }
            // Empty spot on the selected room's wall — will add a new
            // opening on pointerup if this turns out to be a click, not a drag.
          }

          // Room body (topmost match) — select, and prep a move-drag.
          for (let i = rooms.length - 1; i >= 0; i--) {
            const room = rooms[i];
            if (pointInShape(room.shape, p)) {
              onSelect(room.id);
              dragRef.current = { kind: "move-room", id: room.id, startShape: room.shape, startPt: p };
              return;
            }
          }
          onSelect(null);
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          const down = downRef.current;
          dragRef.current = null;
          downRef.current = null;
          if (!down) return;
          const movedPx = Math.hypot(e.clientX - down.x, e.clientY - down.y);
          if (movedPx > CLICK_SLOP_PX) return; // a real drag already applied its own changes

          // A plain click (no drag) on an existing opening cycles its type;
          // on empty wall of the selected room, adds a new door.
          if (!selected) return;
          const p = toNorm(e);
          const { w, h } = sizeRef.current;

          for (const o of selected.placedOpenings) {
            if (pxDist(openingPoint(selected.shape, o), p, w, h) <= 10) {
              const next =
                o.type === "door"
                  ? selected.placedOpenings.map((x) => (x.id === o.id ? { ...x, type: "window" as const } : x))
                  : selected.placedOpenings.filter((x) => x.id !== o.id);
              onOpeningsChange(selected.id, next);
              return;
            }
          }
          if (drag) return; // was a resize/handle interaction that didn't move enough to count as a drag
          const hit = wallHitTest(selected.shape, p, WALL_HIT_PX / Math.max(w, h));
          if (hit) {
            const { t, span } = clampOpeningSpan(hit.t, 0.12);
            onOpeningsChange(selected.id, [
              ...selected.placedOpenings,
              { id: `o-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: "door", wall: hit.wall, t, span },
            ]);
          }
        }}
      />
    </div>
  );
}

function cornerAndEdgeHandles(s: EditorShape): Pt[] {
  return [
    [s.x, s.y],
    [s.x + s.w / 2, s.y],
    [s.x + s.w, s.y],
    [s.x + s.w, s.y + s.h / 2],
    [s.x + s.w, s.y + s.h],
    [s.x + s.w / 2, s.y + s.h],
    [s.x, s.y + s.h],
    [s.x, s.y + s.h / 2],
  ];
}

function wallPointAt(shape: EditorShape, o: PlacedOpening, end: "a" | "b"): Pt {
  const t = end === "a" ? o.t - o.span / 2 : o.t + o.span / 2;
  return openingPoint(shape, { wall: o.wall, t: Math.max(0, Math.min(1, t)) });
}

function pxDist(a: Pt, b: Pt, w: number, h: number): number {
  return Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
}

function subPx(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
```

Expected: exit 0. If `wallHitTest(room.shape, p, 1)` (the "unconstrained tolerance while dragging" calls) reads oddly — it's intentional: once a drag has STARTED on a specific opening, the tolerance for continuing to track it along its own wall should be generous (the pointer can stray a bit off the exact wall line while dragging fast), unlike the tight `WALL_HIT_PX` tolerance used to detect the initial click.

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/project/plan-editor-canvas.tsx
git commit -m "feat: plan editor canvas — draw, resize, and place openings"
```

---

### Task 9: Plan editor page

**Files:**
- Create: `src/app/projects/[id]/plan/page.tsx`

**Interfaces:**
- Consumes: `PlanEditorCanvas`/`EditorRoom` (Task 8), `deriveOpenings`/`seedPlacedOpenings` (Task 6), `useVasto().applyPlanLayout` (Task 6), `ROOM_PALETTE`/`uid` (`@/lib/utils`).

- [ ] **Step 1: Write the page**

```tsx
"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { PlanEditorCanvas, type EditorRoom } from "@/components/project/plan-editor-canvas";
import { deriveOpenings, seedPlacedOpenings, type EditorShape } from "@/lib/plan-editor/geometry";
import { ROOM_PALETTE, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { PlacedOpening, Room } from "@/lib/types";

/**
 * The Plan Editor (revamp: greybox opening placement, Phase A) — sits between
 * Upload and Room Confirmation. Lets the user drop each extracted room onto
 * the uploaded plan image as a rectangle and place its doors/windows on its
 * walls, so the generated room image can be conditioned on where they
 * actually are (see docs/superpowers/specs/2026-08-01-greybox-*).
 *
 * Editing happens entirely in local state; "Continue" derives RoomOpening[]
 * from the placed geometry and writes everything back in one
 * applyPlanLayout call, the same "build final Room[] locally, commit once"
 * pattern the (disabled) Sketch Tool page uses.
 */

const DEFAULT_SHAPE: EditorShape = { x: 0.38, y: 0.38, w: 0.2, h: 0.2 };

export default function PlanEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const applyPlanLayout = useVasto((s) => s.applyPlanLayout);

  const initialRooms = useMemo(() => project?.floorPlan?.rooms ?? [], [project?.floorPlan?.rooms]);
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  if (!project) return null;

  const plan = project.floorPlan;
  const referenceImage = imageFailed
    ? undefined
    : plan?.meta?.storageKey
      ? `/api/render?key=${encodeURIComponent(plan.meta.storageKey)}`
      : plan?.previewUrl;

  const placedRooms: EditorRoom[] = rooms
    .filter((r): r is Room & { shape: NonNullable<Room["shape"]> } => !!r.shape)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      shape: r.shape,
      placedOpenings: r.placedOpenings ?? [],
    }));
  const unplacedRooms = rooms.filter((r) => !r.shape);

  const patchRoom = (roomId: string, patch: Partial<Room>) =>
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, ...patch } : r)));

  const placeRoom = (room: Room) => {
    // Seed from this room's extraction-time openings (side-only guess) so
    // there's something to drag into place, not a blank rectangle.
    const seeded = room.placedOpenings ?? seedPlacedOpenings(room.openings ?? []);
    patchRoom(room.id, { shape: { ...DEFAULT_SHAPE }, placedOpenings: seeded });
    setSelectedId(room.id);
  };

  const addNewRoom = () => {
    const room: Room = {
      id: uid("room"),
      name: `Room ${rooms.length + 1}`,
      x: 0,
      y: 0,
      color: ROOM_PALETTE[rooms.length % ROOM_PALETTE.length],
      shape: { ...DEFAULT_SHAPE },
      placedOpenings: [],
    };
    setRooms((prev) => [...prev, room]);
    setSelectedId(room.id);
  };

  const unplaceRoom = (roomId: string) => {
    patchRoom(roomId, { shape: undefined });
    if (selectedId === roomId) setSelectedId(null);
  };

  const deleteRoom = (roomId: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    if (selectedId === roomId) setSelectedId(null);
  };

  const proceed = () => {
    if (placedRooms.length > 0) {
      const derived = deriveOpenings(placedRooms);
      const finalRooms = rooms.map((r) =>
        r.shape ? { ...r, openings: derived[r.id] ?? [] } : r,
      );
      applyPlanLayout(id, finalRooms);
    }
    router.push(`/projects/${id}/review`);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Place doors and windows</h2>
          <p className="mt-1 text-sm text-muted">
            Draw each room where it actually sits on the plan, then drag its doors and windows onto the
            right wall. This is what makes the generated image put them in the same place.
          </p>
        </div>

        {!referenceImage ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <Icon name="Image" className="mx-auto size-7 text-faint" />
            <p className="mt-3 text-sm text-muted">
              No plan image to draw on for this project. You can still add rooms and their doors/windows
              manually on the next screen.
            </p>
            <Button className="mt-4" iconRight="ArrowRight" onClick={() => router.push(`/projects/${id}/review`)}>
              Continue to Room Confirmation
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div
              className="relative w-full overflow-hidden rounded-2xl border border-border bg-grid bg-surface"
              style={{ aspectRatio: aspect ?? 4 / 3 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={referenceImage}
                alt="Uploaded floor plan"
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
                onError={() => setImageFailed(true)}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
                }}
              />
              <PlanEditorCanvas
                rooms={placedRooms}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onShapeChange={(roomId, shape) => patchRoom(roomId, { shape })}
                onOpeningsChange={(roomId, placedOpenings) => patchRoom(roomId, { placedOpenings })}
              />
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-3.5">
                <h3 className="text-sm font-semibold">Rooms</h3>
                <p className="mt-1 text-xs text-faint">
                  Click a wall on the selected room to add a door; click it again to make it a window, once
                  more to remove it. Drag a door/window along its wall, or drag its ends to resize.
                </p>
                <div className="scrollbar-thin mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {placedRooms.map((r) => {
                    const doors = r.placedOpenings.filter((o) => o.type === "door").length;
                    const windows = r.placedOpenings.filter((o) => o.type === "window").length;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedId(r.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          r.id === selectedId ? "bg-accent/15 text-accent" : "hover:bg-surface-2"
                        }`}
                      >
                        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                        <span className="min-w-0 flex-1 truncate font-medium">{r.name || "Room"}</span>
                        <span className="shrink-0 text-faint">
                          {doors}D · {windows}W
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            unplaceRoom(r.id);
                          }}
                          className="shrink-0 cursor-pointer text-faint hover:text-foreground"
                          aria-label={`Remove ${r.name} from plan`}
                          title="Remove from plan"
                        >
                          <Icon name="EyeOff" className="size-3.5" />
                        </button>
                      </button>
                    );
                  })}
                  {placedRooms.length === 0 && (
                    <p className="px-1 py-2 text-xs text-faint">No rooms placed yet.</p>
                  )}
                </div>
              </div>

              {unplacedRooms.length > 0 && (
                <div className="rounded-2xl border border-border bg-surface p-3.5">
                  <h3 className="text-sm font-semibold">Not on the plan yet</h3>
                  <div className="mt-2 space-y-1.5">
                    {unplacedRooms.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs">
                        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                        <span className="min-w-0 flex-1 truncate">{r.name || "Room"}</span>
                        <Button size="sm" variant="ghost" onClick={() => placeRoom(r)}>
                          Place
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          icon="Trash2"
                          aria-label={`Delete ${r.name}`}
                          onClick={() => deleteRoom(r.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={addNewRoom}
                className="hover-lift flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/60 py-3 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                <Icon name="Plus" className="size-3.5" /> Add room
              </button>

              {selectedId && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="Trash2"
                  className="w-full"
                  onClick={() => deleteRoom(selectedId)}
                >
                  Delete selected room entirely
                </Button>
              )}
            </div>
          </div>
        )}

        {referenceImage && (
          <div className="mt-6 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => router.push(`/projects/${id}/review`)}>
              Skip for now
            </Button>
            <Button iconRight="ArrowRight" onClick={proceed}>
              Continue to Room Confirmation
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
```

Expected: exit 0.

```bash
npm run lint
```

Expected: exit 0.

- [ ] **Step 3: Live check in the dev server**

Start the project's worktree dev server via the preview tooling (`vastos-worktree-dev`, already configured in `P:\vastos-interior-main\.claude\launch.json` from Phase 0 — port 3100), sign in (or use whatever the existing dev auth bypass is), create/open a project, upload `3BHK-house-plan-ground-floor.jpg` (`P:\vastos-interior-main\3BHK-house-plan-ground-floor.jpg`), and let extraction run. Confirm:

1. Landing on `/projects/[id]/plan` automatically after extraction.
2. The plan image fills the box with no letterboxing (aspect-ratio match working).
3. Placing a room (from "Not on the plan yet") drops a default rectangle; it drags, resizes from all 8 handles, and stays within the image bounds.
4. Clicking a wall of the selected room adds a door (gold); clicking it again makes it a window (blue); a third click removes it.
5. Dragging an opening slides it along its wall only, not off the room.
6. Dragging an opening's end handles changes its width.
7. "Continue to Room Confirmation" navigates to Review, and Review's door/window counts reflect what was placed.
8. Reloading the Plan page for the same project (revisiting via the stepper) doesn't lose what's already placed.

Fix anything that doesn't hold before moving on — this is the primary interactive surface of Phase A.

- [ ] **Step 4: Commit**

```bash
git add src/app/projects/[id]/plan
git commit -m "feat: Plan Editor page"
```

---

### Task 10: Greybox geometry hardening (closed doors, cleaner corners)

**Files:**
- Modify: `src/lib/greybox/build-scene.ts`

**Interfaces:**
- No signature changes — `buildGreyboxScene(spec)` keeps the same shape; only what it draws changes.

- [ ] **Step 1: Closed door leaf + frame reveal**

Replace the door/window filler-panel color constants and add a reveal. In `build-scene.ts`, change:

```ts
const DOOR_COLOR = 0x262626;
```

to:

```ts
// A near-black filler read as an open doorway leading somewhere else in the
// Phase 0 spike (the model correctly inferred "void = opening through"). A
// mid-tone, wall-adjacent leaf colour reads as a CLOSED door instead.
const DOOR_COLOR = 0x8a7c6a;
const REVEAL_COLOR = 0x7c7c7c; // slightly darker than the wall, for a visible recess
```

In `buildWall`, after placing the opening's filler panel, add jamb (reveal) panels on the two long sides of the opening (top/left/right for a door reaching the floor; all four sides for a window) so the opening reads as a recess with depth, not a flat color swap:

```ts
    // Filler just outside the wall so the hole reads as a door or a window
    // instead of showing the background through it.
    addPanel(
      group,
      frame,
      u,
      (op.y0 + op.y1) / 2,
      opW,
      op.y1 - op.y0,
      op.o.type === "door" ? doorMat : windowMat,
      -0.08,
    );

    // Reveal: short returned faces along the opening's edges, at wall
    // thickness — gives the opening visible DEPTH (a real recess), which is
    // what should keep it from being misread as a random bright/dark patch,
    // and gives a door frame to read as "closed door", not "hole".
    const REVEAL_DEPTH = 0.08;
    addRevealSide(group, frame, u - opW / 2, op.y0, op.y1, REVEAL_DEPTH, revealMat); // left jamb
    addRevealSide(group, frame, u + opW / 2, op.y0, op.y1, REVEAL_DEPTH, revealMat); // right jamb
    addRevealTop(group, frame, u, opW, op.y1, REVEAL_DEPTH, revealMat); // head (lintel)
```

Add the two new helpers near `addPanel`:

```ts
/** A short return face along one vertical edge of an opening — perpendicular to the wall, giving it depth. */
function addRevealSide(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  y0: number,
  y1: number,
  depth: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(depth, y1 - y0), material);
  const midY = (y0 + y1) / 2;
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * (depth / 2),
    midY,
    frame.cz + frame.az * u + frame.nz * (depth / 2),
  );
  // Perpendicular to the wall: rotate 90 degrees from the wall's own facing.
  mesh.rotation.y = frame.rotY + Math.PI / 2;
  group.add(mesh);
}

/** The horizontal return face above an opening (a lintel), same depth as the side reveals. */
function addRevealTop(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  width: number,
  y: number,
  depth: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  mesh.position.set(frame.cx + frame.ax * u + frame.nx * (depth / 2), y, frame.cz + frame.az * u + frame.nz * (depth / 2));
  mesh.rotation.x = Math.PI / 2;
  mesh.rotation.z = Math.atan2(frame.az, frame.ax); // align the panel's local X axis with the wall's
  group.add(mesh);
}
```

Add `revealMat` in `buildGreyboxScene` and thread it through to `buildWall`'s call signature (it already takes `wallMat, doorMat, windowMat` — add `revealMat` alongside):

```ts
  const revealMat = new THREE.MeshStandardMaterial({ color: REVEAL_COLOR, side: THREE.DoubleSide, roughness: 1 });
```

and update `buildWall`'s signature and the one call site (`buildWall(group, wall, spec, wallMat, doorMat, windowMat)`) to also pass `revealMat`.

- [ ] **Step 2: Corner posts, to reduce the invented-glazing failure**

In `buildGreyboxScene`, after the four `buildWall` calls, add a thin vertical post at each of the room's 4 internal corners, in the wall material — a deliberate, unambiguous "this is a corner" visual cue, cheaper than trying to out-argue the model with prompt wording alone (which Phase 0's strict prompt already tried and only partly worked):

```ts
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const POST_W = 0.06;
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  for (const [cx, cz] of corners) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(POST_W, CEILING_H, POST_W), wallMat);
    post.position.set(cx, CEILING_H / 2, cz);
    group.add(post);
  }
```

- [ ] **Step 3: Visual re-verification**

The throwaway spike page (`src/app/spike/greybox`) is still present at this point — reuse it one more time rather than rebuilding a harness. With the worktree dev server running (`SPIKE_ENABLED=1` still in `.env.local`), open `/spike/greybox` and confirm by eye:

1. The door reads as a closed door — a mid-tone panel set into a visible frame, not a black gap.
2. The room's unbroken corners now show a visible post/edge, distinct from the window and door markers.
3. Nothing broke: room shape, camera framing and the two windows still render correctly (re-check against the same NDC values as Phase 0: door ≈ +0.34, east window ≈ −0.37, north window ≈ −0.79 via the page's existing debug readout).

Fix anything before proceeding — this is the geometry the rest of Phase A depends on.

- [ ] **Step 4: Delete the Phase 0 spike scaffolding**

Its job (proving the approach, then verifying this hardening pass) is done.

```bash
git rm -r src/app/spike src/app/api/spike-greybox
```

In `src/proxy.ts`, remove the `SPIKE_ENABLED` branch entirely, restoring the plain constant:

```ts
const PUBLIC_PREFIXES = ["/login", "/s", "/api/s"];
```

Remove `SPIKE_ENABLED=1` and its comment from `.env.local` (gitignored, not part of the commit, but clean up the local file so it doesn't linger).

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/greybox/build-scene.ts src/proxy.ts
git commit -m "feat: closed doors + corner posts in the greybox; remove spike scaffolding"
```

---

### Task 11: Render, upload, and generation wiring

**Files:**
- Create: `src/app/api/upload-greybox/route.ts`
- Modify: `src/lib/projects/approved-rooms.ts`
- Modify: `src/app/api/generate-room-image/route.ts`
- Modify: `src/lib/ai/prompting/prompt-builder.ts`
- Modify: `src/app/projects/[id]/generate/page.tsx` (wherever it currently calls `/api/generate-room-image` — add the greybox render + upload step first)

**Interfaces:**
- Consumes: `GreyboxRoomSpec`/`buildGreyboxScene`/`greyboxCamera` (Phase 0), `generateImage`'s `opts.referenceImages` (Phase 0), `Room.shape`/`placedOpenings`/`greyboxKey` (Task 6).
- Produces: `POST /api/upload-greybox { projectId, dataUri } -> { key }`; `generate-room-image` accepts an optional `greyboxKey` in its body.

- [ ] **Step 1: The upload route**

```ts
/**
 * Stores a client-rendered greybox reference PNG (see
 * src/lib/greybox/build-scene.ts + camera.ts, rendered in the browser via
 * GreyboxPreview) and returns its storage key, which the caller saves onto
 * the room (Room.greyboxKey) and later passes to /api/generate-room-image.
 *
 * No AI/provider cost here — this is a plain storage PUT — so no `checkUsage`,
 * just auth + a modest rate limit against abuse.
 */

import { randomUUID } from "node:crypto";
import { putObject } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedProject } from "@/lib/supabase/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const guard = await assertAllowed(request, { rateLimit: { key: "upload-greybox", limit: 60, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: { projectId?: string; dataUri?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  const owned = await requireOwnedProject(guard.id, body.projectId);
  if (owned instanceof Response) return owned;

  const m = /^data:image\/png;base64,(.+)$/.exec(body.dataUri ?? "");
  if (!m) return Response.json({ error: "dataUri must be a base64 image/png data URI" }, { status: 400 });
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_BYTES) return Response.json({ error: "Reference image too large" }, { status: 400 });

  const key = `renders/${body.projectId}/greybox/${randomUUID()}.png`;
  await putObject(key, bytes, "image/png");
  return Response.json({ key });
}
```

- [ ] **Step 2: Teach `allProjectStorageKeys` about greybox keys**

In `src/lib/projects/approved-rooms.ts`, inside `allProjectStorageKeys`, add:

```ts
  for (const room of project.floorPlan?.rooms ?? []) {
    if (room.greyboxKey) keys.add(room.greyboxKey);
  }
```

Without this, `GET /api/render`'s ownership check (`requireOwnedKey`, which checks `allProjectStorageKeys(project).has(key)` on the `renders/<projectId>/...` fast path) would 403 a room's own greybox image.

- [ ] **Step 3: Accept `greyboxKey` in `generate-room-image`**

In `src/app/api/generate-room-image/route.ts`, add `greyboxKey?: string` to the `Body` interface, and change the generation call:

```ts
    const prompt = await buildRoomPrompt(universalInput, room, designSpec, { hasGreybox: !!body.greyboxKey });
    const referenceImages = body.greyboxKey ? [await loadGreyboxDataUri(body.greyboxKey)] : undefined;
    const image = await generateImage(prompt, { projectId, userId: guard.id }, { referenceImages });
```

Add the small helper near the top of the file (or inline — it's a one-liner, but named for clarity):

```ts
import { getObject } from "@/lib/pipeline/storage";

async function loadGreyboxDataUri(key: string): Promise<string> {
  const bytes = await getObject(key);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
```

- [ ] **Step 4: The strict geometry clause in `prompt-builder.ts`**

Change `buildRoomPrompt`'s signature to accept the new flag, and swap in the strict clause instead of the word-only one when a greybox is present:

```ts
export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: { hasGreybox?: boolean } = {},
): Promise<string> {
```

Replace the single line:

```ts
  if (room.openings?.length) lines.push(`Real openings, respect them exactly: ${describeOpenings(room.openings)}.`);
```

with:

```ts
  if (opts.hasGreybox) {
    lines.push(
      "",
      "The attached image is an untextured grey 3D massing render of this exact room, from the exact " +
        "camera position the output must use. You MUST preserve, without any deviation:",
      "- the camera position, angle and field of view;",
      "- the room's proportions and every wall position;",
      "- the position, width and height of every door and window opening shown. A closed, framed panel " +
        "is a door — render it CLOSED, never open. A bright panel is a window.",
      "Every surface not shown as an opening is solid. Do not add a door, window or any glazing at a " +
        "corner or wall junction that the reference shows as solid. Do not move, resize, add or remove " +
        "a single opening.",
      "Change ONLY surfaces, materials, lighting and furnishing to match the brief below.",
    );
  } else if (room.openings?.length) {
    lines.push("", `Real openings, respect them exactly: ${describeOpenings(room.openings)}.`);
  }
```

And demote `cameraGuidelines` for greybox rooms (the camera is already fixed by the reference — restating it in words only invites conflict):

```ts
  lines.push("", `${builder.cameraPrefix} ${opts.hasGreybox ? spec.lightingStrategy : spec.cameraGuidelines}`);
```

Update the module doc comment's "This is the only place natural-language prompt text is produced" note to mention the greybox branch, and update `generate-room-image/route.ts`'s call site from Step 3 (already done above).

- [ ] **Step 5: Wire the client-side render + upload into the Generate flow**

Read `src/app/projects/[id]/generate/page.tsx` first to find its existing "generate this room" handler (the call to the generation client / `POST /api/generate-room-image`). Before that call, for a room with a `shape`:

1. If `room.greyboxKey` already exists, skip straight to calling the generation API with it (no re-render needed — geometry hasn't changed since the Plan Editor was last visited for this room, tracked by the fact that nothing invalidates `greyboxKey` except revisiting Plan and hitting Continue again, which is out of this task's scope to auto-invalidate — note this as a known limitation, not a blocker: FLAG to the user in the final report rather than silently guessing at cache invalidation).
2. Otherwise, render the room's greybox client-side (mount `GreyboxPreview` off-screen or reuse its `onReady` callback path — check how `lasso-canvas.tsx`/existing generate page already handles any client-side canvas work for a precedent on where this kind of one-off render belongs), `POST /api/upload-greybox` with the resulting data URI, store the returned key onto the room via `updateRoom(projectId, roomId, { greyboxKey: key })`, then call generate with that key.

This step depends on reading the current shape of `generate/page.tsx`'s generation trigger, which hasn't been read yet in this plan — **read it first**, then adapt to its existing state-management pattern rather than guessing its shape here. If its generation call is a shared hook (`generation-client.ts`), extend that hook's signature instead of the page component directly.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/upload-greybox src/lib/projects/approved-rooms.ts src/app/api/generate-room-image/route.ts src/lib/ai/prompting/prompt-builder.ts src/app/projects/[id]/generate
git commit -m "feat: wire greybox reference images into room generation"
```

---

### Task 12: End-to-end verification (A6)

**Files:** none (verification only).

- [ ] **Step 1: Full live run**

Using the worktree dev server (port 3100): create a project, upload `3BHK-house-plan-ground-floor.jpg`, place at least two adjacent rooms in the Plan Editor with their real doors/windows (including at least one shared wall between two placed rooms, to exercise `deriveOpenings`' adjacency logic), continue through Review → Design → Generate, and generate one room's image.

- [ ] **Step 2: Check against the greybox, not just the photo**

Save the room's rendered greybox (from network inspection or by temporarily logging its data URI) alongside the generated output, same side-by-side comparison method as the Phase 0 spike. Confirm:

1. The door in the output is CLOSED (the Task 10 fix).
2. No invented opening appears at a corner or wall junction that the greybox shows as solid.
3. Every opening that IS in the greybox lands in the corresponding position in the output.

- [ ] **Step 3: Regression check on a room with no shape**

Generate a room that was NEVER placed in the Plan Editor (still has no `Room.shape`). Confirm it generates exactly as it did before this phase — text-only openings clause, no reference image sent, no error.

- [ ] **Step 4: Report**

Summarize pass/fail against Steps 2 and 3 to the user, with the comparison images. If either of Task 10's two targeted defects (open door, invented corner opening) still appears, that's an expected next iteration (per the design spec's risk section), not a Phase A blocker — say so plainly rather than either hiding it or treating it as a failed gate (Phase A, unlike Phase 0, has no go/no-go gate — the feature ships and improves).
