# Greybox Opening Placement — Phase 0 (Proof Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove — with two real generated images side by side — that conditioning Nano Banana on a perspective greybox render places doors and windows where we specify, and that today's text-only path does not.

**Architecture:** A room is built as a crude untextured 3D box (floor, ceiling, four walls, openings cut into the walls) with three.js in the browser, rendered from an automatic camera at 16:9. That PNG is sent to Nano Banana via Runware's `inputs.referenceImages` alongside a strict geometry-preservation prompt. The same room is also generated through the existing text-only path. Both results are displayed together for judgement.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, three.js (new), Runware REST API (Nano Banana `google:4@3`), sharp.

**Spec:** `docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md`

## Global Constraints

- **This repo has no test runner.** CLAUDE.md states it outright. Do not add one — that is a separate decision, not this spike's call. Verification in every task below is: `npx tsc --noEmit`, `npm run lint`, and direct browser/API observation. Every "verify" step names exactly what to run and what to look for.
- **Read `node_modules/next/dist/docs/` before writing Next-specific code.** Per `AGENTS.md`: this Next version has breaking changes versus training data.
- **Everything in this phase is throwaway except two files** — `src/lib/greybox/*` and the `referenceImages` support in the provider layer are real production code that Phases 1–3 build on. The spike page and spike API route are deliberately disposable.
- **The spike route and page MUST hard-404 in production.** They bypass `assertAllowed` (auth + rate limit + usage checks), so an unguarded route would be an unauthenticated, unmetered, billed image-generation endpoint.
- **Do not modify** `extract-plan.ts`, `prompt-builder.ts`, `build-universal-input.ts`, the `review` page, or the `Room` type in this phase. Data-model changes belong to Phase 1, after the gate.
- **Do not change the existing provider fallback chain.** `referenceImages` is an additive optional parameter; when absent, every existing call site must behave byte-for-byte as it does today.
- Ceiling height constant: `10` (feet). Door head height: `7`. Window sill: `3`, window head: `7`.
- Greybox render aspect ratio: **16:9**. Render size `1376 x 768`.

## Spike room spec — hand-authored, and why

Grounded in the top-right `BEDROOM 13'1" x 14'9"` of `3BHK-house-plan-ground-floor.jpg` (its printed dimensions are used verbatim: `13.08 x 14.75`). The opening positions are **hand-authored, not traced** — the source JPEG is 563x704 and its wall breaks cannot be read to the precision this test needs.

That is deliberate and does not weaken the spike. What is being measured is *"did the model put the opening where we said?"* — which requires the target positions to be **asymmetric and exactly known**, not that they match this particular JPEG. Symmetric or centred openings would let a lucky guess pass as a success.

```ts
const SPIKE_ROOM: GreyboxRoomSpec = {
  width: 13.08,  // east-west
  depth: 14.75,  // north-south
  openings: [
    { id: "d1", type: "door",   wall: "south", t: 0.28, span: 0.22 },
    { id: "w1", type: "window", wall: "east",  t: 0.30, span: 0.34 },
    { id: "w2", type: "window", wall: "north", t: 0.72, span: 0.30 },
  ],
};
```

Success is judged against exactly this: door on the south wall left-of-centre, one window on the east wall towards its north end, one window on the north wall towards its east end. Nothing centred, nothing symmetric.

## File Structure

**Real, kept beyond the spike:**

| File | Responsibility |
| --- | --- |
| `src/lib/greybox/types.ts` | `GreyboxWall`, `GreyboxOpening`, `GreyboxRoomSpec`. No logic. |
| `src/lib/greybox/build-scene.ts` | Room spec → three.js scene. Wall-panel splitting around openings. Framework-free apart from three. |
| `src/lib/greybox/camera.ts` | Room spec → positioned `PerspectiveCamera`. The automatic camera rule. |
| `src/components/project/greybox-preview.tsx` | Renders a scene to a `<canvas>`, exposes PNG export. |
| `src/lib/render/runware-client.ts` (modify) | `generateImageWithRunwareGemini` gains optional reference images. |
| `src/lib/ai/provider.ts` (modify) | `generateImage` gains optional `referenceImages`. |

**Throwaway, deleted at the end of Phase 0:**

