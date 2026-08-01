# Greybox pipeline — full build plan

**Date:** 2026-08-01
**Branch:** `worktree-greybox-opening-placement`
**Background:** `2026-08-01-greybox-opening-placement-design.md` (design + Phase 0 result)

This document is the agreed scope for everything from here. It supersedes the
"Build order" section of the background spec.

---

## 1. Where we are

Phase 0 proved the core idea. Conditioning Nano Banana on a perspective greybox
render scored **4/5** on opening placement against **0/5** for the current
text-only path — all three openings landed on the correct wall, in the correct
order, at their specified positions.

**Already built and kept** (real code, not spike scaffolding):

| File | What it does |
| --- | --- |
| `src/lib/greybox/types.ts` | `GreyboxRoomSpec`, `GreyboxOpening`, `GreyboxWall` |
| `src/lib/greybox/build-scene.ts` | Room spec → three.js scene; wall-panel splitting around openings |
| `src/lib/greybox/camera.ts` | Scores 8 candidate viewpoints, picks the one framing the most openings |
| `src/components/project/greybox-preview.tsx` | Renders a scene to canvas, exports PNG |
| `src/lib/ai/provider.ts`, `render/runware-client.ts` | Optional `referenceImages` on `generateImage` |

**Throwaway, deleted at the start of Phase A:** `src/app/spike/`,
`src/app/api/spike-greybox/`, the `SPIKE_ENABLED` branch in `src/proxy.ts`.

---

## 2. What the spike told us to fix

Two defects were found. Neither is purely a prompt problem — both have a
structural cause in the greybox geometry, and fixing the geometry is the
stronger lever. The spike is direct evidence that prompt wording alone does not
hold.

### 2.1 The door came back open

A door is currently rendered as a **black void**. To an image model that reads
as "an opening through to somewhere else", so it correctly produced an open
door with a room visible beyond.

**Fix — geometry:** render a door as a *closed leaf* — a mid-tone panel set
slightly back inside a visible frame reveal. The reference then already shows
the thing we want.
**Fix — prompt:** "every door is closed."

### 2.2 It invented a full-height glazed slot at a wall corner

Walls are flat untextured planes, so a wall junction produces a hard value
change that looks much like the scene's only other bright shapes — the windows.

**Fix — geometry:** give every opening a **reveal** (a short returned face at
wall thickness) so a hole reads as a hole with depth, and an unbroken corner
reads as a corner.
**Fix — prompt:** "every surface not shown as an opening is solid. Add no
glazing, no windows and no doors at corners or wall junctions."

### 2.3 The prompt carried almost no design intent

The spike passed a single line of room description. The real pipeline has a
full `DesignSpecification` from the Design page (`designLanguage`,
`materialPalette`, `lightingStrategy`, `colourStrategy`, `furnitureLanguage`,
`cameraGuidelines`, plus per-room `roomGuidelines`). Phase A must merge the
strict geometry block with all of it — that is what `prompt-builder.ts` is for.

**Known conflict:** `cameraGuidelines` describes the camera in words, but with a
greybox the camera is baked into the pixels. For greybox rooms
`cameraGuidelines` is demoted to lighting/mood only; the strict block owns
camera and geometry.

---

## 3. Confirmed decisions

| Decision | Choice |
| --- | --- |
| Reference image | Perspective 3D greybox render |
| Room geometry | Drawn manually as rectangles over the uploaded plan |
| Room shapes v1 | Rectangles only (polygon-shaped data model) |
| Camera | Same rule everywhere; each room gets whichever of 8 viewpoints frames the most openings |
| Images per room | **Exactly one.** Never multiple views stitched together |
| Missing an opening | Acceptable when no single view can contain them all |
| Furniture form | Procedural proxy shapes built from primitives — no asset library |
| Furniture placement | **3D greybox only** (orbit + drag), not on the 2D plan |
| Build order | **Openings end-to-end first, furniture second** |
| Real dimensions | Out of scope, deferred |

### Why one image per room

Each generation is an independent sample. Two views of the same room come back
with different materials, different light and different furniture, and there is
no reliable way to reconcile them into one design. A single view that omits one
opening is a smaller error than two views that disagree with each other.

### Why no 3D asset library

Proxy shapes are built from primitives in code: a sofa is a seat slab, a back
and two arms; a bed is a mattress box and a headboard. No asset files, no
bundle weight, no licensing. The shape itself identifies the item, which means
**no text is ever rendered into the reference image** — important, because Nano
Banana Pro renders text well, so a box labelled "SOFA" risks returning a photo
with SOFA printed on the cushion.

---

## 4. Data model

Additive and optional on `Room` (`src/lib/types.ts`). Nothing existing breaks;
a room without `shape` follows today's text-only path unchanged.

