# Greybox opening placement — design

**Date:** 2026-08-01
**Branch:** `worktree-greybox-opening-placement`
**Status:** Approved, ready for planning

## Problem

Room Confirmation shows a door/window **count** per room. The generated image puts doors and
windows wherever the model feels like. The user wants openings to land where they actually are
on the floor plan.

Today's pipeline throws the spatial information away before it ever reaches the model:

- `extract-plan.ts`'s `packRoomsGrid` assigns every room a **cosmetic** grid position. Nothing
  downstream reads it spatially.
- An opening is only `{ type, side: north|south|east|west, connectsTo }`
  (`pipeline/assign-openings.ts`). No position along the wall, no size.
- `prompt-builder.ts`'s `describeOpenings` turns that into `"a window on the north wall"` — the
  most precise statement the current data model can make.
- `provider.ts`'s `generateImage` is **text-only**. There is no code path that sends a reference
  image alongside a generation prompt, so no amount of prompt work can fix this.

## Rejected approach, and why

The originally proposed plan was: draw a **top-down** grey floor plan, send it to the image model
(or a ControlNet), and prompt it to place openings accordingly.

Two findings killed it:

1. **ControlNet is available, contrary to the original assumption.** It was assumed Vercel can't
   support ControlNet. ControlNet would never run on Vercel — Runware (already wired into this
   app) exposes it as a hosted API field (`controlNet[].guideImage`). Availability was not the
   blocker.
2. **A top-down control image cannot condition a perspective output.** ControlNet requires the
   control image to be in the *same projection* as the output — it conditions per-pixel, and
   there is no pixel correspondence between a plan view and an eye-level photo. This is geometry,
   not a model limitation, so it applies equally to Nano Banana's reference-image path: handed a
   top-down rectangle with a notch on one edge, the model still has to *mentally project* that
   notch onto a perspective wall. That projection step is exactly what fails today.

## Approach

**Make the reference image a perspective render, not a plan.**

Each room is built as a crude untextured 3D box — floor, ceiling, four walls, with door and window
rectangles cut into the walls — and rendered from the camera the final image should use. That
render is **already in output space**, so handing it to Nano Banana with a strict
geometry-preservation instruction locks opening positions: the window is in the right place
because it was already in the right place in the pixels. This mirrors the established
untextured-3D → photoreal workflow architects already use with this model class.

The 2D plan editor remains the source of truth and is built as originally described (draggable,
resizable, deletable, addable rooms; openings placed on walls). It simply is not what gets sent
to the model — the perspective projection sits between them.

### Decisions locked

| Decision | Choice |
| --- | --- |
| Reference image form | Perspective 3D greybox |
| Room geometry source | Manual rectangle draw over the uploaded plan |
| Camera selection | Automatic per room type, no UI |
| Furniture | Follow-up, not this build |
| Flow position | New step between `upload` and `review` |
| Room shapes | Rectangles only (polygon-shaped data model) |
| Build order | Proof spike gates the rest |

### Explicitly out of scope

- **Real-world dimensions.** The canvas is normalised to the uploaded plan image and carries no
  units. `Room.width` / `Room.height` (real feet, from printed plan dimensions or hand entry on
  Room Confirmation) are **untouched** and keep feeding the prompt's text as they do today. The
  drawn rectangle contributes *proportion only*. Reconciling drawn geometry with real dimensions
  is deliberately deferred.
- Furniture placement.
- L-shaped / non-rectangular rooms.
- Reviving the Python/OpenCV detector (`pipeline/opencv.ts`) — it cannot run on Vercel, and its
  output would need hand-correction anyway.

## Architecture

### 1. Data model

Three new **optional** fields on `Room` (`src/lib/types.ts`):

```ts
/** Normalised [0,1] rect on the uploaded plan image. */
shape?: { x: number; y: number; w: number; h: number };

placedOpenings?: {
  id: string;
  type: "door" | "window";
  wall: "north" | "south" | "east" | "west";  // room-local
  t: number;                                   // 0..1 centre position along that wall
  span: number;                                // 0..1 fraction of wall length
}[];

/** Storage key of this room's rendered perspective greybox. */
greyboxKey?: string;
```

`shape` is stored as a rect but the editor and geometry helpers treat it through a
polygon-shaped accessor, so adding L-shapes later is an editor change rather than a data
migration.

**Compatibility bridge:** the existing `openings?: RoomOpening[]` field stays, and is *derived*
from `placedOpenings` — `side` from `wall`, `connectsTo` resolved by rectangle adjacency. This
is the same derivation `sketch/page.tsx`'s `finish()` already performs. Every current consumer
(Room Confirmation's counts, `build-universal-input.ts`, `prompt-builder.ts`'s
`describeOpenings`) keeps working with no change.

**Backwards compatibility:** a room with no `shape` follows today's text-only path exactly. No
existing project breaks, and the new step is skippable without error.

### 2. Plan editor — `/projects/[id]/plan`

New step between Upload and Room Confirmation. The uploaded plan image is the canvas background;
room rectangles are drawn on top.

- Drag on empty space to create a rectangle; click to select; eight handles to resize; drag body
  to move; Delete/Backspace to remove.
- Click a wall edge to place a door or window; drag it along its wall; drag its ends to set span.
- Openings clamp to their wall and cannot overflow its ends.

Follows the established `sketch-canvas.tsx` pattern — wrapping div + `<canvas>` + `ResizeObserver`
+ normalised [0,1] coordinates + render-on-state-change (not a self-rescheduling rAF loop; nothing
here animates).

