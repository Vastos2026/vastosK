# Furnish Phase + FLUX Pipeline Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Furnish phase between Room Confirmation and Design, rebuild the furniture editor around the locked export camera (no orbit), and bring the greybox→FLUX pipeline into compliance with `docs/flux-prompting-techniques.md` §1–§6 plus §7.1.

**Architecture:** The greybox reference image stays the spine — a three.js massing render of the room from a deterministic 85° camera, uploaded to storage and passed to FLUX.2 [pro] as a single reference image. This change moves that render *earlier* (before Design, so it exists before any paid call), rewrites the prompt to fit inside FLUX.2's 512-token text encoder, and adds a second "Pass B" mask render that supplies ground-truth opening counts.

**Tech Stack:** Next.js 16 (App Router), React 19, three.js (client-side WebGL, offscreen canvas), zustand (`useVasto` local-first store), sharp (server-side PNG decode), Runware `bfl:5@1` (FLUX.2 [pro]), Supabase (best-effort persistence).

---

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-03-furnish-phase-and-flux-pipeline-design.md` and `docs/flux-prompting-techniques.md`. Every task's requirements implicitly include this section.

- **No test runner exists in this repo.** Verification is `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus assertions in the dev-only route built in Task 2 and manual browser checks. Do not add a test framework.
- **Plain Node cannot run this codebase's modules.** Extensionless relative imports and the `@/` alias resolve only through Next's bundler. Any verification script must be a route handler hit with `curl`, never `node script.mjs`. (Learned the hard way in the ControlNet spike.)
- `prompt.length <= 1800` — hard assert, throws, fails the job. Target 1,300–1,500 steady state.
- **Positive phrasing only.** There is no `negativePrompt` on `bfl:5@1` or `bfl:6@1`. `solid wall` not `no window`; `one door` not `no extra doors`.
- **Numbers as words** in the opening ledger, singular/plural matched.
- **Ledger counts come from the Pass B mask**, never from `openings.length`.
- **Mask is pure white** (`MeshBasicMaterial 0xffffff`) on black, furniture hidden. Door/window identity comes from projecting each known opening's centre through the same camera, not from pixel colour.
- **No new furniture catalogue types.** The existing 23 entries only.
- **Zero positional prose about furniture.** The render owns position; the prompt owns material.
- **Furniture cap: 5 pieces**, enforced in the editor UI.
- **Camera FOV 85° vertical, locked.** No orbit, no reposition, no FOV control in any UI.
- **Openings are read-only after room definition.** Never auto-repair an invalid opening; fail closed and surface the violation.
- **Never mutate the prompt between retries** and never change two variables in one experiment.
- Furniture yields to openings, always. Never move an opening to accommodate furniture.
- Commit after every task. Do not skip hooks.

**Catalogue keys are kebab-case in this codebase** (`coffee-table`, `tv-unit`, `dining-table`, `office-chair`, `kitchen-island`, `bar-stool`, `pooja-mandir`, `console-table`, `conference-table`, `outdoor-chair`, `side-table`). `flux-prompting-techniques.md` §4.3 writes them snake_case. **Use the codebase's kebab-case keys.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/greybox/types.ts` | Shared vocabulary: `GreyboxOpening`, `GreyboxFurniturePlacement`, `GreyboxRoomSpec` |
| `src/lib/greybox/build-scene.ts` | Spec → `THREE.Scene`. Owns the value ladder, both opening fixtures, class stamping |
| `src/lib/greybox/camera.ts` | Deterministic 8-candidate 85° camera |
| `src/lib/greybox/render-to-data-uri.ts` | Supersampled conditioning render + §3.7 histogram assert |
| **new** `src/lib/greybox/render-mask.ts` | Pass B opening mask + internal label mask + opening→pixel projection |
| **new** `src/lib/greybox/count-openings.ts` | Server-side connected components (sharp) → `{doors, windows}` |
| **new** `src/lib/greybox/greybox-hash.ts` | Content hash for cache invalidation |
| **new** `src/lib/greybox/validate-openings.ts` | §5 geometry validation, fail-closed |
| **new** `src/lib/greybox/validate-furniture.ts` | AABB/bounds/camera constraint solver + occlusion raycast |
| `src/lib/greybox/furniture-catalogue.ts` | 23 entries + `materialPhrase` + `promptPriority` |
| `src/lib/greybox/furniture-layout.ts` | Coordinate bridge + `buildFurnitureMaterials`. No positional prose |
| `src/lib/greybox/ensure-greybox-key.ts` | Render + mask + upload, hash-gated |
| **new** `src/lib/greybox/render-queue.ts` | Serial WebGL queue for the gallery |
| `src/lib/ai/prompting/prompt-builder.ts` | The §2 template. Only place prompt text is produced |
| `src/lib/ai/prompting/design-planning.ts` | Adds `compactBrief`, `materialTokens`, `compactGuidance` |
| **new** `src/app/projects/[id]/furnish/page.tsx` | Gallery |
| `src/app/projects/[id]/furnish/[roomId]/page.tsx` | Fixed-camera editor shell |
| `src/components/project/furniture-editor-canvas.tsx` | Fixed-camera viewport + interaction |
| **new** `src/components/project/furnish-room-card.tsx` | One gallery card |
| **new** `src/app/api/dev-check/route.ts` | Dev-only assertion harness (this repo's stand-in for a test suite) |

---

## Task 1: Data model, store and navigation foundations

Everything downstream depends on these types existing. Nothing here is user-visible.

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/store.ts`
- Modify: `src/lib/nav.ts`
- Test: none (no test runner) — verified via `npx tsc --noEmit`

**Interfaces:**
- Produces: `Phase` gains `"furnish"`; `Room` gains `greyboxMaskKey?`, `greyboxHash?`, `greyboxLedger?`; store action `setRoomGreybox(id, roomId, patch)`.

- [ ] **Step 1: Add the new `Room` fields**

In `src/lib/types.ts`, extend the existing `Room` interface (it already has `shape?`, `placedOpenings?`, `furniture?`, `greyboxKey?` on this branch):

```ts
export interface GreyboxLedger {
  /** Doors visible in the Pass B mask from the locked camera. Not the same as placedOpenings.length. */
  doors: number;
  /** Windows visible in the Pass B mask from the locked camera. */
  windows: number;
}

// inside Room:
  /** Pass B opening mask, stored beside greyboxKey as `{greyboxKey}-mask`. */
  greyboxMaskKey?: string;
  /**
   * Content hash of everything the greybox render depends on. When this
   * differs from a freshly computed hash, the cached greyboxKey is stale and
   * must be re-rendered. Fixes the bug where editing a door in the Plan
   * editor after generating silently reused the old reference image.
   */
  greyboxHash?: string;
  /** Cached ledger, for UI display only. The prompt re-derives from the mask. */
  greyboxLedger?: GreyboxLedger;
```

- [ ] **Step 2: Add `"furnish"` to `Phase`**

In `src/lib/types.ts`, find the `Phase` union (it already includes `"plan"` on this branch) and add `"furnish"` between `"review"` and `"design"`:

```ts
export type Phase =
  | "upload"
  | "plan"
  | "review"
  | "furnish"
  | "design"
  | "generate"
  | "approve"
  | "walkthrough";
```

- [ ] **Step 3: Add the store action**

In `src/lib/store.ts`, add to the state interface next to the existing `updateRoom` declaration (line ~40):

```ts
  setRoomGreybox: (
    id: string,
    roomId: string,
    patch: Pick<Room, "furniture" | "greyboxKey" | "greyboxMaskKey" | "greyboxHash" | "greyboxLedger">,
  ) => void;
```

And implement it next to `updateRoom` (line ~213) by delegating — it exists as a named action purely so the five greybox fields always move together and no call site can write a key without its hash:

```ts
      setRoomGreybox: (id, roomId, patch) => get().updateRoom(id, roomId, patch),
```

- [ ] **Step 4: Add the nav phase**

In `src/lib/nav.ts`, add to `PHASES` between the `review` and `design` entries:

```ts
  { id: "furnish", label: "Furnish", icon: "Sofa" },
```

Leave `resumePhase` unchanged. Furnish is entered on the forward pass from Review or by clicking the stepper, never by resume — same convention Plan already uses.

- [ ] **Step 5: Confirm the icon exists**

Run: `grep -n "Sofa" src/components/ui/icon.tsx`
Expected: a match. If there is no match, add `Sofa` to that file's lucide import and its icon map following the exact pattern of the neighbouring entries.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/store.ts src/lib/nav.ts src/components/ui/icon.tsx
git commit -m "feat: furnish phase types, store action and nav entry"
```

---

## Task 2: Dev-only assertion harness and the greybox content hash

This repo has no test runner and plain Node cannot import its modules. This task builds the one thing that makes every later pure-function task verifiable: a dev-gated route that runs assertions and returns them as JSON.

**Files:**
- Create: `src/app/api/dev-check/route.ts`
- Create: `src/lib/greybox/greybox-hash.ts`
- Test: the dev-check route itself

**Interfaces:**
- Produces: `greyboxHashFor(room: Pick<Room, "width"|"height"|"placedOpenings"|"furniture">): string`, `GREYBOX_RENDER_VERSION: number`. Consumed by Task 7.
- Produces: the `check(name, fn)` harness pattern every later task appends to.

- [ ] **Step 1: Write the hash module**

Create `src/lib/greybox/greybox-hash.ts`:

```ts
/**
 * Content hash of everything renderGreyboxToDataUri reads, so a cached
 * greyboxKey can be invalidated the moment any of it changes.
 *
 * Before this existed, ensure-greybox-key.ts short-circuited on
 * `if (room.greyboxKey) return room.greyboxKey` and nothing anywhere in src/
 * ever cleared that field — so editing a door in the Plan editor after
 * generating silently reused the stale reference image.
 *
 * Deliberately NOT a crypto hash: this runs in the browser on every gallery
 * mount and only needs to detect change, not resist forgery. FNV-1a over a
 * canonical JSON string is stable across reloads and machines, which
 * Object.entries ordering alone would not be.
 */
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

/**
 * Bump to invalidate every cached greybox at once. Incremented when the
 * render's own output changes (value ladder, camera, resolution) rather than
 * when a room's data changes.
 *
 * 2 — 2026-08-03: section 3 value ladder, level camera, supersampled render.
 */
export const GREYBOX_RENDER_VERSION = 2;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function greyboxHashFor(
  room: Pick<Room, "width" | "height" | "placedOpenings" | "furniture">,
): string {
  const { width, height } = layoutSize(room);
  const openings = [...(room.placedOpenings ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => [o.type, o.wall, round(o.t, 4), round(o.span, 4)]);
  const furniture = [...(room.furniture ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => [f.kind, round(f.x, 4), round(f.z, 4), round(f.rotation, 4)]);
  return fnv1a(
    JSON.stringify({ w: round(width, 3), d: round(height, 3), o: openings, f: furniture, v: GREYBOX_RENDER_VERSION }),
  );
}
```

- [ ] **Step 2: Write the dev-check route**

Create `src/app/api/dev-check/route.ts`:

```ts
/**
 * This repo has no test runner, and plain Node cannot import its modules —
 * extensionless relative imports and the `@/` alias resolve only through
 * Next's bundler (the ControlNet spike hit ERR_MODULE_NOT_FOUND trying).
 * So pure-function assertions live here and run inside the app.
 *
 * Hit with: curl http://localhost:3000/api/dev-check
 * Returns 404 in production. No auth, no rate limit, no provider calls — it
 * must never do anything that costs money or touches user data.
 */
import { greyboxHashFor } from "@/lib/greybox/greybox-hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  results.length = 0;

  // ---- greybox-hash ----
  check("hash is stable across calls", () => {
    const room = { width: 12, height: 14, placedOpenings: [], furniture: [] };
    eq(greyboxHashFor(room), greyboxHashFor(room), "same input, same hash");
  });

  check("hash ignores array order", () => {
    const a = {
      width: 12,
      height: 14,
      placedOpenings: [
        { id: "b", type: "window" as const, wall: "north" as const, t: 0.3, span: 0.2 },
        { id: "a", type: "door" as const, wall: "south" as const, t: 0.5, span: 0.25 },
      ],
      furniture: [],
    };
    const b = { ...a, placedOpenings: [...a.placedOpenings].reverse() };
    eq(greyboxHashFor(a), greyboxHashFor(b), "reordered openings hash identically");
  });

  check("hash changes when an opening moves", () => {
    const base = {
      width: 12,
      height: 14,
      placedOpenings: [{ id: "a", type: "door" as const, wall: "south" as const, t: 0.5, span: 0.25 }],
      furniture: [],
    };
    const moved = { ...base, placedOpenings: [{ ...base.placedOpenings[0], t: 0.6 }] };
    assert(greyboxHashFor(base) !== greyboxHashFor(moved), "moving a door must change the hash");
  });

  check("hash changes when furniture moves", () => {
    const base = {
      width: 12,
      height: 14,
      placedOpenings: [],
      furniture: [{ id: "f1", kind: "bed", x: 0.5, z: 0.2, rotation: 0 }],
    };
    const moved = { ...base, furniture: [{ ...base.furniture[0], x: 0.6 }] };
    assert(greyboxHashFor(base) !== greyboxHashFor(moved), "moving furniture must change the hash");
  });

  const failed = results.filter((r) => !r.ok);
  return Response.json(
    { passed: results.length - failed.length, failed: failed.length, results },
    { status: failed.length ? 500 : 200 },
  );
}
```

- [ ] **Step 3: Run the checks and confirm they pass**

Start the dev server (`npm run dev`) in one shell, then:

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `{"passed":4,"failed":0,...}` with HTTP 200.

- [ ] **Step 4: Deliberately break one check to prove the harness reports failures**

Temporarily change `GREYBOX_RENDER_VERSION` to `2.0001` inside `greyboxHashFor`'s object literal — no: instead, temporarily change the `moved` object in "hash changes when an opening moves" to `t: 0.5` (identical to base).

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/dev-check`
Expected: `500`. Then revert the change and confirm `200` again. A harness that cannot fail proves nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/greybox/greybox-hash.ts src/app/api/dev-check/route.ts
git commit -m "feat: greybox content hash and dev-only assertion harness"
```

---

## Task 3: Value ladder, opening fixtures and semantic class stamping

Implements §3.1, §3.2, §3.6 and the design doc's §4.1b. Also stamps every mesh with a semantic class, which Tasks 4, 5 and 9 all depend on.

**Files:**
- Modify: `src/lib/greybox/build-scene.ts`
- Modify: `src/lib/greybox/camera.ts`
- Test: dev-check (`openingFaceSamples` geometry) + visual inspection

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type GreyboxClass = "wall" | "floor" | "ceiling" | "door" | "window" | "reveal" | "furniture"`; `export function openingFaceSamples(spec, o, nu?, nv?): THREE.Vector3[]`; every mesh carries `userData.greyboxClass`, opening fillers additionally carry `userData.openingId`. Consumed by Tasks 4, 5, 9.

- [ ] **Step 1: Update the colour constants**

In `src/lib/greybox/build-scene.ts`, replace the constants at lines 21–31 with the §3.1 "New" column. **Do not change `DOOR_COLOR`** — §3.1 says Keep, and it is empirically validated against a real Phase 0 failure where a near-black filler rendered as an open doorway.

```ts
const WALL_COLOR = 0xb0b0b0;
const FLOOR_COLOR = 0x9c9c9c;
const CEIL_COLOR = 0xc4c4c4;
// Door filler stays 0x8a7c6a. Section 3.1: "Keep. Empirically validated,
// desaturated, small frame area." A near-black filler was the Phase 0 defect
// that made a door render OPEN, read as a void leading somewhere else.
const DOOR_COLOR = 0x8a7c6a;
// Brightest thing in the frame by construction — unlit, so the light rig
// cannot darken it and the prompt's "a bright panel is a window" contract is
// guaranteed by the render rather than by luck.
const WINDOW_COLOR = 0xfafafa;
const REVEAL_COLOR = 0x6e6e6e;
```

Find the corner-post colour (it uses `REVEAL_COLOR`) and leave it referencing that constant so it moves with it, per §3.1.

- [ ] **Step 2: Update the furniture and rug colours**

In `src/lib/greybox/furniture-catalogue.ts`, update the four palette constants:

```ts
const FRAME = 0x585858;
const SEAT = 0x484848;
const RUG = 0x8a8a8a;
const FOLIAGE = 0x6b7d6b;
```

§3.1's note is the reason: keep furniture (28–35% luma) far from the door (~49%) so a wardrobe is never read as a door panel.

- [ ] **Step 3: Update the lighting rig**

In `build-scene.ts`, find the light construction (ambient `0.55`, hemisphere `0.5`, two directionals `0.75`/`0.4`) and change the intensities to §3.6's values. Keep the two-directional setup and both light positions exactly as they are — adjacent walls must never share exact brightness, and no hard shadows.

```ts
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.35));
  // key
  key.intensity = 0.65;
  // fill
  fill.intensity = 0.35;