| File | Responsibility |
| --- | --- |
| `src/app/spike/greybox/page.tsx` | Dev-only comparison UI. |
| `src/app/api/spike-greybox/route.ts` | Dev-only route running both generations. |
| `src/proxy.ts` (modify) | Dev-only public prefix for `/spike`. |

---

### Task 1: Greybox scene builder and camera

**Files:**
- Create: `src/lib/greybox/types.ts`
- Create: `src/lib/greybox/build-scene.ts`
- Create: `src/lib/greybox/camera.ts`
- Modify: `package.json` (add `three`, `@types/three`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GreyboxWall = "north" | "south" | "east" | "west"`
  - `interface GreyboxOpening { id: string; type: "door" | "window"; wall: GreyboxWall; t: number; span: number }`
  - `interface GreyboxRoomSpec { width: number; depth: number; openings: GreyboxOpening[] }`
  - `buildGreyboxScene(spec: GreyboxRoomSpec): THREE.Scene`
  - `greyboxCamera(spec: GreyboxRoomSpec, aspect: number): THREE.PerspectiveCamera`
  - `CEILING_H`, `DOOR_HEAD`, `WINDOW_SILL`, `WINDOW_HEAD` exported from `build-scene.ts`

- [ ] **Step 1: Install three**

```bash
npm install three && npm install -D @types/three
```

- [ ] **Step 2: Write `src/lib/greybox/types.ts`**

```ts
/**
 * Greybox room description — the input to the perspective reference render
 * that locks door/window positions in generated room images (see
 * docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md).
 *
 * Deliberately carries no real-world units. `width`/`depth` are a PROPORTION
 * only; the plan editor supplies them from a normalised rectangle drawn on
 * the uploaded plan image. Real dimensions (Room.width/Room.height, in feet)
 * are a separate concern and are not reconciled with these.
 */

export type GreyboxWall = "north" | "south" | "east" | "west";

export interface GreyboxOpening {
  id: string;
  type: "door" | "window";
  wall: GreyboxWall;
  /** 0..1 centre position along the wall, in the plan's left-to-right / top-to-bottom order. */
  t: number;
  /** 0..1 fraction of the wall's length. */
  span: number;
}

export interface GreyboxRoomSpec {
  /** East-west extent. */
  width: number;
  /** North-south extent. */
  depth: number;
  openings: GreyboxOpening[];
}
```

- [ ] **Step 3: Write `src/lib/greybox/build-scene.ts`**

Openings are cut by splitting each wall into sub-panels around the opening rect — no CSG dependency. Each opening gets a filler plane just outside the wall (dark for a door, bright for a window) so it reads unmistakably rather than showing through to the background.

```ts
import * as THREE from "three";
import type { GreyboxOpening, GreyboxRoomSpec, GreyboxWall } from "./types";

export const CEILING_H = 10;
export const DOOR_HEAD = 7;
export const WINDOW_SILL = 3;
export const WINDOW_HEAD = 7;

const WALL_COLOR = 0xb4b4b4;
const FLOOR_COLOR = 0x9a9a9a;
const CEIL_COLOR = 0xc8c8c8;
const DOOR_COLOR = 0x262626;
const WINDOW_COLOR = 0xf2f2f2;

/** Where a wall sits and how its local axis maps into world space. */
interface WallFrame {
  /** wall length */
  len: number;
  /** world position of the wall plane's centre, at y = 0 */
  cx: number;
  cz: number;
  /** rotation about Y so the plane faces into the room */
  rotY: number;
  /** unit vector along the wall's local x axis, in world space */
  ax: number;
  az: number;
  /** inward normal, used to offset opening fillers behind the wall */
  nx: number;
  nz: number;
}

/**
 * `t` is always measured in the PLAN's reading order — west->east on the
 * north/south walls, north->south on the east/west walls — so a door drawn a
 * quarter along a wall in the 2D editor lands a quarter along that same wall
 * here, whichever wall it is. That means `ax`/`az` (the world direction of
 * increasing `t`) is +X for BOTH horizontal walls and +Z for BOTH vertical
 * ones. It does NOT flip with the wall's facing direction — `rotY` alone
 * handles facing, and since every panel is positioned by its centre, the
 * plane's own rotation has no effect on where that centre lands.
 */
function wallFrame(wall: GreyboxWall, w: number, d: number): WallFrame {
  const hw = w / 2;
  const hd = d / 2;
  switch (wall) {
    // North wall: at -Z, faces +Z. `t` runs west -> east.
    case "north":
      return { len: w, cx: 0, cz: -hd, rotY: 0, ax: 1, az: 0, nx: 0, nz: 1 };
    // South wall: at +Z, faces -Z. `t` also runs west -> east.
    case "south":
      return { len: w, cx: 0, cz: hd, rotY: Math.PI, ax: 1, az: 0, nx: 0, nz: -1 };
    // West wall: at -X, faces +X. `t` runs north -> south.
    case "west":
      return { len: d, cx: -hw, cz: 0, rotY: Math.PI / 2, ax: 0, az: 1, nx: 1, nz: 0 };
    // East wall: at +X, faces -X. `t` also runs north -> south.
    case "east":
      return { len: d, cx: hw, cz: 0, rotY: -Math.PI / 2, ax: 0, az: 1, nx: -1, nz: 0 };
  }
}

/** Vertical extent of an opening, in feet from the floor. */
function openingVertical(o: GreyboxOpening): { y0: number; y1: number } {
  return o.type === "door"
    ? { y0: 0, y1: DOOR_HEAD }
    : { y0: WINDOW_SILL, y1: WINDOW_HEAD };
}

/**
 * Adds one rectangular panel lying in a wall's plane. `u` is the panel's
 * centre along the wall's local axis measured from the wall's centre.
 */
function addPanel(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  y: number,
  panelW: number,
  panelH: number,
  material: THREE.Material,
  offset = 0,
) {
  if (panelW <= 1e-6 || panelH <= 1e-6) return;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), material);
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * offset,
    y,
    frame.cz + frame.az * u + frame.nz * offset,
  );
  mesh.rotation.y = frame.rotY;
  group.add(mesh);
}