All geometry lives in a pure, framework-free `src/lib/plan-editor/geometry.ts`: rect and handle
hit-testing, wall-edge hit-testing, opening clamping, rectangle adjacency → `connectsTo`
resolution, and `PlacedOpening[]` → `RoomOpening[]` conversion. Same split as
`src/lib/sketch/geometry.ts`.

### 3. Greybox renderer

`src/lib/greybox/build-scene.ts` — room spec → three.js scene:

- Floor, ceiling and four walls sized from the rectangle's proportions. Ceiling height is a fixed
  internal constant, never surfaced in the UI.
- Openings are cut by **splitting each wall into sub-panels around the opening rect** — no CSG
  dependency. Doors render as a dark recess, windows as a bright emissive panel, so both are
  unambiguous to the image model.
- Flat grey materials, one key light, so form reads clearly without implying any material or
  style (that is the prompt's job).

`src/lib/greybox/camera.ts` — the automatic camera rule: positioned in the corner diagonal from
the room's main door, eye height ~5 ft, wide FOV, framed so the room fills a 16:9 frame.

`src/components/project/greybox-preview.tsx` — renders the scene to a canvas and exports a PNG
via `toBlob`.

**Rendering happens client-side**, in the browser, at 16:9. The PNG is uploaded once and its
storage key stored on the room, so the server reuses it for "Generate More" without needing a
browser.

**New dependency: `three`** (~150 kb gzipped). Hand-rolled projection was considered and
rejected: it produces flat, ambiguous shapes, whereas the shaded 3D read is precisely what makes
the model interpret the reference as a room. The same scene also yields a depth map for free if
ControlNet-depth is ever needed as an escalation.

### 4. Conditioned generation

- `provider.ts`: `generateImage(prompt, ctx, opts?: { referenceImages?: string[] })`. The Runware
  path adds `inputs.referenceImages` (the same field `editImageWithRunwareGemini` already uses
  successfully); the direct-Google path adds an `inlineData` part. **The existing fallback chain
  is untouched.**
- When reference images are present the Runware call passes `resolution` rather than
  `width`/`height`, per Runware's documented requirement for `referenceImages`; the model then
  auto-matches the reference's aspect ratio.
- `/api/generate-room-image` accepts `greyboxKey`, loads the bytes from storage, and passes them
  through.
- `prompt-builder.ts`: when a greybox is present, `describeOpenings`' vague clause is replaced by
  a strict block — treat the reference as exact geometry, preserve every opening's position and
  size, match the camera, apply materials and lighting only. Wording lives in the
  `prompt_templates` table per this repo's existing convention, with a hardcoded default.

**Known conflict:** `DesignSpecification.cameraGuidelines` currently describes the camera in
words. With a greybox the camera is baked into the pixels, and the two instructions will fight.
For greybox rooms `cameraGuidelines` is demoted to lighting/mood only; the strict block owns
camera and geometry.

## Build order

**Phase 0 — proof spike (gate).** A dev-only, unlinked page. One room from
`3BHK-house-plan-ground-floor.jpg` is hardcoded, its greybox rendered, and the room generated two
ways: greybox-conditioned versus the current text-only path. Both images shown side by side.

Spike also verifies, against the live API: that `inputs.referenceImages` works on the generation
task type (not just editing), and which `resolution` value is valid for the hd tier.

**If the accuracy gain is not obvious, stop and rethink before building any editor.**

Then, only if the spike lands:

- **Phase 1** — data model + plan editor page
- **Phase 2** — greybox renderer + automatic camera
- **Phase 3** — generation wiring + strict prompt

Fast-follow, deliberately deferred: furniture placement, L-shaped rooms.

## Phase 0 result — 2026-08-01: PASSED

Both images generated from the same room description; the only variable was the
geometry channel. Model: Runware Nano Banana 2 (`google:4@3`), 2752x1536.

Greybox target positions, as NDC x across the frame (-1 = left edge, +1 = right):
door on south t=0.28 → **+0.34**; window on east t=0.30 → **-0.37**; window on
north t=0.72 → **-0.79**. These were read out of the projection directly, and
independently confirmed by a column-brightness scan of the greybox PNG, which
found its two bright panels at -0.81 and -0.40.

| Check (judged against the greybox, which is ground truth) | Conditioned | Text-only |
| --- | --- | --- |
| Door on the correct wall, at its position | yes | no — landed on the opposite wall, inside a wardrobe run |
| East window present | yes | no correspondence |
| East window at its position | yes | no |
| North window present at its position | yes | no |
| Exactly one door and two windows, nothing invented | **no** | no — three windows |
| **Score** | **4 / 5** | **0 / 5** |

All three openings in the conditioned output land on the correct wall, in the
correct left-to-right order, at visually matching positions. The camera, room
proportions and wall junctions also carry over from the reference.

**The one real failure: the model invented a full-height glazed slot at the far
wall junction** (around NDC -0.18 to -0.02), where the greybox has a plain
corner. So the strict prompt successfully holds openings that EXIST in place,
but does not yet stop the model adding new ones. Phase 3's prompt work must
target that specifically — an explicit "every wall not shown as an opening is
solid; add no glazing at corners or wall junctions" clause is the obvious first
attempt.

Two smaller notes, neither blocking:

- The conditioned room furnished as a lounge (daybed, media console) rather than
  a bedroom. That is prompt/design-spec territory, not geometry — the spike's
  prompt carried only a one-line room description, where the real pipeline
  supplies a full `DesignSpecification`.
- Automated brightness measurement works on the greybox but NOT on photoreal
  output, because real windows show dark foliage rather than uniform brightness.
  Output scoring is therefore visual; don't build a regression check on that
  measurement without solving it properly first.

**Decision: proceed to Phase 1.** The accuracy gain is not marginal — it is the
difference between openings landing where specified and landing arbitrarily.