```

- [ ] **Step 4: Stamp semantic classes on every mesh**

Add near the top of `build-scene.ts`:

```ts
/**
 * Semantic class of a mesh, stamped into userData so later passes can select
 * regions without re-deriving geometry: the section 7.1 opening mask needs to
 * find openings, and the section 3.7 histogram assert needs per-class pixel
 * regions. Never affects the conditioning render itself.
 */
export type GreyboxClass = "wall" | "floor" | "ceiling" | "door" | "window" | "reveal" | "furniture";
```

Change `addPanel` to return the mesh it created (or `undefined` when it early-returns on a degenerate size), so call sites can stamp it:

```ts
function addPanel(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  y: number,
  panelW: number,
  panelH: number,
  material: THREE.Material,
  offset = 0,
): THREE.Mesh | undefined {
  if (panelW <= 1e-6 || panelH <= 1e-6) return undefined;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), material);
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * offset,
    y,
    frame.cz + frame.az * u + frame.nz * offset,
  );
  mesh.rotation.y = frame.rotY;
  group.add(mesh);
  return mesh;
}
```

Then, at every call site in `buildWall`, set `mesh.userData.greyboxClass`:
- the gap / below-opening / above-opening wall panels → `"wall"`
- the opening filler (the `addPanel` call at the "Filler just outside the wall" comment) → `op.type` (`"door"` or `"window"`), **and** `mesh.userData.openingId = op.id`
- `addRevealSide` / `addRevealTop` meshes → `"reveal"`
- floor → `"floor"`, ceiling → `"ceiling"`, corner posts → `"reveal"`

`addRevealSide` and `addRevealTop` must also return their mesh so the caller can stamp it. In the furniture loop (around line 310), after `group.position.set(...)`, stamp the whole subtree:

```ts
    group.traverse((o) => {
      o.userData.greyboxClass = "furniture";
    });
```

- [ ] **Step 5: Thread the opening id into `buildWall`'s internal struct**

`buildWall` builds an internal per-opening object carrying `y0`/`y1` and the along-wall span. Add `id` and `type` to it, sourced from the `GreyboxOpening` it came from, so Step 4's filler stamping has them. This is a mechanical change — follow whatever the existing struct looks like and add two fields.

- [ ] **Step 6: Export `openingFaceSamples`**

Add to `build-scene.ts`, directly below `openingCentre` (it reuses the identical along-wall derivation, so the two must stay adjacent and cannot be allowed to drift):

```ts
/**
 * A grid of world-space points spread across an opening's face rectangle,
 * for the section 6.1 occlusion raycast. Inset 10% from every edge so a
 * sample never lands on the reveal geometry surrounding the opening, which
 * would register as a hit on the wrong object.
 */
export function openingFaceSamples(
  spec: GreyboxRoomSpec,
  o: GreyboxOpening,
  nu = 5,
  nv = 5,
): THREE.Vector3[] {
  const frame = wallFrame(o.wall, spec.width, spec.depth);
  const L = frame.len;
  const spanLen = Math.max(0, Math.min(1, o.span)) * L;
  const centre = Math.max(0, Math.min(1, o.t)) * L;
  const x0 = Math.max(0, Math.min(L - spanLen, centre - spanLen / 2));
  const uMid = x0 + spanLen / 2 - L / 2;
  const { y0, y1 } = openingVertical(o);

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < nu; i++) {
    const fu = nu === 1 ? 0.5 : 0.1 + (0.8 * i) / (nu - 1);
    const u = uMid + (fu - 0.5) * spanLen;
    for (let j = 0; j < nv; j++) {
      const fv = nv === 1 ? 0.5 : 0.1 + (0.8 * j) / (nv - 1);
      pts.push(
        new THREE.Vector3(frame.cx + frame.ax * u, y0 + fv * (y1 - y0), frame.cz + frame.az * u),
      );
    }
  }
  return pts;
}
```

- [ ] **Step 7: Level the camera and pull in the near plane**

In `src/lib/greybox/camera.ts`, line 62, change `camera.lookAt(0, EYE_H * 0.9, 0)` to `camera.lookAt(0, EYE_H, 0)`, and line 60's near plane from `0.1` to `0.15`:

```ts
    const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.15, 200);
    camera.position.set(cx, EYE_H, cz);
    camera.lookAt(0, EYE_H, 0);
```

Add a comment above `lookAt` recording why, because it looks like a no-op otherwise:

```ts
    // Level, not tilted down. At 85 degrees a downward tilt produces severe
    // vertical keystoning — walls converge toward the top of frame — and a
    // tilted ultra-wide is doubly outside the model's training distribution.
    // Architectural photography keeps the sensor plane vertical for exactly
    // this reason. Section 3.3.
```

**Do not touch `FOV`, `INSET`, `EDGE_MARGIN`, the candidate list, or the scoring order.** The same room spec must always yield the same viewpoint.

- [ ] **Step 8: Add face-sample assertions to dev-check**

In `src/app/api/dev-check/route.ts`, add the import and this block before the `const failed = ...` line:

```ts
  // ---- openingFaceSamples ----
  check("face samples land inside the opening rectangle", () => {
    const spec = {
      width: 12,
      depth: 10,
      openings: [{ id: "w1", type: "window" as const, wall: "north" as const, t: 0.5, span: 0.4 }],
    };
    const pts = openingFaceSamples(spec, spec.openings[0]);
    eq(pts.length, 25, "5x5 grid");
    // North wall sits at z = -depth/2, t runs west->east so samples vary in x only.
    for (const p of pts) {
      assert(Math.abs(p.z - -5) < 1e-6, `sample off the north wall plane: z=${p.z}`);
      assert(Math.abs(p.x) <= (0.4 * 12) / 2 + 1e-6, `sample outside the span: x=${p.x}`);
      assert(p.y >= 3 && p.y <= 7, `sample outside the window's vertical extent: y=${p.y}`);
    }
  });
```

Import it at the top: `import { openingFaceSamples } from "@/lib/greybox/build-scene";`

- [ ] **Step 9: Run the checks**

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 5 checks passed.

- [ ] **Step 10: Visually confirm the render still reads correctly**

With `npm run dev` running, open any project that has a room placed in the Plan editor and reach `/projects/<id>/furnish/<roomId>` (the existing editor page still works at this point). Confirm by eye: the window panel is clearly the brightest thing in frame; the door reads as a closed brown panel with a visibly recessed, darker frame around it; furniture proxies are clearly darker than the walls and unmistakably not door-coloured.

- [ ] **Step 11: Commit**

```bash
git add src/lib/greybox/build-scene.ts src/lib/greybox/camera.ts src/lib/greybox/furniture-catalogue.ts src/app/api/dev-check/route.ts
git commit -m "feat: greybox value ladder, level camera and semantic class stamping"
```

---

## Task 4: Render size lock, supersampling and the histogram assertion

Implements §3.4, §3.5, §3.7. The size constant introduced here is the single place render and generation dimensions are decided, which is what makes the §3.4 aspect lock enforceable.

**Files:**
- Modify: `src/lib/greybox/render-to-data-uri.ts`
- Test: dev-check is not usable here (WebGL is client-side) — verified via browser + the assertion firing

**Interfaces:**
- Consumes: `GreyboxClass`, `openingFaceSamples` from Task 3.
- Produces: `GREYBOX_RENDER_W`, `GREYBOX_RENDER_H`, `GREYBOX_ASPECT`, `renderGreyboxToDataUri(spec): string` (unchanged signature), `GreyboxHistogramError`. Consumed by Tasks 5, 7, 13.

- [ ] **Step 1: Rewrite `render-to-data-uri.ts`**

Replace the whole file:

```ts
"use client";

import * as THREE from "three";
import { buildGreyboxScene, type GreyboxClass } from "./build-scene";
import { greyboxCamera } from "./camera";
import type { GreyboxRoomSpec } from "./types";

/**
 * The ONE place greybox output dimensions are decided. Section 3.4 requires
 * the generation width/height to produce exactly this aspect — any mismatch
 * and FLUX letterboxes or crops, which breaks the camera match the whole
 * pipeline depends on. runware-client.ts imports these rather than keeping
 * its own numbers, so the two cannot drift.
 *
 * 1376x768 is section 3.4's stated target (both divisible by 16). If Runware
 * rejects it on bfl:5@1 with invalidWidth — FLUX.1-dev required divisibility
 * by 64 and the ControlNet spike hit exactly this — change these two numbers
 * to 1280x704 and nothing else needs to move. Task 13 verifies which applies.
 */
export const GREYBOX_RENDER_W = 1376;
export const GREYBOX_RENDER_H = 768;
export const GREYBOX_ASPECT = GREYBOX_RENDER_W / GREYBOX_RENDER_H;

/** Supersample factor. One extra offscreen render, no aliasing speckle for the model to read as texture. */
const SS = 2;

/** Thrown when the section 3.7 value ladder has collapsed. Never swallowed. */
export class GreyboxHistogramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GreyboxHistogramError";
  }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}

/**
 * Renders a scene through a camera onto an offscreen canvas and returns a 2D
 * context holding the result at final size. Rendering at SS x and drawing
 * down through the 2D context does the supersample and gives pixel access in
 * one step — getImageData on this same context is what the histogram assert
 * and the mask reader both use.
 */