```ts
/** Normalised [0,1] rect on the uploaded plan image. */
shape?: { x: number; y: number; w: number; h: number };

placedOpenings?: {
  id: string;
  type: "door" | "window";
  wall: "north" | "south" | "east" | "west";
  t: number;      // 0..1 centre along that wall, in the plan's reading order
  span: number;   // 0..1 fraction of wall length
}[];

/** Storage key of this room's rendered greybox. */
greyboxKey?: string;

/** Phase B. */
furniture?: {
  id: string;
  kind: string;   // catalogue key, e.g. "bed-double"
  x: number;      // room-local, 0..1 across width
  z: number;      // room-local, 0..1 across depth
  rotation: number;
}[];
```

The existing `openings?: RoomOpening[]` stays and is **derived** from
`placedOpenings`, so Room Confirmation's counts, `build-universal-input.ts` and
`prompt-builder.ts` keep working untouched.

`t` is always measured in the plan's reading order — west→east on north/south
walls, north→south on east/west walls. This is already implemented and
verified: door t=0.28 → screen x +0.34, window t=0.30 → −0.37, window t=0.72 →
−0.79, all matching the render.

---

## 5. Phase A — openings, end to end

Ships the proven win into the real product.

**A1 — Data model + store.** The fields above, store actions, and the derivation
of `openings` from `placedOpenings` via rectangle adjacency.

**A2 — Plan editor page** at `/projects/[id]/plan`, between Upload and Room
Confirmation. Uploaded plan as canvas background. Drag to create a room
rectangle, select, resize from 8 handles, move, delete. Click a wall edge to
place a door or window; drag along the wall; drag its ends to set width. Pure
geometry in `src/lib/plan-editor/geometry.ts`, following the existing
`sketch-canvas.tsx` pattern.

**A3 — Greybox geometry hardening.** The 2.1 and 2.2 fixes: closed door leaves
with frame reveals, opening reveals at wall thickness, and a re-verified render.

**A4 — Render + storage.** Render client-side at 16:9, upload once, store
`greyboxKey` on the room. Server reuses the key for "Generate More" so
regeneration needs no browser.

**A5 — Generation wiring.** `prompt-builder.ts` gains the strict geometry block
(wording in the `prompt_templates` table per existing convention, with a
hardcoded default), merged with the full `DesignSpecification`;
`cameraGuidelines` demoted for greybox rooms; `/api/generate-room-image`
accepts `greyboxKey` and passes the bytes as a reference image.

**A6 — Verification.** Run a real project end to end and check openings against
the greybox, including that the two spike defects are actually gone.

---

## 6. Phase B — furniture

**B1 — Proxy catalogue.** Procedural shapes keyed by room type. Starting set,
to be confirmed when Phase B is planned: bed, wardrobe, nightstand, dresser,
sofa, armchair, coffee table, dining table, chair, TV unit, rug, plant.

**B2 — 3D room editor**, one page per room. Free orbit for editing; drag
furniture on the floor plane by raycast; rotate and delete. **The exported
reference still renders from the locked auto camera**, not from wherever the
user happened to orbit to — so editing freely can never change the generated
viewpoint.

**B3 — Furniture into the greybox** plus a prompt clause describing the placed
items, so the model knows a proxy is a sofa rather than guessing from shape
alone. Shape and text reinforce each other; text stays in the prompt, never in
the image.

**B4 — Verification**, same shape as A6.

---

## 7. Risks

**Control versus beauty.** The more we bake into the reference, the more the
model is constrained — and crude proxies can produce staged-looking output
rather than photographic. This is the main thing Phase B has to prove, and it
is why furniture is a separate phase with its own verification rather than
folded into A.

**Proxies may be mangled.** The model might read a proxy as an odd object
instead of furniture. Mitigation: B1 and B3 land together and get tested on
3-4 proxies before the catalogue is completed.

**The model still invents.** The spike showed it adding an opening even under a
strict prompt. 2.1 and 2.2 should reduce this; A6 must confirm it, and if
invention persists it is a prompt-and-geometry iteration, not a reason to
abandon the approach.

**Orbit versus export camera.** Users who orbit to place furniture will
reasonably expect the render to come from where they are looking. It will not.
This needs to be visible in the UI — a framing indicator showing the locked
camera — or it will read as a bug.

---

## 8. Assumptions I am making

Flag any of these that are wrong:

1. **Rooms and openings stay on the 2D plan editor.** Only *furniture* is
   placed in 3D. Drawing rooms in perspective would be much worse.
2. **The camera stays fully automatic**, with no manual override, per the
   earlier decision — even though Phase B introduces an orbitable 3D view.
3. **Doors are always closed** in the reference, including the main entry door.
4. **One greybox per room**, re-rendered and re-uploaded whenever its geometry
   or furniture changes.
5. **Phase A ships and is verified before Phase B starts** — furniture is not
   built speculatively alongside it.
6. **Existing projects keep working.** A room with no `shape` uses today's
   text-only path; the new step is skippable without error.

---

## 9. Not in scope

Real-world dimensions and their reconciliation with drawn geometry; L-shaped
and non-rectangular rooms; multi-floor plans; reviving the Python/OpenCV
detector; manual camera override; multiple views per room.