/**
 * Builds one wall as a set of panels surrounding its openings:
 * full-height panels for the gaps between openings, plus a panel below and
 * above each opening. Openings themselves are left as holes and backed by a
 * contrasting filler plane just outside the wall.
 */
function buildWall(
  group: THREE.Group,
  wall: GreyboxWall,
  spec: GreyboxRoomSpec,
  wallMat: THREE.Material,
  doorMat: THREE.Material,
  windowMat: THREE.Material,
) {
  const frame = wallFrame(wall, spec.width, spec.depth);
  const L = frame.len;
  const half = L / 2;

  const openings = spec.openings
    .filter((o) => o.wall === wall)
    .map((o) => {
      const spanLen = Math.max(0, Math.min(1, o.span)) * L;
      const centre = Math.max(0, Math.min(1, o.t)) * L;
      // Keep the opening fully on the wall rather than letting it hang off an end.
      const x0 = Math.max(0, Math.min(L - spanLen, centre - spanLen / 2));
      return { o, x0, x1: x0 + spanLen, ...openingVertical(o) };
    })
    .sort((a, b) => a.x0 - b.x0);

  let cursor = 0;
  for (const op of openings) {
    // Full-height panel filling the gap before this opening.
    const gapW = op.x0 - cursor;
    addPanel(group, frame, cursor + gapW / 2 - half, CEILING_H / 2, gapW, CEILING_H, wallMat);

    const opW = op.x1 - op.x0;
    const u = op.x0 + opW / 2 - half;
    // Panel below the opening (a door's is zero-height and is skipped by addPanel).
    addPanel(group, frame, u, op.y0 / 2, opW, op.y0, wallMat);
    // Panel above the opening.
    addPanel(group, frame, u, (op.y1 + CEILING_H) / 2, opW, CEILING_H - op.y1, wallMat);
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

    cursor = op.x1;
  }
  // Remaining full-height panel after the last opening.
  const tailW = L - cursor;
  addPanel(group, frame, cursor + tailW / 2 - half, CEILING_H / 2, tailW, CEILING_H, wallMat);
}

/**
 * Room spec -> an untextured grey 3D box, ready to render from
 * `greyboxCamera`. Flat grey materials only: form must read clearly without
 * implying any material or style, which is the prompt's job.
 */