export function renderToContext(
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: { supersample: boolean; antialias: boolean },
): CanvasRenderingContext2D {
  const scale = opts.supersample ? SS : 1;
  const gl = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas: gl,
    antialias: opts.antialias,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(GREYBOX_RENDER_W * scale, GREYBOX_RENDER_H * scale, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Flat and predictable: tone mapping would remap the value ladder's
  // carefully spaced luma bands into something else entirely.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.render(scene, camera);

  const out = document.createElement("canvas");
  out.width = GREYBOX_RENDER_W;
  out.height = GREYBOX_RENDER_H;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.imageSmoothingEnabled = opts.supersample;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(gl, 0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H);

  renderer.dispose();
  return ctx;
}

function luma(d: Uint8ClampedArray, i: number): number {
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Section 3.7. Material colours are not rendered values — a lighting tweak
 * can silently collapse the value ladder while every constant still looks
 * right in source. This verifies the actual pixels.
 *
 * Runs against a label pass (each mesh flat-shaded by its greyboxClass) used
 * purely as a region selector over the real render's pixels.
 */
export function assertHistogram(real: ImageData, labels: Map<GreyboxClass, number[]>) {
  const d = real.data;
  const lumaOf = (idx: number) => luma(d, idx * 4);
  const sortedOf = (cls: GreyboxClass) => (labels.get(cls) ?? []).map(lumaOf).sort((a, b) => a - b);

  const win = sortedOf("window");
  const wall = sortedOf("wall");
  const furn = sortedOf("furniture");
  const door = sortedOf("door");

  if (win.length && wall.length) {
    // Literally: "window region occupies the top 1% of luma, and no wall
    // pixel exceeds it". Compared at p05/p99 rather than min/max because
    // antialiased edge pixels blend across the boundary and would fail a
    // strict comparison for a render that is perfectly correct.
    if (percentile(win, 5) <= percentile(wall, 99)) {
      throw new GreyboxHistogramError(
        `Window is not the brightest surface (window p05 ${percentile(win, 5).toFixed(3)} <= wall p99 ${percentile(wall, 99).toFixed(3)}). ` +
          "Check that the window filler is still an unlit MeshBasicMaterial.",
      );
    }
  }

  if (furn.length && wall.length) {
    const gap = percentile(wall, 50) - percentile(furn, 50);
    if (gap < 0.15) {
      throw new GreyboxHistogramError(
        `Furniture does not separate from the walls (median gap ${gap.toFixed(3)} < 0.15). Furniture must be the darkest thing in frame.`,
      );
    }
  }

  if (door.length && furn.length) {
    const gap = Math.abs(percentile(door, 50) - percentile(furn, 50));
    if (gap < 0.1) {
      throw new GreyboxHistogramError(
        `Door panel and furniture are too close in value (${gap.toFixed(3)} < 0.10) — a wardrobe will read as a door.`,
      );
    }
  }

  const nonWindow = new Set(labels.get("window") ?? []);
  let total = 0;
  let clipped = 0;
  for (let i = 0; i < d.length; i += 4) {
    const idx = i / 4;
    if (nonWindow.has(idx)) continue;
    total++;
    if (d[i] >= 255 && d[i + 1] >= 255 && d[i + 2] >= 255) clipped++;
  }
  if (total && clipped / total > 0.005) {
    throw new GreyboxHistogramError(
      `${((clipped / total) * 100).toFixed(2)}% of non-window pixels are clipped at 255 (max 0.5%). Pull the light rig back.`,
    );
  }
}

/**
 * Renders a room's greybox to an OFFSCREEN canvas — never attached to the
 * DOM, since a canvas needs no DOM presence to get a WebGL context or export
 * a data URI — and returns a PNG data URI.
 *
 * Runs entirely client-side (needs WebGL). Callers go through
 * ensure-greybox-key.ts, which uploads the result via /api/upload-greybox to
 * get a storage key the server can reuse for later regenerations without a
 * browser.
 */
export function renderGreyboxToDataUri(spec: GreyboxRoomSpec): string {
  const scene = buildGreyboxScene(spec);
  const camera = greyboxCamera(spec, GREYBOX_ASPECT);
  const ctx = renderToContext(scene, camera, { supersample: true, antialias: true });
  const dataUri = ctx.canvas.toDataURL("image/png");
  disposeScene(scene);
  return dataUri;
}
```

- [ ] **Step 2: Verify the render still produces an image**

With `npm run dev` running, open a room in the existing furnish editor and click Save. Confirm the greybox uploads without error and the resulting PNG is 1376×768 (check the network response, or open `/api/render?key=<the key>` and inspect the image dimensions in the browser).

- [ ] **Step 3: Prove the histogram assertion can fail**

Temporarily change `WINDOW_COLOR` in `build-scene.ts` to `0x909090` (darker than the wall). Render a room with a window and confirm a `GreyboxHistogramError` naming the window check is thrown. Revert the change and confirm the render succeeds again.

Note: `assertHistogram` has no caller yet — it is wired in Task 5 once the label pass exists. For this step, call it manually from the browser console or add a temporary call. An assertion that has never been observed failing is not an assertion.

- [ ] **Step 4: Commit**

```bash
git add src/lib/greybox/render-to-data-uri.ts
git commit -m "feat: supersampled greybox render, locked dimensions and value-ladder assertion"
```

---

## Task 5: Pass B opening mask, label pass and opening projection

Implements §7.1. The mask is the ground truth for the §4.2 ledger and the reason an occluded or off-frame opening is never claimed in the prompt.

**Files:**
- Create: `src/lib/greybox/render-mask.ts`
- Modify: `src/lib/greybox/render-to-data-uri.ts` (wire `assertHistogram` in)
- Test: browser verification (WebGL is client-side)

**Interfaces:**
- Consumes: `renderToContext`, `assertHistogram`, `GREYBOX_RENDER_W/H/ASPECT` (Task 4); `GreyboxClass`, `openingCentre` (Task 3).
- Produces: `renderGreyboxBundle(spec): { dataUri, maskDataUri, projected }` where `projected: ProjectedOpening[]` and `ProjectedOpening = { id: string; type: "door" | "window"; px: number; py: number }`. Consumed by Tasks 6 and 7.

- [ ] **Step 1: Write `render-mask.ts`**

```ts
"use client";

import * as THREE from "three";
import { buildGreyboxScene, openingCentre, type GreyboxClass } from "./build-scene";
import { greyboxCamera } from "./camera";
import {
  GREYBOX_ASPECT,
  GREYBOX_RENDER_H,
  GREYBOX_RENDER_W,
  assertHistogram,
  renderToContext,
} from "./render-to-data-uri";
import type { GreyboxRoomSpec } from "./types";

/** One opening's centre, projected to pixel coordinates in the locked camera's frame. */
export interface ProjectedOpening {
  id: string;
  type: "door" | "window";
  /** Pixel x in [0, GREYBOX_RENDER_W). -1 when the opening is behind the camera or off-frame. */
  px: number;
  /** Pixel y in [0, GREYBOX_RENDER_H). -1 when the opening is behind the camera or off-frame. */
  py: number;
}

/** Flat colours for the label pass. Values are arbitrary but must be distinct and unlit. */
const CLASS_COLOR: Record<GreyboxClass, number> = {
  wall: 0x101010,
  floor: 0x202020,
  ceiling: 0x303030,
  door: 0x404040,
  window: 0x505050,
  reveal: 0x606060,
  furniture: 0x707070,
};

function swapToFlat(scene: THREE.Scene, colorFor: (cls: GreyboxClass | undefined) => number | null) {
  const created: THREE.Material[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const color = colorFor(obj.userData.greyboxClass as GreyboxClass | undefined);
    if (color === null) {
      obj.visible = false;
      return;
    }
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    created.push(mat);
    obj.userData.originalMaterial = obj.material;
    obj.material = mat;
  });
  return created;
}

/**
 * Section 7.1's Pass B mask: same camera, same resolution, same frame,
 * openings pure white, everything else pure black, furniture hidden.
 *
 * Deliberately NOT colour-coded by opening type. A white component's type
 * comes from projectOpenings below — matching each known opening's projected
 * centre to the component containing it — so section 7.1 is followed to the
 * letter while section 4.2 still gets separate door and window counts.
 *
 * Never sent to FLUX. Stored beside the conditioning render for the ledger
 * and for debug overlays.
 */
function buildMaskScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = buildGreyboxScene(spec);
  scene.background = new THREE.Color(0x000000);
  scene.traverse((o) => {
    if (o instanceof THREE.Light) o.visible = false;
  });
  swapToFlat(scene, (cls) => {
    if (cls === "furniture") return null; // hidden — an occluded opening must not appear
    if (cls === "door" || cls === "window") return 0xffffff;
    return 0x000000;
  });
  return scene;
}

function buildLabelScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = buildGreyboxScene(spec);
  scene.background = new THREE.Color(0x000000);
  scene.traverse((o) => {
    if (o instanceof THREE.Light) o.visible = false;
  });
  swapToFlat(scene, (cls) => (cls ? CLASS_COLOR[cls] : 0x000000));
  return scene;
}

/**
 * Projects each opening's centre through the locked camera to a pixel.
 *
 * The explicit in-front dot-product test is not optional: Vector3.project()
 * mirrors points BEHIND the camera back into NDC range instead of erroring.
 * camera.ts documents hitting this exact hazard, and the ControlNet spike
 * produced pure abstract garbage because of it.
 */
export function projectOpenings(spec: GreyboxRoomSpec, camera: THREE.Camera): ProjectedOpening[] {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  return spec.openings.map((o) => {
    const world = openingCentre(spec, o);
    const inFront = world.clone().sub(camera.position).dot(forward) > 0;
    const p = world.clone().project(camera);
    const onScreen = inFront && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    return {
      id: o.id,
      type: o.type,
      px: onScreen ? Math.round(((p.x + 1) / 2) * GREYBOX_RENDER_W) : -1,
      py: onScreen ? Math.round(((1 - p.y) / 2) * GREYBOX_RENDER_H) : -1,
    };
  });
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}

function classPixelIndex(labelCtx: CanvasRenderingContext2D): Map<GreyboxClass, number[]> {
  const img = labelCtx.getImageData(0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H);
  const byValue = new Map<number, GreyboxClass>();
  for (const [cls, color] of Object.entries(CLASS_COLOR) as [GreyboxClass, number][]) {
    byValue.set(color & 0xff, cls);
  }
  const out = new Map<GreyboxClass, number[]>();
  for (let i = 0; i < img.data.length; i += 4) {
    const cls = byValue.get(img.data[i]);
    if (!cls) continue;
    const list = out.get(cls);
    if (list) list.push(i / 4);
    else out.set(cls, [i / 4]);
  }
  return out;
}

/**
 * Everything a save needs, from one set of renders through one camera: the
 * conditioning PNG, the Pass B mask PNG, and each opening's projected pixel.
 * They MUST share a camera instance — a ledger derived from a different
 * viewpoint than the reference image is worse than no ledger at all.
 */
export function renderGreyboxBundle(spec: GreyboxRoomSpec): {
  dataUri: string;
  maskDataUri: string;
  projected: ProjectedOpening[];
} {
  const camera = greyboxCamera(spec, GREYBOX_ASPECT);

  const real = buildGreyboxScene(spec);
  const realCtx = renderToContext(real, camera, { supersample: true, antialias: true });

  // Label pass: no supersample, no antialias — flat class colours must stay
  // exact so a blended edge pixel is never misread as a different class.
  const label = buildLabelScene(spec);
  const labelCtx = renderToContext(label, camera, { supersample: false, antialias: false });

  assertHistogram(realCtx.getImageData(0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H), classPixelIndex(labelCtx));

  const mask = buildMaskScene(spec);
  const maskCtx = renderToContext(mask, camera, { supersample: false, antialias: false });

  const bundle = {
    dataUri: realCtx.canvas.toDataURL("image/png"),
    maskDataUri: maskCtx.canvas.toDataURL("image/png"),
    projected: projectOpenings(spec, camera),
  };

  disposeScene(real);
  disposeScene(label);
  disposeScene(mask);
  return bundle;
}
```

- [ ] **Step 2: Verify the mask by eye**

Add a temporary button to the existing furnish page that calls `renderGreyboxBundle(spec)` and opens `maskDataUri` in a new tab. Confirm: pure black everywhere, white rectangles only where doors and windows are, no furniture visible anywhere, and the white rectangles sit in the same screen positions as the openings in the conditioning render.

Then remove the temporary button.

- [ ] **Step 3: Verify an occluded opening disappears from the mask**

Place a wardrobe directly in front of a window in the existing editor and re-render the mask. Confirm the window's white region is reduced or absent. This is the entire point of Pass B — an opening the camera cannot see must not be claimed in the prompt.

- [ ] **Step 4: Commit**

```bash
git add src/lib/greybox/render-mask.ts
git commit -m "feat: Pass B opening mask, label pass and opening projection"
```

---

## Task 6: Server-side opening counting and the upload route

**Files:**
- Create: `src/lib/greybox/count-openings.ts`
- Modify: `src/app/api/upload-greybox/route.ts`
- Modify: `src/app/api/dev-check/route.ts`
- Test: dev-check (connected components is pure and server-side, so it *is* testable there)

**Interfaces:**
- Consumes: `ProjectedOpening` (Task 5).
- Produces: `countOpenings(maskPng: Buffer, projected: ProjectedOpening[]): Promise<GreyboxLedger>`; `POST /api/upload-greybox` now takes `{projectId, dataUri, maskDataUri, projected}` and returns `{key, maskKey, ledger}`. Consumed by Tasks 7 and 13.

- [ ] **Step 1: Write `count-openings.ts`**

```ts
import "server-only";
import sharp from "sharp";
import type { GreyboxLedger } from "@/lib/types";
import type { ProjectedOpening } from "./render-mask";

/** Components smaller than this are antialiasing crumbs, not openings. */
const MIN_COMPONENT_PX = 64;
/** How far from a projected centre to search for its component, in pixels. */
const SEARCH_RADIUS = 12;

/**
 * Ground-truth opening counts from the section 7.1 Pass B mask.
 *
 * Why not just count room.placedOpenings: an opening clipped at the frame
 * edge, behind the camera, or occluded by furniture is not visible in the
 * output, and claiming it in the prompt tells the model to invent one. The
 * mask only contains what the locked camera actually sees.
 *
 * Type comes from `projected`, not from pixels — the mask is pure white per
 * section 7.1. Each opening's projected centre is looked up in the label
 * image; the component containing it inherits that opening's type. Two
 * openings that merge into one visual component count once, which is correct:
 * the model will see one aperture.
 */
export async function countOpenings(maskPng: Buffer, projected: ProjectedOpening[]): Promise<GreyboxLedger> {
  const { data, info } = await sharp(maskPng).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const labels = new Int32Array(w * h);
  const areas: number[] = [0]; // index 0 is "unlabelled"
  let next = 1;
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (data[start] < 128 || labels[start] !== 0) continue;
    const id = next++;
    let area = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    areas[id] = area;
  }

  function push(n: number) {
    if (labels[n] === 0 && data[n] >= 128) {
      labels[n] = next - 1;
      stack.push(n);
    }
  }

  const typeByLabel = new Map<number, "door" | "window">();
  for (const o of projected) {
    if (o.px < 0 || o.py < 0) continue;
    const found = labelNear(o.px, o.py);
    if (found > 0 && areas[found] >= MIN_COMPONENT_PX) typeByLabel.set(found, o.type);
  }

  function labelNear(px: number, py: number): number {
    for (let r = 0; r <= SEARCH_RADIUS; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const l = labels[y * w + x];
          if (l > 0) return l;
        }
      }
    }
    return 0;
  }

  let doors = 0;
  let windows = 0;
  for (const t of typeByLabel.values()) {
    if (t === "door") doors++;
    else windows++;
  }
  return { doors, windows };
}
```

- [ ] **Step 2: Add connected-component assertions to dev-check**

Add to `src/app/api/dev-check/route.ts`, before `const failed = ...`. These build tiny PNGs with sharp so they exercise the real decode path:

```ts
  // ---- countOpenings ----
  const mask = async (w: number, h: number, rects: [number, number, number, number][]) => {
    const raw = Buffer.alloc(w * h, 0);
    for (const [x0, y0, rw, rh] of rects) {
      for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) raw[y * w + x] = 255;
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  };

  await checkAsync("counts two separate components as two openings", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40], [120, 10, 30, 40]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "door", px: 25, py: 30 },
      { id: "b", type: "window", px: 135, py: 30 },
    ]);
    eq(ledger, { doors: 1, windows: 1 }, "one door, one window");
  });

  await checkAsync("an off-frame opening is not counted", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "window", px: 25, py: 30 },
      { id: "b", type: "window", px: -1, py: -1 },
    ]);
    eq(ledger, { doors: 0, windows: 1 }, "behind-camera opening dropped");
  });

  await checkAsync("an occluded opening (no white pixels) is not counted", async () => {
    const png = await mask(200, 100, []);
    const ledger = await countOpenings(png, [{ id: "a", type: "door", px: 25, py: 30 }]);
    eq(ledger, { doors: 0, windows: 0 }, "fully occluded opening dropped");
  });

  await checkAsync("antialiasing crumbs below the area floor are ignored", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40], [180, 90, 3, 3]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "window", px: 25, py: 30 },
      { id: "b", type: "window", px: 181, py: 91 },
    ]);
    eq(ledger, { doors: 0, windows: 1 }, "9px component dropped");
  });
```

Add this helper next to `check`, and make the handler `async`:

```ts
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
  }
}
```

Imports: `import sharp from "sharp";` and `import { countOpenings } from "@/lib/greybox/count-openings";`

- [ ] **Step 3: Run the checks**

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 9 checks passed.

- [ ] **Step 4: Extend the upload route**

Rewrite `src/app/api/upload-greybox/route.ts`'s body handling. Keep the existing guard, ownership check and `MAX_BYTES`:

```ts
interface Body {
  projectId?: string;
  dataUri?: string;
  maskDataUri?: string;
  projected?: ProjectedOpening[];
}

const PNG_RE = /^data:image\/png;base64,(.+)$/;

function decodePng(dataUri: string | undefined, label: string): Buffer | Response {
  const m = PNG_RE.exec(dataUri ?? "");
  if (!m) return Response.json({ error: `${label} must be a base64 image/png data URI` }, { status: 400 });
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_BYTES) return Response.json({ error: `${label} too large` }, { status: 400 });
  return bytes;
}
```

In the handler, after the ownership check:

```ts
  const image = decodePng(body.dataUri, "dataUri");
  if (image instanceof Response) return image;
  const maskBytes = decodePng(body.maskDataUri, "maskDataUri");
  if (maskBytes instanceof Response) return maskBytes;

  const key = `renders/${body.projectId}/greybox/${randomUUID()}.png`;
  const maskKey = `${key}-mask`;
  await putObject(key, image, "image/png");
  await putObject(maskKey, maskBytes, "image/png");

  // Derived here because the server already holds the bytes. /api/generate-room-image
  // re-derives from the stored mask rather than trusting a client-sent count,
  // so this value is for immediate UI display only.
  const ledger = await countOpenings(maskBytes, body.projected ?? []);

  return Response.json({ key, maskKey, ledger });
```

Update the file's doc comment to mention the mask and the ledger.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/greybox/count-openings.ts src/app/api/upload-greybox/route.ts src/app/api/dev-check/route.ts
git commit -m "feat: server-side opening counting from the Pass B mask"
```

---

## Task 7: Hash-gated greybox generation

Fixes the stale-key bug and drops the `room.shape` gate so manually-entered rooms get real conditioning.

**Files:**
- Modify: `src/lib/greybox/ensure-greybox-key.ts`
- Test: browser verification

**Interfaces:**
- Consumes: `greyboxHashFor` (Task 2), `renderGreyboxBundle` (Task 5), upload route shape (Task 6).
- Produces: `ensureGreybox(projectId, room): Promise<GreyboxResult | undefined>` where `GreyboxResult = Pick<Room, "greyboxKey"|"greyboxMaskKey"|"greyboxHash"|"greyboxLedger">`. **Renamed** from `ensureGreyboxKey` — the return type changed, so a rename forces every call site to be revisited rather than silently compiling against a string. Consumed by Tasks 15, 16, 17.

- [ ] **Step 1: Rewrite the module**

```ts
"use client";

import { renderGreyboxBundle } from "./render-mask";
import { greyboxHashFor } from "./greybox-hash";
import { toWorldFurniture } from "./furniture-layout";
import { seedPlacedOpenings } from "@/lib/plan-editor/geometry";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

export type GreyboxResult = Pick<Room, "greyboxKey" | "greyboxMaskKey" | "greyboxHash" | "greyboxLedger">;

/**
 * Returns this room's greybox reference, rendering and uploading a fresh one
 * whenever the cached hash no longer matches the room's current geometry.
 *
 * The hash check replaces a plain `if (room.greyboxKey) return it` short
 * circuit. Nothing in src/ ever cleared greyboxKey, so editing a door in the
 * Plan editor after generating silently reused the stale reference image.
 *
 * Deliberately does NOT write to the store — that's the caller's job (every
 * call site already has the store in scope), so this stays a plain, easily
 * followed I/O function: render, upload, return.
 */
export async function ensureGreybox(projectId: string, room: Room): Promise<GreyboxResult | undefined> {
  const openings = room.placedOpenings?.length
    ? room.placedOpenings
    : // A manually-entered room never passed through the Plan editor, so it has
      // door/window counts per side but no positions. Spreading them evenly along
      // their walls gives real opening conditioning instead of falling back to
      // text-only. room.shape is NOT required: it is the rectangle on the plan
      // IMAGE, which the greybox never reads.
      seedPlacedOpenings(room.openings ?? [], room.width, room.height);

  const hash = greyboxHashFor({ ...room, placedOpenings: openings });
  if (room.greyboxKey && room.greyboxHash === hash) {
    return {
      greyboxKey: room.greyboxKey,
      greyboxMaskKey: room.greyboxMaskKey,
      greyboxHash: room.greyboxHash,
      greyboxLedger: room.greyboxLedger,
    };
  }

  // See layoutSize's own doc comment: it must not be used to build an AI
  // prompt or display a size as fact. This doesn't — the greybox's contract is
  // camera + openings only, never a claim about the room's real size — so an
  // internal rendering proportion is a deliberate narrow exception.
  const { width, height } = layoutSize(room);
  const { dataUri, maskDataUri, projected } = renderGreyboxBundle({
    width,
    depth: height,
    openings,
    furniture: toWorldFurniture(room.furniture ?? [], width, height),
  });

  const res = await fetch("/api/upload-greybox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, dataUri, maskDataUri, projected }),
  });
  if (!res.ok) throw new Error(`Greybox upload failed (${res.status})`);
  const { key, maskKey, ledger } = (await res.json()) as {
    key: string;
    maskKey: string;
    ledger: { doors: number; windows: number };
  };
  return { greyboxKey: key, greyboxMaskKey: maskKey, greyboxHash: hash, greyboxLedger: ledger };
}
```

- [ ] **Step 2: Confirm `seedPlacedOpenings`' signature matches**

Run: `grep -n "export function seedPlacedOpenings" -A 6 src/lib/plan-editor/geometry.ts`
Expected: `(openings, widthFt?, depthFt?)`. If the parameter order or types differ, adapt the call above to match the real signature rather than changing that function.

- [ ] **Step 3: Fix the existing call sites**

Run: `grep -rn "ensureGreyboxKey" src/`

Two call sites exist on this branch: `src/app/projects/[id]/design/page.tsx` and `src/app/projects/[id]/furnish/[roomId]/page.tsx`. For each, change to:

```ts
const gb = await ensureGreybox(id, room);
if (gb) updateRoom(id, room.id, gb);
const greyboxKey = gb?.greyboxKey;
```

Both pages get rewritten later (Tasks 15 and 17) — this step exists only to keep the branch compiling and the app runnable between tasks.

- [ ] **Step 4: Verify invalidation actually fires**

With `npm run dev` running: open a project, reach the existing furnish editor for a room, save, and note the returned key. Go back to `/projects/<id>/plan`, drag a door to a visibly different position, continue, then re-enter the furnish editor and save again. **Confirm the second key differs from the first.** Before this task, it would have been identical — that was the bug.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/greybox/ensure-greybox-key.ts "src/app/projects/[id]/design/page.tsx" "src/app/projects/[id]/furnish/[roomId]/page.tsx"
git commit -m "fix: invalidate the cached greybox when room geometry changes"
```

---

## Task 8: Opening validation

Implements §5. Fail closed, never auto-repair.

**Files:**
- Create: `src/lib/greybox/validate-openings.ts`
- Modify: `src/app/api/dev-check/route.ts`
- Test: dev-check (pure function)

**Interfaces:**
- Produces: `validateOpenings(openings: PlacedOpening[], widthFt: number, depthFt: number): OpeningViolation[]` where `OpeningViolation = { openingIds: string[]; wall: GreyboxWall; message: string }`. Empty array means valid. Consumed by Tasks 15 and 16.

- [ ] **Step 1: Write the module**

```ts
/**
 * Section 5. Users cannot relocate openings, but Gemini-placed and
 * user-dragged geometry still needs checking.
 *
 * Fails CLOSED and never auto-repairs. Silently moving an opening to make a
 * render succeed breaks the one guarantee this whole product rests on — that
 * the output's doors and windows are where the user put them.
 */
import { CEILING_H, DOOR_HEAD, WINDOW_HEAD } from "./build-scene";
import type { GreyboxWall } from "./types";
import type { PlacedOpening } from "@/lib/types";

export interface OpeningViolation {
  openingIds: string[];
  wall: GreyboxWall;
  message: string;
}

/** Section 5.2 — solid wall required between adjacent openings. */
const MIN_SEPARATION_FT = 0.5;
/** Section 5.3 — corner posts are 0.22ft; an opening flush to a corner reads as a missing wall. */
const CORNER_CLEARANCE_FT = 0.75;
/** Section 5.6 — narrower than this reads as a niche, not an opening. */
const MIN_SPAN_FT = 2.0;

export function validateOpenings(
  openings: PlacedOpening[],
  widthFt: number,
  depthFt: number,
): OpeningViolation[] {
  const out: OpeningViolation[] = [];

  // Section 5.5 — assert rather than check, so a future CEILING_H change
  // cannot silently produce a wall-less opening.
  if (DOOR_HEAD >= CEILING_H || WINDOW_HEAD >= CEILING_H) {
    throw new Error(`Opening head height (${Math.max(DOOR_HEAD, WINDOW_HEAD)}ft) is not below CEILING_H (${CEILING_H}ft)`);
  }

  const wallLen = (wall: GreyboxWall) => (wall === "north" || wall === "south" ? widthFt : depthFt);
  const byWall = new Map<GreyboxWall, PlacedOpening[]>();
  for (const o of openings) {
    const list = byWall.get(o.wall);
    if (list) list.push(o);
    else byWall.set(o.wall, [o]);
  }

  for (const [wall, list] of byWall) {
    const L = wallLen(wall);
    const spans = list
      .map((o) => ({ o, lo: o.t - o.span / 2, hi: o.t + o.span / 2 }))
      .sort((a, b) => a.lo - b.lo);

    for (const s of spans) {
      const spanFt = s.o.span * L;
      if (spanFt < MIN_SPAN_FT) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} is only ${spanFt.toFixed(1)}ft wide — it reads as a niche, not an opening. Widen it to at least ${MIN_SPAN_FT}ft.`,
        });
      }
      if (s.lo < 0 || s.hi > 1) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} runs past the end of the ${wall} wall.`,
        });
        continue;
      }
      const clearance = CORNER_CLEARANCE_FT / L;
      if (s.lo < clearance || s.hi > 1 - clearance) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} sits closer than ${CORNER_CLEARANCE_FT}ft to a corner of the ${wall} wall — it will read as a missing wall.`,
        });
      }
    }

    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (cur.lo < prev.hi) {
        out.push({
          openingIds: [prev.o.id, cur.o.id],
          wall,
          message: `A ${prev.o.type} and a ${cur.o.type} overlap on the ${wall} wall.`,
        });
      } else if ((cur.lo - prev.hi) * L < MIN_SEPARATION_FT) {
        out.push({
          openingIds: [prev.o.id, cur.o.id],
          wall,
          message: `Only ${((cur.lo - prev.hi) * L).toFixed(2)}ft of solid wall between a ${prev.o.type} and a ${cur.o.type} on the ${wall} wall — at least ${MIN_SEPARATION_FT}ft is required.`,
        });
      }
    }
  }

  return out;
}
```

- [ ] **Step 2: Export `CEILING_H` if it isn't already**

Run: `grep -n "export const CEILING_H\|const CEILING_H" src/lib/greybox/build-scene.ts`
Expected: it is already exported (`CEILING_H = 10`). If it is not, add `export`.

- [ ] **Step 3: Add assertions to dev-check**

```ts
  // ---- validateOpenings ----
  const op = (id: string, wall: "north" | "south" | "east" | "west", t: number, span: number, type: "door" | "window" = "window") =>
    ({ id, type, wall, t, span }) as const;

  check("a well-placed opening passes", () => {
    eq(validateOpenings([op("a", "north", 0.5, 0.3)], 12, 10), [], "no violations");
  });

  check("overlapping openings on the same wall are rejected", () => {
    const v = validateOpenings([op("a", "north", 0.4, 0.3), op("b", "north", 0.55, 0.3)], 12, 10);
    assert(v.some((x) => x.message.includes("overlap")), `expected an overlap violation, got ${JSON.stringify(v)}`);
  });

  check("openings closer than 0.5ft of solid wall are rejected", () => {
    // 12ft wall: spans end at 0.4 and start at 0.4167 => 0.2ft apart.
    const v = validateOpenings([op("a", "north", 0.25, 0.3), op("b", "north", 0.5917, 0.3)], 12, 10);
    assert(v.some((x) => x.message.includes("solid wall")), `expected a separation violation, got ${JSON.stringify(v)}`);
  });

  check("an opening flush to a corner is rejected", () => {
    const v = validateOpenings([op("a", "north", 0.13, 0.25)], 12, 10);
    assert(v.some((x) => x.message.includes("corner")), `expected a corner violation, got ${JSON.stringify(v)}`);
  });

  check("an opening narrower than 2ft is rejected", () => {
    const v = validateOpenings([op("a", "north", 0.5, 0.1)], 12, 10);
    assert(v.some((x) => x.message.includes("niche")), `expected a min-span violation, got ${JSON.stringify(v)}`);
  });

  check("east and west walls are measured against depth, not width", () => {
    // span 0.25 on a 40ft-wide / 4ft-deep room: 1ft on the east wall -> too narrow.
    const v = validateOpenings([op("a", "east", 0.5, 0.25)], 40, 4);
    assert(v.some((x) => x.message.includes("niche")), `east wall must use depth, got ${JSON.stringify(v)}`);
  });
```

- [ ] **Step 4: Run the checks**

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 15 checks passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/greybox/validate-openings.ts src/app/api/dev-check/route.ts
git commit -m "feat: fail-closed opening geometry validation"
```

---

## Task 9: Furniture constraint solver and occlusion check

Implements §6. Hard constraints clamp during drag; occlusion is a live warning plus a save-time auto-resolve.

**Files:**
- Create: `src/lib/greybox/validate-furniture.ts`
- Modify: `src/app/api/dev-check/route.ts`
- Test: dev-check for the pure geometry; browser for the raycast

**Interfaces:**
- Consumes: `catalogueEntry` (`furniture-catalogue.ts`), `openingFaceSamples` (Task 3).
- Produces: `MAX_FURNITURE`, `footprintAabb`, `resolvePlacement`, `checkOcclusion`, `resolveOcclusion`. Consumed by Tasks 14 and 15.

- [ ] **Step 1: Write the module**

```ts
/**
 * Section 6. Occlusion is the ONLY mechanism by which furniture threatens
 * opening accuracy — an opening the camera cannot see is an opening the model
 * will invent. Furniture always yields; an opening never moves.
 *
 * Split into two kinds of rule:
 *   - resolvePlacement: hard, applied during drag. Clamps rather than
 *     rejects, so an item slides along an obstacle instead of sticking.
 *   - checkOcclusion / resolveOcclusion: needs a scene and a camera, so it
 *     runs on drag-commit for live warnings and again at save time as the
 *     gate that actually guarantees the section 6.1 threshold.
 */