export function buildGreyboxScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  const wallMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const floorMat = new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: CEIL_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const doorMat = new THREE.MeshBasicMaterial({ color: DOOR_COLOR, side: THREE.DoubleSide });
  const windowMat = new THREE.MeshBasicMaterial({ color: WINDOW_COLOR, side: THREE.DoubleSide });

  const group = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.depth), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CEILING_H;
  group.add(ceiling);

  (["north", "south", "east", "west"] as GreyboxWall[]).forEach((wall) =>
    buildWall(group, wall, spec, wallMat, doorMat, windowMat),
  );

  scene.add(group);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x505050, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(spec.width, CEILING_H * 1.6, spec.depth);
  scene.add(key);

  return scene;
}
```

- [ ] **Step 4: Write `src/lib/greybox/camera.ts`**

```ts
import * as THREE from "three";
import { CEILING_H } from "./build-scene";
import type { GreyboxRoomSpec, GreyboxWall } from "./types";

/** Eye height, feet. */
const EYE_H = 5;
/** How far the camera sits from its corner, as a fraction of the room. */
const INSET = 0.12;
const FOV = 65;

/**
 * The automatic camera rule: stand in the corner diagonally opposite the main
 * door and look at the room's centre. That keeps the door itself in frame
 * (so its position is verifiable) while showing two full walls, which is what
 * makes the reference render legible as a room.
 *
 * With no door, falls back to the corner opposite the south wall's midpoint,
 * i.e. the conventional "looking in from the entrance side" view.
 */
export function greyboxCamera(spec: GreyboxRoomSpec, aspect: number): THREE.PerspectiveCamera {
  const door = spec.openings.find((o) => o.type === "door");
  const doorWall: GreyboxWall = door?.wall ?? "south";

  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const insetX = spec.width * INSET;
  const insetZ = spec.depth * INSET;

  // Start at the corner OPPOSITE the door's wall, then bias along that wall
  // to the far side of the door so the door is seen at an angle, not head-on.
  let x = 0;
  let z = 0;
  const t = door?.t ?? 0.5;
  if (doorWall === "north" || doorWall === "south") {
    z = doorWall === "north" ? hd - insetZ : -hd + insetZ;
    x = t < 0.5 ? hw - insetX : -hw + insetX;
  } else {
    x = doorWall === "west" ? hw - insetX : -hw + insetX;
    z = t < 0.5 ? hd - insetZ : -hd + insetZ;
  }

  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 200);
  camera.position.set(x, EYE_H, z);
  camera.lookAt(0, CEILING_H * 0.42, 0);
  return camera;
}
```

- [ ] **Step 5: Verify it compiles and lints**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0, no output from lint.

There is no test runner in this repo (see Global Constraints), so this is a compile-level check only. Task 2 provides the first real visual verification — do not claim the scene is correct until you have looked at it.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/greybox
git commit -m "feat: greybox scene builder and automatic camera"
```

---

### Task 2: Greybox preview component and visual verification

**Files:**
- Create: `src/components/project/greybox-preview.tsx`
- Create: `src/app/spike/greybox/page.tsx` (throwaway)
- Modify: `src/proxy.ts` (throwaway — dev-only public prefix)

**Interfaces:**
- Consumes: `buildGreyboxScene`, `greyboxCamera`, `GreyboxRoomSpec` from Task 1.
- Produces: `<GreyboxPreview spec width height onReady />`, where `onReady: (dataUrl: string) => void` fires once with a `image/png` data URL after the first render.

- [ ] **Step 1: Write `src/components/project/greybox-preview.tsx`**

```tsx
"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { buildGreyboxScene } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";

/**
 * Renders a room's greybox to a canvas at a fixed pixel size and hands back a
 * PNG data URL. Fixed size (not responsive) on purpose: this image is a
 * generation input whose aspect ratio must match the image model's output,
 * so it must not track the element's layout size the way lasso-canvas.tsx or
 * sketch-canvas.tsx do.
 */
export function GreyboxPreview({
  spec,
  width,
  height,
  onReady,
}: {
  spec: GreyboxRoomSpec;
  width: number;
  height: number;
  onReady?: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);

    const scene = buildGreyboxScene(spec);
    const camera = greyboxCamera(spec, width / height);
    renderer.render(scene, camera);

    onReady?.(canvas.toDataURL("image/png"));

    return () => {
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const m = obj.material;
          Array.isArray(m) ? m.forEach((x) => x.dispose()) : m.dispose();
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, width, height]);

  return <canvas ref={canvasRef} className="w-full rounded-xl border border-border" />;
}
```