import * as THREE from "three";
import { catalogueEntry } from "./furniture-catalogue";
import { openingFaceSamples } from "./build-scene";
import type { GreyboxRoomSpec } from "./types";
import type { PlacedFurniture } from "@/lib/types";

/** Section 6.3. Past ~6 the massing reads as clutter and buries the wall junctions the model needs. */
export const MAX_FURNITURE = 5;
/** Section 3.3/6.2 — corner cameras sit ~0.4ft off the wall; without this, proxies land at the lens. */
const CAMERA_EXCLUSION_FT = 2.6;
/** Section 6.3 — proxies stay off the walls. 50mm. */
const WALL_GAP_FT = 0.164;
/** Section 6.1 — every opening must be at least this visible. */
const MIN_VISIBLE_FRACTION = 0.85;
/** Rugs are floor-level planes; furniture sits on top of them by design. */
const OVERLAP_EXEMPT = new Set(["rug"]);

export interface Aabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * World-feet AABB of a placement. Rotation is folded into the box extents
 * rather than tracked as an oriented rect: section 6.3 asks for AABB overlap,
 * and a rotated-bounds approximation errs toward more clearance, never less.
 */
export function footprintAabb(kind: string, x: number, z: number, rotation: number): Aabb {
  const entry = catalogueEntry(kind);
  const w = entry?.footprintFt.w ?? 1;
  const d = entry?.footprintFt.d ?? 1;
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const ew = (w * c + d * s) / 2;
  const ed = (w * s + d * c) / 2;
  return { minX: x - ew, maxX: x + ew, minZ: z - ed, maxZ: z + ed };
}

function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export interface PlacementInput {
  kind: string;
  rotation: number;
  /** Proposed world-feet position. */
  x: number;
  z: number;
  /** Last known-good world-feet position, returned when no legal move exists. */
  fromX: number;
  fromZ: number;
}

/**
 * The nearest legal position to `proposed`. Tries the full move, then each
 * axis alone, then holds. Axis fallback is what makes dragging along a wall
 * past a sofa feel like sliding rather than sticking.
 */
export function resolvePlacement(
  input: PlacementInput,
  others: { kind: string; x: number; z: number; rotation: number }[],
  room: { width: number; depth: number },
  cameraPos: { x: number; z: number },
): { x: number; z: number } {
  const blockers = others
    .filter((o) => !OVERLAP_EXEMPT.has(o.kind))
    .map((o) => footprintAabb(o.kind, o.x, o.z, o.rotation));
  const exempt = OVERLAP_EXEMPT.has(input.kind);

  const legal = (x: number, z: number): boolean => {
    const box = footprintAabb(input.kind, x, z, input.rotation);
    if (
      box.minX < -room.width / 2 + WALL_GAP_FT ||
      box.maxX > room.width / 2 - WALL_GAP_FT ||
      box.minZ < -room.depth / 2 + WALL_GAP_FT ||
      box.maxZ > room.depth / 2 - WALL_GAP_FT
    ) {
      return false;
    }
    const reach = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2;
    if (Math.hypot(x - cameraPos.x, z - cameraPos.z) < CAMERA_EXCLUSION_FT + reach) return false;
    if (!exempt && blockers.some((b) => overlaps(box, b))) return false;
    return true;
  };

  if (legal(input.x, input.z)) return { x: input.x, z: input.z };
  if (legal(input.x, input.fromZ)) return { x: input.x, z: input.fromZ };
  if (legal(input.fromX, input.z)) return { x: input.fromX, z: input.z };
  return { x: input.fromX, z: input.fromZ };
}

export interface OcclusionViolation {
  openingId: string;
  openingType: "door" | "window";
  visibleFraction: number;
  /** id of the furniture item responsible, when one can be identified. */
  blockerId?: string;
  blockerLabel?: string;
}

/**
 * Section 6.1's raycast gate. Samples a 5x5 grid across each opening's face
 * and counts how many rays reach the opening itself rather than something in
 * front of it.
 *
 * `scene` must be the SAME scene graph being rendered, and `camera` the
 * locked export camera — a visibility answer from a different viewpoint is
 * worthless.
 */
export function checkOcclusion(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  spec: GreyboxRoomSpec,
): OcclusionViolation[] {
  const raycaster = new THREE.Raycaster();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const out: OcclusionViolation[] = [];

  for (const opening of spec.openings) {
    const samples = openingFaceSamples(spec, opening);
    let visible = 0;
    const blockers = new Map<string, number>();

    for (const p of samples) {
      const dir = p.clone().sub(origin).normalize();
      raycaster.set(origin, dir);
      const hit = raycaster.intersectObject(scene, true)[0];
      if (!hit) continue;
      if (hit.object.userData.openingId === opening.id) {
        visible++;
        continue;
      }
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.furnitureId) o = o.parent;
      if (o?.userData.furnitureId) {
        const id = o.userData.furnitureId as string;
        blockers.set(id, (blockers.get(id) ?? 0) + 1);
      }
    }

    const fraction = visible / samples.length;
    if (fraction < MIN_VISIBLE_FRACTION) {
      let worst: string | undefined;
      let worstN = 0;
      for (const [id, n] of blockers) if (n > worstN) [worst, worstN] = [id, n];
      out.push({
        openingId: opening.id,
        openingType: opening.type,
        visibleFraction: fraction,
        blockerId: worst,
      });
    }
  }

  return out;
}

/**
 * Section 6.1's fallback order, run at save time for anything the live
 * warnings did not get the user to fix: shift the blocker along its wall,
 * then shrink it, then drop it. Never moves an opening.
 *
 * Returns the adjusted furniture list plus a human-readable log, because
 * silently rearranging a user's layout is not acceptable — the caller shows
 * the log.
 */
export function resolveOcclusion(
  furniture: PlacedFurniture[],
  violations: OcclusionViolation[],
): { furniture: PlacedFurniture[]; changes: string[] } {
  if (!violations.length) return { furniture, changes: [] };
  const changes: string[] = [];
  const dropped = new Set<string>();

  for (const v of violations) {
    if (!v.blockerId || dropped.has(v.blockerId)) continue;
    const item = furniture.find((f) => f.id === v.blockerId);
    if (!item) continue;
    const label = catalogueEntry(item.kind)?.label ?? item.kind;
    dropped.add(v.blockerId);
    changes.push(`Removed the ${label.toLowerCase()} — it was blocking a ${v.openingType} the camera needs to see.`);
  }

  return { furniture: furniture.filter((f) => !dropped.has(f.id)), changes };
}
```

**Note on `resolveOcclusion`:** §6.1's full ladder is shift → shrink → drop. Shifting and shrinking require re-running the raycast against a rebuilt scene, which this pure function has no access to. It implements the terminal rung (drop) only, and the live editor warnings plus `resolvePlacement`'s hard constraints are what prevent reaching it in normal use. **This is a deliberate, flagged narrowing** — record it in the commit message so it is not mistaken for the full §6.1.

- [ ] **Step 2: Add assertions to dev-check**

```ts
  // ---- resolvePlacement ----
  const room = { width: 12, depth: 10 };
  const farCamera = { x: 5.7, z: 4.7 };

  check("a legal move is accepted unchanged", () => {
    const r = resolvePlacement(
      { kind: "bed", rotation: 0, x: 0, z: 0, fromX: -1, fromZ: -1 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "unchanged");
  });

  check("a move outside the room is refused", () => {
    const r = resolvePlacement(
      { kind: "bed", rotation: 0, x: 100, z: 100, fromX: 0, fromZ: 0 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "held at the previous position");
  });

  check("overlapping another item falls back to one axis", () => {
    // Move diagonally into a blocker at (3,3); the x-only move should be legal.
    const r = resolvePlacement(
      { kind: "side-table", rotation: 0, x: 3, z: 3, fromX: 3, fromZ: -2 },
      [{ kind: "sofa", x: 3, z: 3, rotation: 0 }],
      room,
      farCamera,
    );
    assert(r.z === -2, `expected the z move to be refused, got ${JSON.stringify(r)}`);
  });

  check("a rug may overlap other furniture", () => {
    const r = resolvePlacement(
      { kind: "rug", rotation: 0, x: 0, z: 0, fromX: -2, fromZ: -2 },
      [{ kind: "coffee-table", x: 0, z: 0, rotation: 0 }],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "rug is overlap-exempt");
  });

  check("furniture cannot be placed inside the camera exclusion zone", () => {
    const r = resolvePlacement(
      { kind: "armchair", rotation: 0, x: 5.5, z: 4.5, fromX: 0, fromZ: 0 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "refused within 2.6ft of the camera");
  });

  check("rotation widens the footprint box", () => {
    const flat = footprintAabb("bed", 0, 0, 0);
    const turned = footprintAabb("bed", 0, 0, Math.PI / 2);
    assert(
      Math.abs(flat.maxX - flat.minX - (turned.maxZ - turned.minZ)) < 1e-6,
      "a 90-degree turn should swap the extents",
    );
  });
```

- [ ] **Step 3: Run the checks**

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 21 checks passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/greybox/validate-furniture.ts src/app/api/dev-check/route.ts
git commit -m "feat: furniture placement constraints and opening occlusion check

resolveOcclusion implements only the terminal rung of section 6.1's
shift/shrink/drop ladder — shifting and shrinking need a rebuilt scene to
re-raycast against, which a pure function cannot do. resolvePlacement's hard
constraints and the editor's live warnings are what keep it from being
reached in normal use."
```

---

## Task 10: Furniture material phrases and the prompt line

Implements §4.3 and §2.5. Deletes every trace of positional prose.

**Files:**
- Modify: `src/lib/greybox/furniture-catalogue.ts`
- Modify: `src/lib/greybox/furniture-layout.ts`
- Modify: `src/app/api/dev-check/route.ts`
- Test: dev-check

**Interfaces:**
- Consumes: `MaterialTokens` (defined here, produced by Task 11's `DesignSpecification`).
- Produces: `FurnitureCatalogueEntry` gains `materialPhrase: string` and `promptPriority: number`; `buildFurnitureMaterials(furniture, tokens, budget?): string`. Consumed by Task 12.

- [ ] **Step 1: Extend the catalogue interface**

In `src/lib/greybox/furniture-catalogue.ts`:

```ts
export interface FurnitureCatalogueEntry {
  kind: string;
  label: string;
  footprintFt: { w: number; d: number };
  roomTypes: string[];
  build(): THREE.Group;
  /**
   * What this item is MADE OF, never where it is. Section 2.5: once furniture
   * is in the render, the render is the single source of spatial truth, and
   * positional prose creates a second source that can disagree with it.
   * {wood}/{soft}/{stone} interpolate from the design brief so the line
   * inherits the palette rather than restating it.
   */
  materialPhrase: string;
  /** Lower is dropped first when the furniture line exceeds its 200-char budget. */
  promptPriority: number;
}
```

- [ ] **Step 2: Add the two fields to all 23 entries**

Use exactly these values. Priority ranks by how much the piece defines the room: a bed in a bedroom matters more than a side table.

| kind | materialPhrase | promptPriority |
|---|---|---|
| `bed` | `upholstered bed in {soft}` | 100 |
| `sofa` | `{soft} sofa` | 95 |
| `dining-table` | `{wood} dining table` | 90 |
| `kitchen-island` | `{stone}-topped island` | 90 |
| `wardrobe` | `{wood} wardrobe` | 85 |
| `conference-table` | `{wood} conference table` | 85 |
| `desk` | `{wood} desk` | 80 |
| `tv-unit` | `low {wood} media console with a black screen` | 75 |
| `dining-chair` | `{soft} dining chairs` | 70 |
| `armchair` | `{soft} armchair` | 70 |
| `dresser` | `{wood} dresser` | 65 |
| `sideboard` | `{wood} sideboard` | 65 |
| `bookshelf` | `{wood} open shelving` | 60 |
| `coffee-table` | `{wood} coffee table` | 55 |
| `pooja-mandir` | `carved {wood} pooja mandir` | 55 |
| `nightstand` | `{wood} nightstands` | 50 |
| `office-chair` | `dark task chair` | 45 |
| `bar-stool` | `{wood} bar stools` | 45 |
| `console-table` | `slim {wood} console` | 40 |
| `bench` | `{wood} bench` | 35 |
| `outdoor-chair` | `woven outdoor chair` | 35 |
| `side-table` | `{wood} side table` | 30 |
| `rug` | `a soft neutral rug` | 20 |
| `plant` | `a potted green plant` | 15 |

- [ ] **Step 3: Rewrite `furniture-layout.ts`'s prompt half**

**Delete** `describeFurniturePosition` (lines 40–53) and `describeFurnitureForPrompt` (lines 61–77) entirely. Keep `toWorldFurniture`, `worldToLocal`, `furnitureId` and `defaultFurnitureFor` unchanged.

Add in their place:

```ts
export interface MaterialTokens {
  wood: string;
  soft: string;
  stone: string;
}

/**
 * Section 4.3. The furniture prompt line, derived from the SET OF TYPES
 * PRESENT — never from a hand-maintained string, and never from position.
 * Add a plant or remove a wardrobe and this line changes because the
 * derivation re-runs.
 *
 * Ordering is stable catalogue order, not insertion order: moving a piece in
 * the editor must not change the prompt text, or caches bust and A/B
 * comparisons stop being comparable.
 */
export function buildFurnitureMaterials(
  furniture: PlacedFurniture[],
  tokens: MaterialTokens,
  budget = 200,
): string {
  const present = new Map<string, number>();
  for (const f of furniture) {
    if (!catalogueEntry(f.kind)) continue;
    present.set(f.kind, (present.get(f.kind) ?? 0) + 1);
  }
  // Section 4.3: an empty array omits the line ENTIRELY, never "zero furniture pieces".
  if (present.size === 0) return "";

  let entries = FURNITURE_CATALOGUE.filter((e) => present.has(e.kind));
  const render = (list: typeof entries) =>
    `The dark massing volumes are furniture: ${joinList(list.map((e) => interpolate(e.materialPhrase, tokens)))}.`;

  // Drop lowest promptPriority first. Never truncate mid-phrase.
  while (render(entries).length > budget && entries.length > 1) {
    let worst = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].promptPriority < entries[worst].promptPriority) worst = i;
    }
    entries = entries.filter((_, i) => i !== worst);
  }

  return render(entries);
}

function interpolate(phrase: string, t: MaterialTokens): string {
  return phrase.replace(/\{wood\}/g, t.wood).replace(/\{soft\}/g, t.soft).replace(/\{stone\}/g, t.stone);
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
```

Import `FURNITURE_CATALOGUE` alongside the existing `catalogueEntry`/`furnitureForRoomType` import.

- [ ] **Step 4: Fix the now-broken import in `build-universal-input.ts` / `types.ts`**

Run: `grep -rn "describeFurnitureForPrompt\|roughPosition\|UniversalInputFurniture" src/`

Delete `UniversalInputFurniture` from `src/lib/ai/prompting/types.ts` and remove the `furniture?: UniversalInputFurniture[]` field from `UniversalInputRoom`. Furniture no longer travels as prose — Task 12 reads `PlacedFurniture` directly. Remove any `furniture:` population in `build-universal-input.ts` and at the `generateRoomImage` call sites; those call sites are rewritten in Tasks 15 and 17 anyway.

- [ ] **Step 5: Add assertions to dev-check**

```ts
  // ---- buildFurnitureMaterials ----
  const tokens = { wood: "walnut", soft: "cream boucle", stone: "marble" };
  const f = (id: string, kind: string) => ({ id, kind, x: 0.5, z: 0.5, rotation: 0 });

  check("an empty furniture list omits the line entirely", () => {
    eq(buildFurnitureMaterials([], tokens), "", "empty string, not 'zero pieces'");
  });

  check("phrases interpolate the brief's material tokens", () => {
    const line = buildFurnitureMaterials([f("1", "wardrobe")], tokens);
    assert(line.includes("walnut wardrobe"), `expected interpolation, got: ${line}`);
    assert(!line.includes("{wood}"), "token left uninterpolated");
  });

  check("output is stable catalogue order, not insertion order", () => {
    const a = buildFurnitureMaterials([f("1", "bed"), f("2", "plant")], tokens);
    const b = buildFurnitureMaterials([f("2", "plant"), f("1", "bed")], tokens);
    eq(a, b, "byte-identical regardless of insertion order");
  });

  check("duplicates of one type collapse to a single phrase", () => {
    const line = buildFurnitureMaterials([f("1", "nightstand"), f("2", "nightstand")], tokens);
    eq((line.match(/nightstand/g) ?? []).length, 1, "one mention");
  });

  check("the line never exceeds its budget and never truncates mid-phrase", () => {
    const many = ["bed", "wardrobe", "dresser", "nightstand", "bookshelf"].map((k, i) => f(String(i), k));
    const line = buildFurnitureMaterials(many, tokens, 80);
    assert(line.length <= 80, `over budget: ${line.length} chars — ${line}`);
    assert(line.endsWith("."), `truncated mid-phrase: ${line}`);
  });

  check("the lowest-priority item is dropped first under budget", () => {
    const line = buildFurnitureMaterials([f("1", "bed"), f("2", "plant")], tokens, 60);
    assert(line.includes("bed"), `bed (priority 100) should survive: ${line}`);
    assert(!line.includes("plant"), `plant (priority 15) should be dropped: ${line}`);
  });
```

- [ ] **Step 6: Run the checks and typecheck**

Run: `curl -s http://localhost:3000/api/dev-check && npx tsc --noEmit`
Expected: `"failed":0`, 27 checks passed; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/greybox/furniture-catalogue.ts src/lib/greybox/furniture-layout.ts src/lib/ai/prompting/types.ts src/lib/ai/prompting/build-universal-input.ts src/app/api/dev-check/route.ts
git commit -m "feat: furniture material phrases; delete all positional prose"
```

---

## Task 11: Compact design specification

The prompt budget is 1,800 chars total and the room brief's share is 240. The current `DesignSpecification` is inlined whole and exceeds 2,000 on its own. This cannot be fixed downstream — the planning output has to change shape.

**Files:**
- Modify: `src/lib/ai/prompting/types.ts`
- Modify: `src/lib/ai/prompting/design-planning.ts`
- Verify only (expected: no change needed): `supabase/schema.sql`
- Test: manual — one real design-plan call

**Interfaces:**
- Produces: `DesignSpecification` gains `compactBrief: string`, `materialTokens: MaterialTokens`; `RoomGuideline` gains `compactGuidance: string`. Consumed by Task 12.

- [ ] **Step 1: Extend the types**

In `src/lib/ai/prompting/types.ts`:

```ts
export interface RoomGuideline {
  room: string;
  /** Dense guidance for this room. Shown to the user; NOT sent to the image model. */
  guidance: string;
  /**
   * Section 4.4: the image prompt's per-room share is small, and `guidance`
   * routinely runs several hundred characters. This is the same intent
   * compressed to what fits.
   */
  compactGuidance: string;
}

export interface DesignSpecification {
  // Verbose fields — what the Design page shows the user and what makes a
  // spec auditable. Deliberately NO LONGER pasted into the image prompt:
  // together they exceed the whole 1800-char cap on their own.
  designLanguage: string;
  materialPalette: string;
  lightingStrategy: string;
  colourStrategy: string;
  furnitureLanguage: string;
  cameraGuidelines: string;
  negativeConstraints: string;
  /** Section 4.4's 240-char room brief: palette, key materials, light quality. */
  compactBrief: string;
  /** Interpolated into furniture material phrases (furniture-layout.ts). */
  materialTokens: MaterialTokens;
  roomGuidelines: RoomGuideline[];
}
```

Import `MaterialTokens` from `@/lib/greybox/furniture-layout`.

- [ ] **Step 2: Extend the Gemini response schema**

In `src/lib/ai/prompting/design-planning.ts`, add to `DESIGN_SPEC_SCHEMA.properties`:

```ts
    compactBrief: { type: "STRING" },
    materialTokens: {
      type: "OBJECT",
      properties: { wood: { type: "STRING" }, soft: { type: "STRING" }, stone: { type: "STRING" } },
      required: ["wood", "soft", "stone"],
    },
```

Change `roomGuidelines.items` to require `compactGuidance` too:

```ts
        properties: {
          room: { type: "STRING" },
          guidance: { type: "STRING" },
          compactGuidance: { type: "STRING" },
        },
        required: ["room", "guidance", "compactGuidance"],
```

Add `"compactBrief"`, `"materialTokens"` to the top-level `required` array.

- [ ] **Step 3: Instruct the model to produce them**

Append to the prompt body in `runDesignPlanning`, after the existing "Return a design specification covering:" paragraph:

```ts
Additionally return, for a strict character budget in a downstream image prompt:
- compactBrief: AT MOST 240 characters. One or two sentences naming the palette, the two or three \
key materials, and the quality of light. No preamble, no room names, no furniture.
- materialTokens: three short noun phrases, at most three words each, naming the specific dominant \
wood ("walnut", "light oak"), the dominant soft/upholstery material ("cream boucle", "charcoal linen") \
and the dominant stone ("carrara marble", "honed granite") for this project.
- compactGuidance, per room: AT MOST 120 characters. The single most important thing about THAT \
room's materials, colour or light. No furniture positions — a separate reference image already \
fixes those.
```

- [ ] **Step 4: Clamp defensively**

Models overshoot stated limits. At the end of `runDesignPlanning`, before returning:

```ts
  const spec = await generateStructured<DesignSpecification>(prompt, DESIGN_SPEC_SCHEMA, ctx);
  // The prompt asks for these limits; a hard clamp is what guarantees them.
  // buildRoomPrompt's 1800-char assert throws and fails the job, so an
  // overlong brief must not be able to reach it.
  return {
    ...spec,
    compactBrief: clamp(spec.compactBrief, 240),
    roomGuidelines: spec.roomGuidelines.map((g) => ({ ...g, compactGuidance: clamp(g.compactGuidance, 120) })),
  };
}

/** Trims to `max` chars at the last sentence or word boundary, so a clamp never cuts mid-word. */
function clamp(s: string | undefined, max: number): string {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (stop > max * 0.6 ? cut.slice(0, stop) : cut).trim().replace(/[,;]$/, "");
}
```

- [ ] **Step 5: Update the seeded schema row**

`templates.ts`'s doc comment says its defaults must stay in sync with `supabase/schema.sql`'s seeds. The `planning` seed rows carry only `persona`, which this task does not change — confirm that:

Run: `sed -n '716,740p' supabase/schema.sql`
Expected: the `planning` seeds insert `{"persona": ...}` only. If so, **no schema change is needed for this task**; note that in the commit message. If they carry more, update them to match `design-planning.ts`.

- [ ] **Step 6: Verify with a real call**

With `npm run dev` running, take a project through to the Design page and submit. In the browser network tab, inspect the `/api/design-plan` response and confirm: `compactBrief` is present and ≤240 chars, `materialTokens` has three non-empty strings, and every `roomGuidelines` entry has a `compactGuidance` ≤120 chars.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/prompting/types.ts src/lib/ai/prompting/design-planning.ts
git commit -m "feat: compact brief, material tokens and per-room compact guidance"
```

---

## Task 12: Prompt builder rewrite

Implements §1, §2, §4. The single highest-leverage change in this plan: the current prompt's geometry clause begins past the 512-token cut and **has never reached the model**.

**Files:**
- Modify: `src/lib/ai/prompting/prompt-builder.ts` (full rewrite)
- Modify: `src/lib/ai/prompting/templates.ts`
- Modify: `src/app/api/dev-check/route.ts`
- Test: dev-check

**Interfaces:**
- Consumes: `buildFurnitureMaterials`, `MaterialTokens` (Task 10); `DesignSpecification` (Task 11); `GreyboxLedger` (Task 1).
- Produces: `buildRoomPrompt(input, room, spec, opts): Promise<string>` where `opts: { ledger?: GreyboxLedger; furniture?: PlacedFurniture[]; hasGreybox: boolean }`. Consumed by Task 13.

- [ ] **Step 1: Neutralise the system preamble for the image path**

`withSystemPreamble` prepends `DEFAULT_SYSTEM.rules` — roughly 700 characters, 39% of the entire 1,800 budget — and it contains four things §2.4 deletes by name: `tack-sharp focus`, `not smoothed or plastic-looking`, `structurally real and buildable`, and `No people, no text or watermarks, no visible logos` (an exclusion with no negation channel, which supplies the concept).

In `src/lib/ai/prompting/templates.ts`, add:

```ts
/**
 * Section 2: the image prompt IS the section 2.2 template — there is no room
 * for a 700-char preamble under an 1800-char cap, and DEFAULT_SYSTEM.rules
 * contains four phrases section 2.4 deletes by name. Design Planning still
 * uses withSystemPreamble: it is a text/JSON call with no 512-token encoder
 * in front of it, so none of this applies there.
 */
export const IMAGE_PROMPT_HAS_NO_SYSTEM_PREAMBLE = true;
```

Leave `DEFAULT_SYSTEM`, `withSystemPreamble` and the schema seed alone — Design Planning still uses them.

- [ ] **Step 2: Rewrite `prompt-builder.ts`**

```ts
import "server-only";
import { getBuilderTemplate } from "./templates";
import { buildFurnitureMaterials } from "@/lib/greybox/furniture-layout";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "./types";
import type { GreyboxLedger, PlacedFurniture } from "@/lib/types";

/**
 * The Prompt Builder — deterministic, no AI call. The only place
 * natural-language prompt text is produced anywhere in the app.
 *
 * Section 1 is the constraint everything here follows from: FLUX.2's text
 * encoder truncates at 512 tokens (~1,800 chars) and Runware silently
 * discards the overflow — no error, no warning. The previous version of this
 * file ran ~3,500 chars with the geometry clause starting near char 2,044,
 * which means that clause NEVER REACHED THE MODEL. Every accuracy problem
 * previously attributed to prompt tuning was diagnosed against a prompt whose
 * most important paragraph had been thrown away before inference.
 *
 * Section order is a safety mechanism, not style: truncation eats the tail,
 * so geometry goes first and expendable detail goes last.
 */

/** Section 1, R1. Hard ceiling. Throw and fail the job — never send over. */
const MAX_PROMPT_CHARS = 1800;
/** Section 4.4 per-section budgets. */
const BUDGET = { brief: 240, furniture: 200, accent: 100 } as const;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Word-forms are single semantic tokens and are better represented in text-encoder space than digits. */
function word(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Section 2.2's structural contract. Fixed boilerplate — never trimmed,
 * never reordered. Both sentences about panels are true only because
 * build-scene.ts builds those exact fixtures: a recessed brown panel inside a
 * darker reveal frame, and an unlit near-white panel that is the brightest
 * thing in frame by construction.
 */
function structuralContract(hasFurniture: boolean): string {
  const furnitureClause = hasFurniture
    ? " Darker grey volumes are furniture: keep their position, footprint and approximate size."
    : "";
  return (
    "Image 1 is an untextured grey massing render of this exact room, from the exact camera the " +
    "output must use. Preserve without deviation: camera position, angle and field of view; room " +
    "proportions and all wall positions; the position, width and height of every opening. A framed " +
    "recessed panel is a closed door. A bright panel is a window. Every other surface is solid " +
    `wall.${furnitureClause} Change only surfaces, materials, lighting and furnishing.`
  );
}

/**
 * Section 4.2. Counts come from the Pass B mask, never from
 * placedOpenings.length — an opening clipped at the frame edge, behind the
 * camera, or occluded by furniture is not visible in the output, and claiming
 * it tells the model to invent one.
 */
function openingLedger(ledger: GreyboxLedger, furnitureCount: number): string {
  const parts: string[] = [];
  const { doors, windows } = ledger;
  if (windows > 0 && doors > 0) {
    parts.push(`The room has ${word(windows)} ${plural(windows, "window")} and ${word(doors)} ${plural(doors, "door")}.`);
  } else if (windows > 0) {
    parts.push(`The room has ${word(windows)} ${plural(windows, "window")}.`);
  } else if (doors > 0) {
    parts.push(`The room has ${word(doors)} ${plural(doors, "door")}.`);
  } else {
    parts.push("Every wall in this room is solid.");
  }
  if (doors > 0) parts.push("All doors are closed.");
  if (furnitureCount > 0) {
    parts.push(`${cap(word(furnitureCount))} furniture ${plural(furnitureCount, "piece")} are already placed.`);
  }
  return parts.join(" ");
}

export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: { ledger?: GreyboxLedger; furniture?: PlacedFurniture[]; hasGreybox: boolean },
): Promise<string> {
  const builder = await getBuilderTemplate();
  const furniture = opts.furniture ?? [];

  // 1. Medium + lens. No focal length: section 2.3 tested naming one against a
  //    real output and rejected it — FLUX.2 renormalises perspective to ~20-24mm
  //    without moving openings, and naming a focal length buys camera fidelity
  //    that isn't required at the cost of barrel distortion.
  const medium = "Photorealistic interior photograph, wide angle, eye level.";

  // 2. Structural contract, or a one-line geometry statement when there is no
  //    reference image. One code path, one budget, one assert.
  const contract = opts.hasGreybox
    ? structuralContract(furniture.length > 0)
    : `A ${input.design.luxury_level.toLowerCase()} "${input.design.style}" ${input.project.subcategory}. ` +
      "Straight walls, level camera, eye level.";

  // 3. Opening ledger.
  const ledger = opts.hasGreybox && opts.ledger ? openingLedger(opts.ledger, furniture.length) : "";

  // 4. Room brief.
  const roomLabel =
    room.type && room.type.trim() && room.type.trim().toLowerCase() !== room.name.trim().toLowerCase()
      ? `${room.name}, a ${room.type.toLowerCase()}`
      : room.name;
  const guidance = spec.roomGuidelines.find((g) => g.room === room.name)?.compactGuidance ?? "";
  // Section 2.4: room dimensions in feet are deleted — the greybox encodes
  // proportion far more precisely than a number in prose can.
  const brief = [`${cap(roomLabel)}.`, spec.compactBrief, guidance].filter(Boolean).join(" ").slice(0, BUDGET.brief);

  // 5. Furniture materials. Derived from the set of types present; empty
  //    furniture omits the line entirely.
  const furnitureLine = buildFurnitureMaterials(furniture, spec.materialTokens, BUDGET.furniture);

  // 6. Accent — optional, always last, engineered to be the thing that gets
  //    cut if anything gets cut.
  const accent = (room.additional_notes?.trim() ?? "").slice(0, BUDGET.accent);

  const sections = [medium, contract, ledger, brief, furnitureLine, accent].filter(Boolean);
  let prompt = sections.join("\n\n");

  // Section 4.4 overflow order: drop accent, then trim furniture by priority,
  // then trim brief. NEVER the contract or the ledger.
  if (prompt.length > MAX_PROMPT_CHARS && accent) {
    prompt = [medium, contract, ledger, brief, furnitureLine].filter(Boolean).join("\n\n");
  }
  if (prompt.length > MAX_PROMPT_CHARS && furnitureLine) {
    const tighter = buildFurnitureMaterials(furniture, spec.materialTokens, 100);
    prompt = [medium, contract, ledger, brief, tighter].filter(Boolean).join("\n\n");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    const headroom = MAX_PROMPT_CHARS - (prompt.length - brief.length);
    prompt = [medium, contract, ledger, brief.slice(0, Math.max(0, headroom - 8))].filter(Boolean).join("\n\n");
  }

  // Section 1, R1: throw rather than send. Runware accepts up to 32,000 chars
  // and silently discards everything past the encoder's limit, so an overlong
  // prompt fails invisibly — which is exactly how the old geometry clause was
  // lost for weeks without a single error.
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS} limit for room "${room.name}"`);
  }

  // Section 1, R3.
  console.log(`[prompt-builder] room="${room.name}" chars=${prompt.length} hash=${hash(prompt)}`);
  void builder;
  return prompt;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
```

**Note on `builder`:** `getBuilderTemplate`'s `intro`/`cameraPrefix`/`negativePrefix` are all deleted content under §2.4 (`cameraPrefix` restates a camera the reference already fixes; `negativePrefix` introduces exclusions with no negation channel). The `void builder` line keeps the fetch in place so an operator's published template row is not silently ignored without explanation — **replace it with a real use or delete the fetch entirely** as the last step of Task 17's cleanup, once you can confirm no `builder` row is published in the live database.

- [ ] **Step 3: Add prompt assertions to dev-check**

```ts
  // ---- buildRoomPrompt ----
  const uiInput = {
    project: { category: "Residential", subcategory: "Independent House" },
    layout: { rooms: [] },
    design: { style: "Modern", luxury_level: "Premium" as const, colour_palette: "warm neutrals" },
  };
  const uiRoom = { name: "Master Bedroom", type: "Bedroom" };
  const dspec = {
    designLanguage: "x".repeat(400),
    materialPalette: "x".repeat(400),
    lightingStrategy: "x".repeat(400),
    colourStrategy: "x".repeat(400),
    furnitureLanguage: "x".repeat(400),
    cameraGuidelines: "x".repeat(400),
    negativeConstraints: "x".repeat(400),
    compactBrief: "Warm neutrals over walnut and honed limestone, soft morning light from one side.",
    materialTokens: { wood: "walnut", soft: "cream boucle", stone: "honed limestone" },
    roomGuidelines: [{ room: "Master Bedroom", guidance: "y".repeat(500), compactGuidance: "Keep the palette calm." }],
  };

  await checkAsync("the verbose design spec never reaches the prompt", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 1, windows: 2 } });
    assert(!p.includes("x".repeat(50)), "a verbose field leaked into the prompt");
    assert(!p.includes("y".repeat(50)), "verbose room guidance leaked into the prompt");
  });

  await checkAsync("prompt stays under the 1800-char cap", async () => {
    const p = await buildRoomPrompt(uiInput, { ...uiRoom, additional_notes: "z".repeat(2000) }, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 2 },
      furniture: [f("1", "bed"), f("2", "nightstand"), f("3", "wardrobe")],
    });
    assert(p.length <= 1800, `prompt is ${p.length} chars`);
  });

  await checkAsync("the ledger uses number words, not digits", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 1, windows: 2 } });
    assert(p.includes("two windows and one door"), `expected word-form counts, got: ${p}`);
    assert(!/\b[0-9]+ (window|door)/.test(p), "digits used for opening counts");
  });

  await checkAsync("no deleted phrasing survives", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: [f("1", "bed")],
    });
    for (const banned of ["defect", "Count them", "Do not", "no more", "tack-sharp", "watermark", "near the"]) {
      assert(!p.toLowerCase().includes(banned.toLowerCase()), `banned phrasing "${banned}" is still in the prompt`);
    }
  });

  await checkAsync("a room with no openings gets a positive statement", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 0, windows: 0 } });
    assert(p.includes("Every wall in this room is solid."), `expected positive phrasing, got: ${p}`);
  });

  await checkAsync("the same inputs produce a byte-identical prompt", async () => {
    const args = [uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 1, windows: 1 }, furniture: [f("1", "bed")] }] as const;
    eq(await buildRoomPrompt(...args), await buildRoomPrompt(...args), "deterministic");
  });