- [ ] **Step 2: Add the dev-only public prefix to `src/proxy.ts`**

Modify the `PUBLIC_PREFIXES` constant (currently line 20). The spike must never be reachable in production — this is a dev-only allowance, and Task 4's route additionally hard-404s.

```ts
// /spike and /api/spike are the Phase 0 greybox proof spike (throwaway, see
// docs/superpowers/plans/2026-08-01-greybox-opening-placement-phase0-spike.md).
// Dev-only: the route itself also 404s when NODE_ENV === "production", so
// this prefix can never expose an unauthenticated billed endpoint.
const PUBLIC_PREFIXES =
  process.env.NODE_ENV === "production"
    ? ["/login", "/s", "/api/s"]
    : ["/login", "/s", "/api/s", "/spike", "/api/spike"];
```

- [ ] **Step 3: Write the spike page with the greybox only (no generation yet)**

```tsx
"use client";

import { useState } from "react";
import { GreyboxPreview } from "@/components/project/greybox-preview";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";

/**
 * THROWAWAY — Phase 0 proof spike. Delete with the rest of the spike files
 * once the gate decision is recorded. Unlinked from the app on purpose.
 */

const SPIKE_ROOM: GreyboxRoomSpec = {
  width: 13.08,
  depth: 14.75,
  openings: [
    { id: "d1", type: "door", wall: "south", t: 0.28, span: 0.22 },
    { id: "w1", type: "window", wall: "east", t: 0.3, span: 0.34 },
    { id: "w2", type: "window", wall: "north", t: 0.72, span: 0.3 },
  ],
};

export default function GreyboxSpikePage() {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="text-xl font-bold">Greybox spike</h1>
      <p className="mt-1 text-sm text-muted">
        Bedroom 13&apos;1&quot; x 14&apos;9&quot;. Door on the south wall left-of-centre, window on the east
        wall towards its north end, window on the north wall towards its east end.
      </p>
      <div className="mt-6">
        <GreyboxPreview spec={SPIKE_ROOM} width={1376} height={768} onReady={setDataUrl} />
      </div>
      <p className="mt-2 text-xs text-faint">{dataUrl ? `PNG ready (${dataUrl.length} chars)` : "rendering..."}</p>
    </div>
  );
}
```

- [ ] **Step 4: Verify compile and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0.

- [ ] **Step 5: Look at the greybox — the first real verification**

Start the dev server via the preview tooling (never `npm run dev` in a bash tool), open `http://localhost:3000/spike/greybox`, and take a screenshot.

Check every one of these against the render, and fix `build-scene.ts` / `camera.ts` if any fails:
1. The image reads as the inside of a rectangular room — floor, ceiling and two or more walls visible.
2. Exactly three openings are visible: one dark full-height door, two bright windows.
3. The door is on the south wall, left of its centre.
4. One window is on the east wall, nearer its north end.
5. One window is on the north wall, nearer its east end.
6. No gaps, z-fighting stripes, or panels floating away from the walls.
7. `PNG ready (...)` appears under the canvas, confirming `toDataURL` worked.

If openings appear mirrored, the wall-local axis direction in `wallFrame` is wrong for that wall — fix the `ax`/`az` signs, do not compensate elsewhere.

- [ ] **Step 6: Commit**

```bash
git add src/components/project/greybox-preview.tsx src/app/spike src/proxy.ts
git commit -m "feat: greybox preview component + spike page shell"
```

---

### Task 3: Reference-image support in the provider layer

This is real production code, not spike scaffolding — Phase 3 depends on it.

**Files:**
- Modify: `src/lib/render/runware-client.ts` (`generateImageWithRunwareGemini`, currently ~line 371)
- Modify: `src/lib/ai/provider.ts` (`generateImage`, currently ~line 468; `generateImageWithGemini`, ~line 423)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `generateImageWithRunwareGemini(prompt: string, referenceImages?: string[])`
  - `generateImage(prompt: string, ctx?: CallContext, opts?: { referenceImages?: string[] })`
  - Both keep their existing return types unchanged.