```

- [ ] **Step 4: Run the checks**

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 33 checks passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/prompting/prompt-builder.ts src/lib/ai/prompting/templates.ts src/app/api/dev-check/route.ts
git commit -m "feat: rewrite the prompt builder against the 512-token budget

The old prompt ran ~3500 chars with the geometry clause starting near char
2044 — past FLUX.2's encoder cut, silently discarded by Runware. That clause
never reached the model."
```

---

## Task 13: Generation route, aspect lock and the dimension probe

**Files:**
- Modify: `src/app/api/generate-room-image/route.ts`
- Modify: `src/lib/render/runware-client.ts`
- Test: one real generation

**Interfaces:**
- Consumes: `countOpenings` (Task 6), `buildRoomPrompt` (Task 12), `GREYBOX_RENDER_W/H` (Task 4).
- Produces: `generateImage(prompt, ctx, { referenceImages, width, height })`.

- [ ] **Step 1: Re-derive the ledger server-side**

In `src/app/api/generate-room-image/route.ts`, extend `Body` with `furniture?: PlacedFurniture[]` and `greyboxMaskKey?: string`, then replace the prompt/reference block:

```ts
    // Re-derived from the stored mask rather than trusting a client-sent
    // count: section 4.1 requires the prompt to be a pure function of
    // persisted artifacts. One getObject plus one sharp decode, a few ms.
    let ledger: GreyboxLedger | undefined;
    if (greyboxKey && body.greyboxMaskKey) {
      ledger = await countOpenings(await getObject(body.greyboxMaskKey), body.projected ?? []);
    }

    const prompt = await buildRoomPrompt(universalInput, room, designSpec, {
      hasGreybox: !!greyboxKey,
      ledger,
      furniture: body.furniture,
    });
    const referenceImages = greyboxKey ? [await loadGreyboxDataUri(greyboxKey)] : undefined;
    const referenceImageUrls = greyboxKey ? [`/api/render?key=${encodeURIComponent(greyboxKey)}`] : undefined;
    const image = await generateImage(
      prompt,
      { projectId, userId: guard.id },
      { referenceImages, referenceImageUrls, width: GREYBOX_RENDER_W, height: GREYBOX_RENDER_H },
    );
```

Add `projected?: ProjectedOpening[]` to `Body` as well — the client already has it from `renderGreyboxBundle` and it is what types each mask component.

- [ ] **Step 2: Thread width/height through the provider**

In `src/lib/ai/provider.ts`, add `width?: number; height?: number` to `generateImage`'s options type and pass them into `generateImageWithRunware`. In `src/lib/render/runware-client.ts`, accept them and use them **in place of** the `IMAGE_DIMENSIONS` lookup whenever they are supplied:

```ts
  // Section 3.4: the generation aspect must equal the greybox render aspect
  // exactly. Any mismatch and FLUX letterboxes or crops, which breaks the
  // camera match the entire pipeline depends on.
  const w = opts.width ?? IMAGE_DIMENSIONS[tier].width;
  const h = opts.height ?? IMAGE_DIMENSIONS[tier].height;
  if (opts.referenceImages?.length) {
    const drift = Math.abs(w / h - GREYBOX_ASPECT);
    if (drift > 0.002) {
      throw new Error(`Generation aspect ${(w / h).toFixed(4)} does not match the greybox aspect ${GREYBOX_ASPECT.toFixed(4)}`);
    }
  }
```

- [ ] **Step 3: Remove the negative-prompt fold**

Find the `bfl` branch that currently does:

```ts
positivePrompt: bfl ? `${prompt}\n\nAvoid: ${REALISM_NEGATIVE_PROMPT}.` : prompt,
```

Replace with `positivePrompt: prompt`. Add above it:

```ts
  // Section 2.4: there is no negativePrompt on bfl:5@1 or bfl:6@1. Writing
  // exclusions into the POSITIVE prompt supplies the concept with no negation
  // channel — it makes the excluded thing more likely, not less. Modern
  // interior-photography priors already exclude people, text and watermarks.
```

Leave the non-`bfl` `negativePrompt` branch alone; those models do have the channel.

- [ ] **Step 4: Probe whether 1376 is accepted**

This is the one runtime unknown. `bfl:5@1` may require dimensions divisible by 64, as FLUX.1-dev did — the ControlNet spike hit a hard `invalidWidth` 400 on exactly 1376.

With `npm run dev` running, take one room all the way to a real generation with a greybox reference attached, and watch the server log.

- **If it succeeds:** leave `GREYBOX_RENDER_W/H` at 1376×768. Record "1376×768 accepted on bfl:5@1" in the commit message.
- **If Runware returns `invalidWidth`:** change `GREYBOX_RENDER_W = 1280` and `GREYBOX_RENDER_H = 704` in `render-to-data-uri.ts` — nothing else moves, because that constant is the only place dimensions are decided. Bump `GREYBOX_RENDER_VERSION` to `3` so every cached greybox re-renders at the new size. Re-run the generation and confirm success.

- [ ] **Step 5: Verify the prompt actually shrank**

In the same server log, find the `[prompt-builder]` line. Confirm `chars=` is between roughly 900 and 1,500. If it is over 1,800 the build would have thrown; if it is under 600 something is being dropped that shouldn't be — inspect the assembled prompt before continuing.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/generate-room-image/route.ts" src/lib/render/runware-client.ts src/lib/ai/provider.ts src/lib/greybox/render-to-data-uri.ts
git commit -m "feat: lock generation aspect to the greybox, derive the ledger from the mask"
```

---

## Task 14: Fixed-camera furniture editor canvas

Implements §0's "no orbit, no user camera control" and §6's live feedback. This is a rewrite of `furniture-editor-canvas.tsx`, not an edit.

**Files:**
- Modify: `src/components/project/furniture-editor-canvas.tsx` (full rewrite)
- Test: browser

**Interfaces:**
- Consumes: `resolvePlacement`, `checkOcclusion`, `footprintAabb` (Task 9); `buildGreyboxScene`, `greyboxCamera`; `worldToLocal`, `toWorldFurniture`.
- Produces: props `{ spec, furniture, selectedId, onSelect, onCommit, onOcclusionChange }`. Consumed by Task 15.

- [ ] **Step 1: Delete orbit and the frustum helper**

Remove the `OrbitControls` import, its construction, `controls.update()` from the animation loop, `controls.enabled` toggling in the drag handlers, and the `THREE.CameraHelper` that drew the locked camera's frustum. The helper existed only to show the user where the export camera was — the viewport is now that camera, so it would draw a wireframe of itself.

- [ ] **Step 2: Use the locked camera**

```ts
    // Section 0: no orbit, no reposition, no FOV control. The viewport IS the
    // export camera, so what the user arranges is exactly what FLUX receives.
    // greyboxCamera is deterministic — the same room always yields the same
    // viewpoint, and a regenerated image must never silently change framing.
    const camera = greyboxCamera(spec, width / height);
```

Rebuild the camera whenever `spec.width`/`spec.depth`/`spec.openings` change (not on furniture change — furniture must never move the camera).

- [ ] **Step 3: Single-gesture drag**

The old click-to-select-then-drag two-step existed only so drag would not fight orbit. Replace with: pointerdown raycasts against `roomGroup` and selects; if a hit was found, the same gesture begins dragging.

```ts
    function onPointerDown(e: PointerEvent) {
      const hit = pickFurniture(e);
      onSelect(hit?.userData.furnitureId ?? null);
      if (!hit) return;
      dragRef.current = {
        id: hit.userData.furnitureId as string,
        from: { x: hit.position.x, z: hit.position.z },
      };
      canvas.setPointerCapture(e.pointerId);
    }
```

- [ ] **Step 4: Constrain every drag move**

```ts
    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const p = raycastFloor(e); // THREE.Plane(0,1,0) at y=0, as today
      if (!p) return;
      const item = furniture.find((f) => f.id === drag.id);
      if (!item) return;
      const others = toWorldFurniture(
        furniture.filter((f) => f.id !== drag.id),
        spec.width,
        spec.depth,
      );
      const { x, z } = resolvePlacement(
        { kind: item.kind, rotation: item.rotation, x: p.x, z: p.z, fromX: drag.from.x, fromZ: drag.from.z },
        others,
        { width: spec.width, depth: spec.depth },
        { x: camera.position.x, z: camera.position.z },
      );
      // Mutate the live Group during the gesture; React state commits on
      // pointerup, so the scene is rebuilt once per drag rather than per frame.
      group.position.set(x, 0, z);
      drag.from = { x, z };
    }
```

On pointerup, call `onCommit(id, worldToLocal(x, z, spec.width, spec.depth))` and release the pointer capture.

- [ ] **Step 5: Draw the camera exclusion arc**

Add a `THREE.RingGeometry` of radius 2.6 ft centred at `(camera.position.x, 0.02, camera.position.z)`, rotated flat, in a translucent unlit material. Tag it `userData.helper = true` and **exclude helpers from the raycast and from `renderGreyboxBundle`** — it is an editor affordance, never part of the conditioning render.

Without this the 2.6 ft dead zone is invisible and dragging into it looks like a bug.

- [ ] **Step 6: Report occlusion after every commit**

```ts
    // Cheap enough to run on commit (25 rays per opening), far too expensive
    // per frame. Runs against the same scene and the same locked camera the
    // render uses, so the answer is the real one, not an approximation.
    const violations = checkOcclusion(roomGroup, camera, specWithFurniture);
    onOcclusionChange(violations);
```

Give any furniture item named as a `blockerId` an amber emissive tint so the offending object is identifiable in the viewport, not only in the sidebar.

- [ ] **Step 7: Keyboard handlers**

On the canvas element, with a selected item:
- `ArrowLeft/Right` → x ∓ 0.25 ft; `ArrowUp/Down` → z ∓ 0.25 ft. Route through `resolvePlacement` exactly as drag does.
- `[` / `]` → rotation ∓ `Math.PI / 12`. After rotating, re-run `resolvePlacement` at the item's current position — a rotation can create an overlap that the position alone did not have.
- `Delete` / `Backspace` → `onCommit(id, null)` (the page interprets `null` as remove).

Call `e.preventDefault()` on all of these so arrow keys don't scroll the page.

- [ ] **Step 8: Verify in the browser**

With `npm run dev`, open `/projects/<id>/furnish/<roomId>` and confirm every one of these:
1. Dragging with the mouse does **not** rotate or move the camera — the viewpoint is frozen.
2. Dragging a wardrobe into a sofa slides it along instead of passing through.
3. Dragging toward the camera stops at the visible exclusion arc.
4. Dragging a wardrobe in front of a window turns it amber and reports an occlusion warning.
5. Arrow keys nudge the selected item; `[`/`]` rotate it; Delete removes it.
6. The room's proportions and the door/window positions match the plan.

- [ ] **Step 9: Commit**

```bash
git add src/components/project/furniture-editor-canvas.tsx
git commit -m "feat: fixed-camera furniture editor with live placement constraints

Drops OrbitControls entirely (section 0: no user camera control). The
viewport is now the locked 85-degree export camera, so the arrangement the
user sees is exactly what FLUX receives."
```

---

## Task 15: Furnish editor page

**Files:**
- Modify: `src/app/projects/[id]/furnish/[roomId]/page.tsx` (full rewrite)
- Test: browser

**Interfaces:**
- Consumes: Task 14's canvas props; `ensureGreybox` (Task 7); `MAX_FURNITURE`, `resolveOcclusion` (Task 9); `validateOpenings` (Task 8).
- Produces: the `?from=generate` return contract used by Task 17.

- [ ] **Step 1: Sidebar — add, list, cap**

Render add-buttons from `furnitureForRoomType(room.type)`. Disable all of them and show `Room is full (5 of 5)` when `furniture.length >= MAX_FURNITURE` — §6.3 requires the cap in the editor UI, not only at render.

New items are placed by a deterministic search rather than a fixed offset, because with a fixed camera an item dropped behind the viewpoint is unreachable:

```ts
  /**
   * First position that is in frame, legal, and non-overlapping. Scans a
   * coarse grid in a fixed order so adding the same item to the same room
   * always lands in the same place. With a locked camera an item placed
   * outside the frustum or inside the exclusion arc cannot be dragged out,
   * so "somewhere reasonable" is not good enough.
   */
  function firstFreeSlot(kind: string): { x: number; z: number } | null {
    for (let iz = 1; iz <= 6; iz++) {
      for (let ix = 1; ix <= 6; ix++) {
        const lx = ix / 7;
        const lz = iz / 7;
        const wx = (lx - 0.5) * width;
        const wz = (lz - 0.5) * depth;
        const r = resolvePlacement(
          { kind, rotation: 0, x: wx, z: wz, fromX: NaN, fromZ: NaN },
          toWorldFurniture(furniture, width, depth),
          { width, depth },
          { x: cameraPos.x, z: cameraPos.z },
        );
        if (r.x === wx && r.z === wz && isInFrame(wx, wz)) return { x: lx, z: lz };
      }
    }
    return null;
  }
```

When it returns `null`, show `No free space left in this room` rather than adding an item nobody can see.

`isInFrame` projects `(wx, 1.5, wz)` through the locked camera and checks `|x| < 0.9 && |y| < 0.9` with the same in-front dot-product test `camera.ts` uses.

- [ ] **Step 2: Warning panel**

Under the viewport, list occlusion warnings from the canvas's `onOcclusionChange`:

> ⚠ The wardrobe blocks the north window. Move it or the generated room may show a wall there instead.

Also run `validateOpenings(room.placedOpenings ?? [], width, depth)` on mount. If it returns violations, render them as a **blocking** banner with a link to `/projects/<id>/plan` — §5 fails closed and openings are read-only here, so the user must fix them where they were made.

- [ ] **Step 3: Save**

```ts
  async function save(): Promise<string | undefined> {
    // Section 6.1's save-time gate for anything the live warnings did not get
    // fixed. Furniture always yields; an opening never moves.
    const { furniture: resolved, changes } = resolveOcclusion(furniture, occlusion);
    if (changes.length) {
      setNotice(changes);
      updateRoom(id, roomId, { furniture: resolved });
    }
    const gb = await ensureGreybox(id, { ...room, furniture: resolved });
    if (gb) setRoomGreybox(id, roomId, { furniture: resolved, ...gb });
    return gb?.greyboxKey;
  }
```

`setNotice` renders the change log — silently rearranging a user's layout is not acceptable.

- [ ] **Step 4: Save / Generate / return**

- `Save` → `save()`, then `router.push(from === "generate" ? \`/projects/${id}/generate\` : \`/projects/${id}/furnish\`)`, where `from` is `useSearchParams().get("from")`.
- `Generate` → `save()`, then `generateRoomImage({..., greyboxKey, greyboxMaskKey, projected, furniture})`, `addGeneration`, and render the result inline in the sidebar via `RetryImg`. **Does not navigate** — it is the fastest loop for judging whether a layout reads correctly.

- [ ] **Step 5: Empty state**

`ensureGreybox` returns `undefined` only when there is nothing renderable. Show: *"Add this room's dimensions in Room Confirmation to arrange furniture in 3D"* with a link to `/review`. Do **not** gate on `room.shape` — Task 7 removed that requirement.

- [ ] **Step 6: Verify**

Open the page from the gallery and from `/generate?from=generate`. Confirm the cap blocks the sixth item, warnings appear and clear, Save returns to the right page in each case, Generate shows an image without navigating, and the occlusion change-log notice appears when a blocker is auto-removed.

- [ ] **Step 7: Commit**

```bash
git add "src/app/projects/[id]/furnish/[roomId]/page.tsx"
git commit -m "feat: furnish editor page with placement warnings and save-time occlusion gate"
```

---

## Task 16: Furnish gallery

**Files:**
- Create: `src/lib/greybox/render-queue.ts`
- Create: `src/components/project/furnish-room-card.tsx`
- Create: `src/app/projects/[id]/furnish/page.tsx`
- Test: browser, with a multi-room project

- [ ] **Step 1: Serial render queue**

```ts
"use client";

/**
 * Greybox rendering is client-side WebGL. Rendering a seven-room gallery in
 * parallel opens seven WebGL contexts at once and hits the browser's ~16
 * context cap with unpredictable eviction — a card whose context is evicted
 * mid-render produces a blank or partial PNG and uploads it as if it were
 * fine. One at a time, always.
 */
type Job<T> = () => Promise<T>;

let chain: Promise<unknown> = Promise.resolve();

export function enqueueGreyboxRender<T>(job: Job<T>): Promise<T> {
  const run = chain.then(job, job);
  // Keep the chain alive regardless of individual failures: one room that
  // cannot render must not stall every room behind it.
  chain = run.catch(() => undefined);
  return run;
}
```

- [ ] **Step 2: The card**

`furnish-room-card.tsx` renders, in order of preference: the greybox image from `/api/render?key=<greyboxKey>` once available; a skeleton while its queue slot is pending; or a muted "Add dimensions in Room Confirmation" state with a link to `/review` when `ensureGreybox` returned `undefined`.

Below the image: room name, dimensions, and either `N pieces` with a filled dot or `Empty`. The whole card is a button that routes to `/projects/<id>/furnish/<roomId>`.

- [ ] **Step 3: The gallery page**

Header: *"Furnish your rooms — place furniture where you want it. Skip any room to generate it empty."* with an `N of M furnished` count.

On mount, for each room, `enqueueGreyboxRender(() => ensureGreybox(id, room))` and write each result back with `setRoomGreybox`. Because `ensureGreybox` is hash-gated, revisiting the gallery re-renders nothing that has not changed.

`Continue →` routes to `/design` and is **always enabled** — an unfurnished room generates from an openings-only greybox, which is §10's Phase 1 baseline and is the configuration that scored 4/5.

Surface `validateOpenings` failures per card as a red badge linking to `/plan`.

- [ ] **Step 4: Verify with a multi-room project**

Open `/projects/<id>/furnish` on a project with at least four rooms. Confirm: cards fill in **one at a time**, never all at once; every image matches its room's proportions and openings; reloading the page re-renders nothing (check the network tab for absent `/api/upload-greybox` calls); Continue is enabled with zero rooms furnished.

- [ ] **Step 5: Commit**

```bash
git add src/lib/greybox/render-queue.ts src/components/project/furnish-room-card.tsx "src/app/projects/[id]/furnish/page.tsx"
git commit -m "feat: furnish gallery with serial greybox rendering"
```

---

## Task 17: Flow wiring, side-by-side versions and cleanup

**Files:**
- Modify: `src/app/projects/[id]/review/page.tsx`
- Modify: `src/app/projects/[id]/design/page.tsx`
- Modify: `src/app/projects/[id]/generate/page.tsx`
- Modify: `src/components/project/workspace-frame.tsx`
- Delete: `src/components/project/greybox-preview.tsx`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Route Review → Furnish**

In `review/page.tsx`, change the Continue handler's destination from `/design` to `/furnish`.

- [ ] **Step 2: Demote the design page's greybox call**

`design/page.tsx` currently renders the greybox lazily inside its auto-fire generation loop. The gallery now does that earlier, so this becomes a fallback for a room the user reached by a route that skipped Furnish. Keep the `ensureGreybox` call, keep writing the result back with `setRoomGreybox`, and pass `greyboxKey`, `greyboxMaskKey`, `projected` and `furniture` into `generateRoomImage`.

- [ ] **Step 3: Side-by-side generations**

In `generate/page.tsx`, replace the `latest` + `olderVersions` split (lines ~172–200) with a single horizontally scrollable row of equal-size tiles in **chronological order, newest rightmost**:

```tsx
      <div className="flex gap-3 overflow-x-auto pb-2" ref={stripRef}>
        {generations.map((gen, i) => (
          <GenerationTile
            key={gen.id}
            gen={gen}
            version={i + 1}
            isLatest={i === generations.length - 1}
            onOpen={() => router.push(`/projects/${id}/generate/${room.id}?v=${gen.id}`)}
          />
        ))}
      </div>
```

Auto-scroll to the newest on arrival and after each generation:

```tsx
  useEffect(() => {
    stripRef.current?.scrollTo({ left: stripRef.current.scrollWidth, behavior: "smooth" });
  }, [generations.length]);
```

The previous image keeps its position and size and the new one lands beside it — direct comparison is the whole point.

- [ ] **Step 4: Relabel and re-gate the 3D entry point**

The card action currently reads `Furnish` and is gated on `room.shape`. Relabel it **Adjust with 3D** and gate it on the same condition the gallery uses — dimensions available, not `shape`. Route to `/projects/<id>/furnish/<roomId>?from=generate`.

- [ ] **Step 5: Add Furnish to the stepper**

`workspace-frame.tsx` renders `PHASES`. Confirm the new entry appears in order and that clicking it navigates. Fix the phase→href mapping if it is hardcoded anywhere rather than derived from `PHASES`.

- [ ] **Step 6: Delete dead code**

```bash
git rm src/components/project/greybox-preview.tsx
```

It was Phase 0 spike scaffolding with zero callers, superseded by `render-to-data-uri.ts`.

Then resolve the `void builder` note from Task 12:

Run: `grep -rn "getBuilderTemplate" src/`
If `prompt-builder.ts` is the only remaining consumer, delete the `getBuilderTemplate` call and the `void builder` line from it. Leave the function itself in `templates.ts` — the `prompt_templates` row and its admin UI still exist.

- [ ] **Step 7: Full verification pass**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all three clean.

Run: `curl -s http://localhost:3000/api/dev-check`
Expected: `"failed":0`, 33 checks passed.

Then walk one project end to end in the browser: upload → plan → review → **furnish** (furnish two rooms, skip the rest) → design → generate → adjust one room with 3D → generate again → confirm the new image appears **beside** the old → approve → walkthrough.

- [ ] **Step 8: Update CLAUDE.md**

The "AI prompting pipeline" section's flow list is now wrong. Update it to `upload → plan → review → furnish → design → generate → approve → walkthrough`, and add a short paragraph describing `src/lib/greybox/` — the greybox reference-image pipeline, the locked camera, the Pass B mask, and the 1,800-char prompt budget. Note that `/api/dev-check` is this repo's stand-in for a test suite.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire the furnish phase into the flow; side-by-side generations"
```

---

## Deferred — explicitly not in this plan

Per the scope decision recorded in the design doc §0:

- §7.2 two-tier validation gate (deterministic CV sampling + VLM structured check)
- §7.3 deterministic per-attempt seeds and the max-3 retry loop
- §9 calibration harness (8 seeds × 5 arms)
- §10 phased furniture rollout gating

`resolveOcclusion` implements only the terminal rung of §6.1's shift → shrink → drop ladder (Task 9).

`GREYBOX_RENDER_W/H` may end at 1280×704 rather than §3.4's literal 1376×768, depending on Task 13 Step 4's probe. The rule §3.4 exists to enforce — render aspect equals generation aspect — holds either way and is asserted.