- [ ] **Step 1: Add reference images to the Runware Nano Banana generation call**

Replace the body of `generateImageWithRunwareGemini`. Runware requires `resolution` **instead of** `width`/`height` when `referenceImages` is present — the same constraint `editImageWithRunwareGemini` already works around — and the model then matches the reference's aspect ratio.

```ts
export async function generateImageWithRunwareGemini(
  prompt: string,
  referenceImages?: string[],
): Promise<{ bytes: Buffer; contentType: string; costUsd?: number }> {
  const tier = resolutionTier();
  const { width, height } = GEMINI_IMAGE_DIMENSIONS[tier];
  const hasRefs = !!referenceImages?.length;
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: FALLBACK_IMAGE_MODEL,
      positivePrompt: prompt,
      // With referenceImages the docs require `resolution` rather than
      // width/height, and the model then matches the reference's aspect
      // ratio — which is exactly what a greybox reference needs.
      ...(hasRefs
        ? { inputs: { referenceImages }, resolution: tier === "hd" ? "2K" : "1K" }
        : { width, height }),
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware Nano Banana returned no imageURL");
  return finishDownload(result.imageURL, "image/", "image/png", result.cost);
}
```

Also update that function's doc comment — its current text says "No reference image, so plain width/height", which this change makes false.

- [ ] **Step 2: Add reference images to the direct-Google fallback**

Modify `generateImageWithGemini` in `provider.ts`. Reference images become extra `inlineData` parts before the text part, matching how `extractFloorPlan` already orders image-then-text.

```ts
async function generateImageWithGemini(prompt: string, referenceImages?: string[]): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("AiProviderError", "GEMINI_API_KEY is not configured");

  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
  for (const uri of referenceImages ?? []) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(uri);
    if (!m) throw new ProviderError("ValidationError", "reference image must be a base64 data URI");
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  parts.push({ text: prompt });

  const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        // A reference image carries its own aspect ratio; forcing 16:9 on top
        // of it would fight the reference. Only set it for text-only calls.
        generationConfig: referenceImages?.length
          ? { responseModalities: ["IMAGE"] }
          : { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      }),
    });
  } catch (e) {
    throw new ProviderError("AiProviderError", `request failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError("AiProviderError", `${IMAGE_MODEL} ${res.status}: ${body}`);
  }
  const payload = (await res.json().catch(() => null)) as GeminiImageResponse | null;
  const b64 = payload?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new ProviderError("AiProviderError", `${IMAGE_MODEL} returned no image part`);
  return { bytes: Buffer.from(b64, "base64"), contentType: "image/png" };
}
```

- [ ] **Step 3: Thread the option through `generateImage`**

Change only the signature and the three `run:` closures inside `generateImage`. **The chain's structure, ordering and provider-resolution logic must not change.** Note that the FLUX.2 step (`generateImageWithRunware`) does *not* take reference images — FLUX.2's reference-image contract is different and out of scope here; when reference images are supplied, that step is skipped so the chain starts at Nano Banana.

```ts
export async function generateImage(
  prompt: string,
  ctx?: CallContext,
  opts?: { referenceImages?: string[] },
): Promise<GeneratedImage> {
```

Inside, replace the `if (primary === "runware")` branch's first `steps.push` so it is skipped when references are present:

```ts
      const refs = opts?.referenceImages;
      if (primary === "runware" && !refs?.length) {
        steps.push({
          model: slugs.imageGen.runware,
          provider: "runware",
          run: async () => {
            const out = await generateImageWithRunware(prompt);
            setCost(out.costUsd);
            return out;
          },
        });
        steps.push(runwareGeminiStep);
      } else if (runwareAvailable) {
        steps.push(runwareGeminiStep);
      }
```

Update `runwareGeminiStep`'s `run` to pass them:

```ts
          const out = await generateImageWithRunwareGemini(prompt, refs);
```

And the direct-Google last-resort step:

```ts
        run: () => generateImageWithGemini(prompt, refs),
```

- [ ] **Step 4: Verify compile and lint, and confirm no existing caller changed**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0. `generate-room-image/route.ts` calls `generateImage(prompt, {...})` with two arguments and must still typecheck untouched — if it errors, the new parameter was added in the wrong position.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider.ts src/lib/render/runware-client.ts
git commit -m "feat: optional reference images for image generation"
```

---

### Task 4: Spike API route and the live comparison

**Files:**
- Create: `src/app/api/spike-greybox/route.ts` (throwaway)
- Modify: `src/app/spike/greybox/page.tsx` (throwaway)

**Interfaces:**
- Consumes: `generateImage` with `opts.referenceImages` from Task 3; `GreyboxPreview`'s `onReady` data URL from Task 2.
- Produces: `POST /api/spike-greybox { greyboxDataUri: string } -> { conditioned: string; textOnly: string }` (both `data:image/png;base64,...`).

- [ ] **Step 1: Write the spike route**

```ts
/**
 * THROWAWAY — Phase 0 proof spike. Delete with the rest of the spike files
 * once the gate decision is recorded.
 *
 * Runs the SAME room two ways and returns both images: greybox-conditioned,
 * and today's text-only path. Deliberately bypasses assertAllowed (no auth,
 * no rate limit, no usage metering) — which is exactly why it hard-404s
 * outside development.
 */

import { generateImage } from "@/lib/ai/provider";
import { toErrorResponse } from "@/lib/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROOM_DESCRIPTION =
  "A 13 ft by 15 ft bedroom in a premium contemporary Indian home. Warm neutral palette, " +
  "oak veneer, soft diffused daylight. Photorealistic interior photograph, wide angle, eye level.";

/** Today's path: openings described only in words — the current best we can do. */
const TEXT_ONLY_PROMPT =
  `${ROOM_DESCRIPTION}\n\n` +
  "Real openings, respect them exactly: a door on the south wall (connecting to the drawing room); " +
  "a window on the east wall (exterior); a window on the north wall (exterior).";

/** The proposed path: the reference image IS the geometry. */
const CONDITIONED_PROMPT =
  "The attached image is an untextured grey 3D massing render of this exact room, from the exact " +
  "camera position the output must use.\n\n" +
  "Reproduce it as a photorealistic interior photograph. You MUST preserve, without any deviation:\n" +
  "- the camera position, angle and field of view;\n" +
  "- the room's proportions and every wall position;\n" +
  "- the position, width and height of every door and window opening. A dark full-height panel is a " +
  "doorway; a bright panel is a window. Do not move, resize, add or remove a single opening.\n\n" +
  "Change ONLY surfaces, materials, lighting and furnishing.\n\n" +
  ROOM_DESCRIPTION;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  let body: { greyboxDataUri?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.greyboxDataUri?.startsWith("data:image/")) {
    return Response.json({ error: "greyboxDataUri (a data:image/... URI) is required" }, { status: 400 });
  }

  try {
    // Sequential, not Promise.all — a shared 429 from running both at once
    // would be indistinguishable from the approach failing.
    const conditioned = await generateImage(CONDITIONED_PROMPT, undefined, {
      referenceImages: [body.greyboxDataUri],
    });
    const textOnly = await generateImage(TEXT_ONLY_PROMPT);

    const toUri = (i: { bytes: Buffer; contentType: string }) =>
      `data:${i.contentType};base64,${i.bytes.toString("base64")}`;
    return Response.json({ conditioned: toUri(conditioned), textOnly: toUri(textOnly) });
  } catch (e) {
    const { status, body: errBody } = toErrorResponse(e, "Greybox spike");
    return Response.json(errBody, { status });
  }
}
```

- [ ] **Step 2: Add the comparison UI to the spike page**

Add to `src/app/spike/greybox/page.tsx`, keeping `SPIKE_ROOM` and the `GreyboxPreview` exactly as they are:

```tsx
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<{ conditioned: string; textOnly: string } | null>(null);

  const run = async () => {
    if (!dataUrl) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/spike-greybox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ greyboxDataUri: dataUrl }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setOut(json);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
```

And below the preview:

```tsx
      <button
        type="button"
        onClick={run}
        disabled={!dataUrl || busy}
        className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50"
      >
        {busy ? "Generating both..." : "Run comparison"}
      </button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {out && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <figure>
            <figcaption className="mb-1 text-sm font-medium">Greybox-conditioned</figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={out.conditioned} alt="Greybox-conditioned" className="w-full rounded-xl" />
          </figure>
          <figure>
            <figcaption className="mb-1 text-sm font-medium">Text-only (current path)</figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={out.textOnly} alt="Text only" className="w-full rounded-xl" />
          </figure>
        </div>
      )}
```

- [ ] **Step 3: Verify compile and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: both exit 0.

- [ ] **Step 4: Run the live comparison**

With the dev server running, open `/spike/greybox`, click **Run comparison**, and wait for both images.

This makes **two real billed generations**. If it errors, read the server output via the preview log tooling before retrying — a `ValidationError` mentioning `resolution` or `referenceImages` means the Task 3 Runware parameter shape is wrong and must be fixed, not retried.

Take a screenshot of the whole page (greybox + both outputs).

- [ ] **Step 5: Save the three images to the scratchpad**

The two outputs only exist as data URIs in the page's React state, so they die with the tab. Read them back out of the page and write them to disk.

Extract each data URI with the browser JS tool — `document.querySelectorAll("img")` for the two outputs, `document.querySelector("canvas").toDataURL("image/png")` for the greybox — then write each to the scratchpad:

```
C:\Users\varoo\AppData\Local\Temp\claude\P--vastos-interior-main\a71f1220-0822-4253-bbaf-3f42d8281d69\scratchpad\spike-greybox.png
C:\Users\varoo\AppData\Local\Temp\claude\P--vastos-interior-main\a71f1220-0822-4253-bbaf-3f42d8281d69\scratchpad\spike-conditioned.png
C:\Users\varoo\AppData\Local\Temp\claude\P--vastos-interior-main\a71f1220-0822-4253-bbaf-3f42d8281d69\scratchpad\spike-text-only.png
```

Write them with `Buffer.from(<base64 payload>, "base64")` — strip the `data:image/png;base64,` prefix first.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/spike-greybox src/app/spike
git commit -m "feat: greybox spike comparison route and UI"
```

---

### Task 5: Judge the gate and report

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md` (append a "Phase 0 result" section)

**Interfaces:**
- Consumes: the three saved images from Task 4.
- Produces: a recorded gate decision — proceed to Phase 1, or change approach.

- [ ] **Step 1: Score both outputs against the spec**

For each of the two generated images, answer these five questions with yes/no, judging **only** opening placement — not beauty, not style:

1. Is there a door on the south wall (the wall the camera faces across the room), left of its centre?
2. Is there a window on the east wall?
3. Is that east window nearer the north end than the south end?
4. Is there a window on the north wall, nearer its east end?
5. Is the count exactly one door and two windows — no invented extras, none missing?

The greybox render itself is the ground truth for what "correct" looks like; compare each output against it directly.

- [ ] **Step 2: Write the result into the spec**

Append a `## Phase 0 result` section recording: the date, both scores out of 5, the observed failure modes, and the decision. Be specific about what went wrong rather than writing "worked well" — Phases 1–3 are planned off this.

- [ ] **Step 3: Report to the user with the images**

Send the three images (greybox, conditioned, text-only) with the scores and a plain recommendation: proceed to Phase 1, or change approach and how.

**Do not start Phase 1.** The user decides at this gate.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md
git commit -m "docs: record Phase 0 spike result"
```

---

## After the gate

If the spike passes, Phase 1–3 get their own plan, written against this spec:

- **Phase 1** — `Room.shape` / `Room.placedOpenings` / `Room.greyboxKey`, derivation of the existing `openings` field from `placedOpenings`, store actions, and the `/projects/[id]/plan` editor page.
- **Phase 2** — greybox render upload + storage key on the room; camera rules per room type.
- **Phase 3** — `/api/generate-room-image` accepting `greyboxKey`; the strict prompt moved into `prompt_templates`; `cameraGuidelines` demoted to lighting/mood for greybox rooms.

The spike files (`src/app/spike/`, `src/app/api/spike-greybox/`, the `proxy.ts` dev prefix) are deleted at the start of Phase 1 — `src/lib/greybox/`, `greybox-preview.tsx` and the provider's `referenceImages` support are kept.
