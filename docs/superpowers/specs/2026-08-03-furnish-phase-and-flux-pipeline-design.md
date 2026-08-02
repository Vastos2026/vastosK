# Furnish Phase + FLUX Pipeline Rework — Design

**Date:** 2026-08-03
**Branch:** `worktree-greybox-opening-placement` (build directly on it)
**Supersedes for the prompt/render layer:** `docs/flux-prompting-techniques.md` §1–§7.1, reconciled here against the actual codebase.

---

## 0. Why this document exists

`docs/flux-prompting-techniques.md` was written against this exact branch — its `prompt-builder.ts:196`,
`:86-88`, `:167-173` line references match the file byte-for-byte. But it was written without
visibility into two things:

1. The furniture editor it assumes (`/furnish/[roomId]`) already exists **with orbit controls**, which
   its own §0 forbids.
2. The flow it assumes (openings → furniture → generate) does not match the product flow the user
   wants.

This document reconciles both, and records four decisions the user made on 2026-08-03:

| Decision | Value |
|---|---|
| Furniture editor viewport | **Fixed locked export camera only.** No orbit, no user camera control |
| Where the work happens | **Directly on `worktree-greybox-opening-placement`** |
| FLUX spec scope | **§1–§6 in full, plus §7.1 (Pass B mask).** Defer §7.2 CV/VLM gate, §7.3 retry, §9 calibration |
| Furnish page gating | **Skippable. Rooms start empty** (openings-only greybox = the spec's Phase 1 baseline) |

Not re-litigated: the `worktree-controlnet` spike already scored geometry-only ControlNet
conditioning at **0/5** openings vs the reference-image path's **4/5**. Reference-image greybox
conditioning is the spine. Do not revisit.

---

## 1. The flow change

### Before

```
upload → plan → review → design → generate → approve → walkthrough
                                                │
                                                └─ /furnish/[roomId]  (sub-route, orbit editor)
```

The greybox is rendered lazily inside `design/page.tsx`'s auto-fire generation loop, so the first
time a user ever sees a 3D view of their room is *after* they have already paid for a generation.

### After

```
upload → plan → review → FURNISH → design → generate → approve → walkthrough
                            │                    │
                            │                    └─ /furnish/[roomId]?from=generate
                            └─ /furnish  (gallery)  →  /furnish/[roomId]  (fixed-camera editor)
```

**`/furnish`** is a new first-class phase between Room Confirmation and Design. It is a gallery of
room cards, each showing that room's live greybox render. Clicking a card expands into the
fixed-camera furniture editor. Save writes back and returns to the gallery.

**`/furnish/[roomId]`** stays reachable from the Generate page, so furniture can be adjusted after
seeing a generated result. Saving from there returns to `/generate`, not the gallery.

The greybox is now rendered **before** Design, so the reference image exists by the time any paid
call is made, and the design page's lazy `ensureGreyboxKey` becomes a fallback for rooms the user
skipped rather than the primary path.

---

## 2. The furnish gallery — `/projects/[id]/furnish`

One card per room in the confirmed room list.

```
┌────────────────────────────────────────────────────────────┐
│  Furnish your rooms                        3 of 7 furnished│
│  Place furniture where you want it. Skip any room to        │
│  generate it empty.                                         │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐  │
│ │ greybox  │ │ │ greybox  │ │ │ greybox  │ │ │ ▁▁▁▁▁▁▁▁ │  │
│ │ ▓▓  ░░   │ │ │  ░░  ▓▓  │ │ │ ░░       │ │ │ rendering│  │
│ └──────────┘ │ └──────────┘ │ └──────────┘ │ └──────────┘  │
│ Master Bed   │ Living       │ Kitchen      │ Bath 1        │
│ 12'×14'      │ 16'×18'      │ 10'×12'      │ 6'×8'         │
│ 3 pieces  ●  │ 2 pieces  ●  │ Empty        │ Empty         │
└──────────────┴──────────────┴──────────────┴───────────────┘
                                              [ Continue → ]
```

- Card image is the room's actual greybox PNG served from storage (`/api/render?key=…`), not a
  separate preview path — what you see is literally the reference image FLUX receives.
- `Continue` is **always enabled**. Unfurnished rooms are valid.
- A room that cannot produce a greybox (no dimensions *and* no `shape`) shows a muted card with
  "Add dimensions in Room Confirmation" and links back to `/review`. It still generates, via the
  text-only prompt path.

### Rendering the previews

Greybox rendering is client-side WebGL. Rendering seven rooms in parallel would open seven WebGL
contexts and hit the browser cap (~16, with unpredictable eviction).

**A single module-level serial queue** in `src/lib/greybox/render-queue.ts` processes one room at a
time, reusing the existing create-render-dispose cycle in `render-to-data-uri.ts`. Cards show a
skeleton until their turn. On completion each room's `{greyboxKey, greyboxMaskKey, greyboxHash,
greyboxLedger}` is written to the store and the card swaps to the image.

### Cache invalidation — fixes a live bug

`ensureGreyboxKey` currently short-circuits on `if (room.greyboxKey) return room.greyboxKey`, and
**nothing in `src/` ever clears `greyboxKey`**. Editing a door in the Plan editor after generating
silently reuses the stale greybox.

Fix: `Room.greyboxHash`, a deterministic hash over exactly the inputs the render depends on:

```ts
greyboxHash = sha1(JSON.stringify({
  w: round(widthFt, 3), d: round(depthFt, 3),
  o: [...placedOpenings].sort(byId).map(o => [o.type, o.wall, round(o.t,4), round(o.span,4)]),
  f: [...furniture].sort(byId).map(f => [f.kind, round(f.x,4), round(f.z,4), round(f.rotation,4)]),
  v: GREYBOX_RENDER_VERSION,          // bump to invalidate every cached render at once
}))
```

`ensureGreyboxKey` re-renders when the stored hash differs from the computed one. `GREYBOX_RENDER_VERSION`
is bumped by this change, so every pre-existing greybox is regenerated against the new §3 value ladder.

---

## 3. The fixed-camera furniture editor — `/projects/[id]/furnish/[roomId]`

Rewrite of the existing page. **`OrbitControls` is removed entirely**, along with the
`THREE.CameraHelper` frustum wireframe (which existed only to show the user where the locked camera
was — now the viewport *is* the locked camera).

```
┌───────────────────────────────────────────┬─────────────────┐
│                                           │ Master Bedroom  │
│      ╱                             ╲      │ 12' × 14'       │
│     │   ▓▓▓▓▓          ░░░░░        │     │                 │
│     │   ▓ bed ▓        ░ win ░      │     │ ADD (3/5)       │
│     │   ▓▓▓▓▓          ░░░░░        │     │  + Bed          │
│     │  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   │     │  + Nightstand   │
│      ╲                             ╱      │  + Wardrobe     │
│                                           │  + Plant        │
│  drag on floor · ←↑↓→ nudge · [ ] rotate  │                 │
│                                           │ PLACED          │
│  ⚠ Wardrobe blocks the north window       │  Bed      ↺ ↻ 🗑 │
│                                           │  Nightstand…    │
│                                           │  Wardrobe  ⚠    │
│                                           │                 │
│                                           │ [Save] [Generate]│
└───────────────────────────────────────────┴─────────────────┘
```

### Interaction

| Action | Input |
|---|---|
| Select | Click an item (raycast against `roomGroup`, walk up to `userData.furnitureId`) |
| Move | Drag the selected item — raycast onto the `y=0` plane, same as today |
| Fine move | Arrow keys, 0.25 ft per press (reaches items that drag can't, e.g. near frame edge) |
| Rotate | `[` / `]` keys and sidebar buttons, ±15° (`Math.PI/12`) |
| Delete | `Delete` / `Backspace` and sidebar trash |
| Add | Sidebar buttons from `furnitureForRoomType(room.type)`, disabled at 5 items |

The click-to-select-then-drag two-step from the current editor is dropped — it only existed to stop
drag fighting orbit, and orbit is gone. Drag now selects and moves in one gesture.

### Placement constraints — hard, enforced during drag

Drag proposes a position; the constraint solver returns the nearest legal one. Because it clamps
rather than rejects, dragging stays smooth — an item slides along an obstacle instead of sticking.

1. **Room bounds** — the item's AABB stays fully inside the footprint, ≥ 50 mm off every wall (§6.3).
2. **No AABB overlap** with any other item. `rug` is exempt (it is a floor-level plane). Solver tries
   the full move, then X-only, then Z-only, then holds position.
3. **Camera exclusion** — no part of the AABB within **2.6 ft** of the locked camera position (§3.3/§6.2).
   Rendered as a faint arc on the floor so the dead zone is visible rather than mysterious.

### Placement warnings — soft, shown live, do not block Save

4. **Opening occlusion** (§6.1) — for each opening, 5×5 raycast grid from the camera across its face
   rectangle; flag when `visible_fraction < 0.85`. Cheap enough to run on every drag commit (not per
   frame). The offending item gets an amber outline and a named message: *"Wardrobe blocks the north
   window."*
5. **Tall furniture on an opening wall** (§6.2) — `wardrobe`, `bookshelf`, `conference-table`,
   `sideboard`, `dresser` on a wall that has an opening. Warning only; in a small room every wall may
   have an opening and a hard block would make the editor unusable.

Warnings are advisory here because the render-time gate below is the real guarantee.

### Render-time gate (§6.1 fallback)

On Save, before the greybox is rendered, the same occlusion check runs server-agnostically and
auto-resolves anything still failing, in the spec's order: **shift the blocker along its wall →
shrink to ≥70% footprint → drop it (lowest `promptPriority` first)**. Never move an opening. When
auto-resolution fires, the user is told what changed — silent mutation of their layout is not
acceptable.

### Save

```
saveArrangement():
  1. resolve occlusion violations (§6.1)
  2. renderGreyboxToDataUri(spec)        → conditioning PNG, supersampled (§3.4)
  3. renderGreyboxMaskToDataUri(spec)    → Pass B mask (§7.1)
  4. POST /api/upload-greybox { projectId, dataUri, maskDataUri }
       → { key, maskKey, ledger: { doors, windows } }
  5. updateRoom(projectId, roomId, { furniture, greyboxKey, greyboxMaskKey, greyboxHash, greyboxLedger })
  6. router.push(from === "generate" ? "…/generate" : "…/furnish")
```

The existing inline **Generate** button is kept — it runs `saveArrangement()` then
`generateRoomImage(...)` and shows the result in the sidebar without navigating. It is the fastest
loop for judging whether a layout reads correctly.

---

## 4. Greybox render changes (spec §3)

### 4.1 Value ladder — `build-scene.ts`

| Element | Current | New |
|---|---|---|
| Window filler | `0xf2f2f2` | `0xfafafa`, `MeshBasicMaterial` (already basic — colour only) |
| Ceiling | `0xc8c8c8` | `0xc4c4c4` |
| Wall | `0xb4b4b4` | `0xb0b0b0` |
| Floor | `0x9a9a9a` | `0x9c9c9c` |
| Door filler | `0x8a7c6a` | unchanged — empirically validated |
| Reveal | `0x7c7c7c` | `0x6e6e6e` |
| Corner post | `0x7c7c7c` | `0x6e6e6e` |
| Rug | `0xacacac` | `0x8a8a8a` |
| Furniture frame | `0x8c8c8c` | `0x585858` |
| Furniture seat | `0x707070` | `0x484848` |
| Foliage | `0x7c8c7c` | `0x6b7d6b` |

Lighting drops to ambient `0.45`, hemisphere `0.35`, key `0.65`, fill `0.35`. Two-directional setup
kept — adjacent walls must never share exact brightness.

### 4.2 Camera — `camera.ts`

`lookAt(0, EYE_H, 0)` (was `EYE_H * 0.9`) and `camera.near = 0.15` (was `0.1`). FOV stays 85°
vertical; the deterministic 8-candidate scorer and its fixed candidate order are untouched.

### 4.3 Render — `render-to-data-uri.ts`

- Supersample: render at 2752×1536, downscale to the target before `toDataURL`.
- `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`, `setPixelRatio(1)`.
- §3.7 histogram assertion via `readPixels`: window region occupies the top 1% of luma with no wall
  pixel above it; `median(furniture) ≤ median(wall) − 0.15`; < 0.5% of non-window pixels clipped at
  255; door-panel median ≥ 0.10 from furniture median. **Fails the render loudly**; this is the only
  thing standing between a lighting tweak and a silent collapse of the ladder.

### 4.4 Aspect lock — the one open runtime question

Spec §3.4 requires the generation width/height to match the render aspect **exactly**, and names
1376×768 (1.7917). Today `runware-client.ts` generates FLUX at 1280×704 (1.8182) sd / 1920×1088
(1.7647) hd — neither matches, and nothing asserts it.

The spec claims 1376×768 is valid for Runware because both are divisible by 16. But the ControlNet
spike hit a hard `invalidWidth` 400 on exactly 1376 because FLUX.1-dev requires /64. Whether
`bfl:5@1` (FLUX.2 [pro]) relaxes that to /16 is **unverified**.

**Resolution:** probe once with a single cheap generation at 1376×768.
- Accepted → `GREYBOX_RENDER_SIZE = 1376×768`, generation pinned to the same.
- Rejected → `GREYBOX_RENDER_SIZE = 1280×704` (/64-safe, already this codebase's FLUX sd tier), and
  generation pinned to the same.

Either way the actual requirement — *render aspect === generation aspect* — is met, asserted within
0.002 before dispatch, and the constant lives in one place. This is a deliberate, flagged deviation
from the spec's literal 1376 number in favour of the rule the number was serving.

---

## 5. Pass B mask + opening ledger (spec §7.1, §4.2)

New `src/lib/greybox/render-mask.ts`. Second render, **same camera, same resolution, same frame**,
furniture hidden, everything black — except openings, which are rendered with `MeshBasicMaterial` in
**pure red for doors and pure green for windows**.

The spec says "openings pure white". Colour-coding by type is a strict improvement and costs
nothing: the mask is never sent to FLUX, and a white blob cannot tell you whether it is a door or a
window, which the ledger needs. Connected components run per channel.

### Where counting happens

`POST /api/upload-greybox` gains a `maskDataUri` field. Server-side, it decodes the mask with `sharp`
(already a dependency), runs 4-connected component labelling per channel, discards components under
64 px (anti-aliasing crumbs), and returns `{ key, maskKey, ledger: { doors, windows } }`.

`POST /api/generate-room-image` **re-derives the ledger from the stored mask** rather than trusting a
client-supplied count. One `getObject` + one sharp decode, a few ms, and it makes the prompt a pure
function of persisted artifacts — which is the §4.1 requirement. The value returned at upload time is
for immediate UI display only.

This is what makes the ledger correct: openings clipped at the frame edge, behind the camera, or
occluded by furniture do not appear in the mask, so they are never claimed in the prompt.

---

## 6. Prompt builder rewrite (spec §1, §2, §4)

### 6.1 Template

```
Photorealistic interior photograph, wide angle, eye level.

Image 1 is an untextured grey massing render of this exact room, from the exact camera
the output must use. Preserve without deviation: camera position, angle and field of
view; room proportions and all wall positions; the position, width and height of every
opening. A framed recessed panel is a closed door. A bright panel is a window. Every
other surface is solid wall.{FURNITURE_CLAUSE} Change only surfaces, materials,
lighting and furnishing.

{OPENING_LEDGER}

{ROOM_BRIEF}

{FURNITURE_MATERIALS}

{ACCENT}
```

Budget: medium 80 / contract 520 / ledger 160 / brief 240 / furniture 200 / accent 100 ≈ **1,300 chars**.
Hard assert `prompt.length <= 1800` — throws, fails the job. Log length + prompt hash on every request.
Overflow order: drop accent → trim furniture by `promptPriority` → trim brief. Never the contract or
the ledger.

**Rooms without a greybox** use the same template with the structural contract replaced by a one-line
geometry statement and no `{FURNITURE_CLAUSE}`. One code path, one budget, one assert — rather than
the current fork into a wholly different legacy prompt.

### 6.2 Ledger

Numbers as **words**, from the mask, never from `openings.length`:

> *"The room has two windows and one door. All doors are closed. Three furniture pieces are already placed."*

### 6.3 Deletions — every item on the spec's list is still live and must go

| Delete | Location today |
|---|---|
| `describeFurniturePosition` + `describeFurnitureForPrompt` | `greybox/furniture-layout.ts:46-77`, consumed at `prompt-builder.ts:210` |
| `"extra openings or furniture are a defect, not a stylistic choice"` | `prompt-builder.ts:197` |
| `"Count them in the reference before you finish…"` | `prompt-builder.ts:145-146` |
| `"more than N furniture pieces"` negative cap | `prompt-builder.ts:196` (`negativeCountAddendum`, `:184-198`) |
| `"Furniture already placed, keep it in these positions: …"` | `prompt-builder.ts:86-88` |
| `"The reference also shows exactly N furniture piece(s)… Do not add, remove, or duplicate"` | `prompt-builder.ts:167-173` |
| Room dimensions in feet | `prompt-builder.ts:54-58` |
| All negative phrasing (`Do not add one.`, `Do not add a door, window or any glazing…`) | `:147`, `:160-163`, `:171` |

`runware-client.ts` currently folds `REALISM_NEGATIVE_PROMPT` into the positive prompt for `bfl:*`
models, since FLUX.2 has no `negativePrompt` channel. **That fold must be removed** — §2.4 is explicit
that supplying an exclusion with no negation channel supplies the concept. Modern interior-photography
priors already exclude people, text and watermarks.

### 6.4 Furniture materials — and the `DesignSpecification` change it forces

§4.3 needs `{wood}`, `{soft}`, `{stone}` tokens interpolated from the room brief, and §4.4 caps the
brief at 240 chars. Today `prompt-builder.ts` inlines the *entire* `DesignSpecification` — design
language, material palette, lighting strategy, colour strategy, furniture language, camera guidelines,
negative constraints — which alone is well over 2,000 characters.

**This cannot be trimmed downstream; the planning output has to change shape.** `DesignSpecification`
gains:

```ts
interface DesignSpecification {
  // …existing fields, still used by the Design page's UI and for traceability
  /** ≤240 chars. Palette, key materials, light quality. One or two sentences. */
  compactBrief: string;
  /** Single-word-ish material tokens the furniture line interpolates. */
  materialTokens: { wood: string; soft: string; stone: string };
  roomGuidelines: RoomGuideline[];   // RoomGuideline gains its own ≤120-char `compactGuidance`
}
```

`design-planning.ts`'s Gemini response schema and the `planning` row in `prompt_templates` are updated
to produce these. The existing verbose fields stay — they are what the Design page shows the user and
what makes a spec auditable — they simply stop being pasted into the prompt.

`furniture-catalogue.ts`'s 23 entries each gain `materialPhrase` and `promptPriority`. **No new
furniture types.** The line is derived from the set of types present, deduped, pluralised, in stable
catalogue order — never insertion order, so moving a piece in the editor cannot change the prompt
text. Empty furniture array omits the line entirely.

---

## 7. Opening validation (spec §5)

New `src/lib/greybox/validate-openings.ts`, run on entry to `/furnish` and before every render. Per
wall, interval `[t − span/2, t + span/2]`:

1. No overlap between two openings on the same wall
2. ≥ 0.5 ft of solid wall between adjacent openings
3. ≥ 0.75 ft from both wall ends (corner posts are 0.22 ft; a flush opening reads as a missing wall)
4. In bounds: `t − span/2 >= 0 && t + span/2 <= 1`
5. `DOOR_HEAD`/`WINDOW_HEAD` < `CEILING_H` — assert, so a future ceiling change can't silently produce
   a wall-less opening
6. Minimum span ≥ 2.0 ft absolute

**Fail closed. Never auto-repair.** Silently moving an opening breaks the guarantee the product rests
on. A violation surfaces on the furnish card as *"Two windows overlap on the north wall — fix in the
Plan editor"*, deep-linking to `/plan` with that room selected.

---

## 8. Generate page — side-by-side versions

Today `generate/page.tsx:172-200` renders `latest` large with `olderVersions` as a reversed strip.
The requested behaviour is that a new generation appears **beside** the old one rather than displacing
it.

Change the room card body to a horizontally scrollable row of equal-size tiles in **chronological
order, newest rightmost**, auto-scrolled to the newest on arrival. Each tile carries its version
number, an `edited` badge where applicable, and click-through to View & Edit. The previous image keeps
its position and size; the new one lands next to it — direct visual comparison, which is the point.

The card's **Adjust with 3D** action (already present as `onFurnish`, gated on `room.shape`) routes to
`/furnish/[roomId]?from=generate` and returns to `/generate` on save. Its gate relaxes from
`room.shape` to "has usable dimensions" (see §9).

---

## 9. Rooms without a plan rectangle

`ensureGreyboxKey` currently bails on `if (!room.shape) return undefined`. But `shape` is the room's
rectangle *on the floor-plan image* — it is what the Plan editor manipulates and what
`deriveOpenings` uses for adjacency. **The greybox itself never reads it**; it needs only width,
depth, and `placedOpenings`.

So the gate relaxes: any room with usable dimensions gets a greybox. When `placedOpenings` is absent
but `room.openings` exists (the manual-entry path collects door/window counts per side),
`seedPlacedOpenings` spreads them evenly along their walls — already written, currently only used by
the extraction path. A manually-entered room therefore gets a real greybox and real opening
conditioning instead of falling through to text-only.

Rooms with neither dimensions nor shape keep the text-only path.

---

## 10. Data model changes

`src/lib/types.ts`:

```ts
type Phase = "upload" | "plan" | "review" | "furnish" | "design" | "generate" | "approve" | "walkthrough";

interface Room {
  // …existing
  shape?: RoomShape;
  placedOpenings?: PlacedOpening[];
  furniture?: PlacedFurniture[];
  greyboxKey?: string;
  greyboxMaskKey?: string;      // NEW — Pass B mask, `{greyboxKey}-mask`
  greyboxHash?: string;         // NEW — invalidation, §2
  greyboxLedger?: { doors: number; windows: number };  // NEW — cached for UI display only
}
```

`src/lib/store.ts`: `setRoomGreybox(projectId, roomId, {furniture, greyboxKey, greyboxMaskKey, greyboxHash, greyboxLedger})`.
`applyPlanLayout` no longer needs to clear greybox fields explicitly — the hash handles it — but it
must stop *preserving* a key whose inputs changed, which the hash comparison in `ensureGreyboxKey`
now catches.

`src/lib/nav.ts`: `PHASES` gains `{ id: "furnish", label: "Furnish", icon: "Sofa" }` between `review`
and `design`. `resumePhase` maps `parsed → review` unchanged; Furnish is entered on the forward pass
or via the stepper.

---

## 11. File manifest

| File | Change |
|---|---|
| **new** `src/app/projects/[id]/furnish/page.tsx` | Gallery, §2 |
| `src/app/projects/[id]/furnish/[roomId]/page.tsx` | Rewrite: drop orbit, add `?from=`, constraint UI, §3 |
| `src/components/project/furniture-editor-canvas.tsx` | Rewrite: locked camera, constraint solver, live occlusion, keyboard, §3 |
| **new** `src/components/project/furnish-room-card.tsx` | Gallery card |
| **new** `src/lib/greybox/render-queue.ts` | Serial WebGL queue, §2 |
| **new** `src/lib/greybox/render-mask.ts` | Pass B mask, §5 |
| **new** `src/lib/greybox/greybox-hash.ts` | Invalidation, §2 |
| **new** `src/lib/greybox/validate-openings.ts` | §7 |
| **new** `src/lib/greybox/validate-furniture.ts` | Constraint solver + occlusion raycast, §3 |
| **new** `src/lib/greybox/count-openings.ts` | Server-side connected components (sharp), §5 |
| `src/lib/greybox/build-scene.ts` | Value ladder + lighting, §4.1; mask-mode flag |
| `src/lib/greybox/camera.ts` | `lookAt(0, EYE_H, 0)`, `near = 0.15`, §4.2 |
| `src/lib/greybox/render-to-data-uri.ts` | Supersample, renderer settings, histogram assert, §4.3 |
| `src/lib/greybox/furniture-catalogue.ts` | `materialPhrase` + `promptPriority` on all 23. No new types |
| `src/lib/greybox/furniture-layout.ts` | **Delete** `describeFurniturePosition` / `describeFurnitureForPrompt`. Add `buildFurnitureMaterials` |
| `src/lib/greybox/ensure-greybox-key.ts` | Hash-based invalidation; drop the `shape` gate, §9 |
| `src/lib/ai/prompting/prompt-builder.ts` | Full rewrite against §6 |
| `src/lib/ai/prompting/design-planning.ts` | `compactBrief` + `materialTokens` + `compactGuidance`, §6.4 |
| `src/lib/ai/prompting/types.ts` | `DesignSpecification` fields |
| `src/lib/ai/prompting/templates.ts` | Updated planning/builder defaults |
| `src/lib/render/runware-client.ts` | Aspect lock §4.4; remove the `Avoid:` negative fold §6.3 |
| `src/app/api/upload-greybox/route.ts` | Accept `maskDataUri`, return `ledger`, §5 |
| `src/app/api/generate-room-image/route.ts` | Re-derive ledger from mask; pass width/height, §5 |
| `src/app/projects/[id]/generate/page.tsx` | Side-by-side versions §8; relax the Furnish gate |
| `src/app/projects/[id]/design/page.tsx` | Greybox is a fallback, not the primary path |
| `src/app/projects/[id]/review/page.tsx` | Continue → `/furnish` |
| `src/lib/nav.ts`, `src/lib/types.ts`, `src/lib/store.ts` | §10 |

Deleted: `src/components/project/greybox-preview.tsx` — Phase 0 spike scaffolding, zero callers,
superseded by `render-to-data-uri.ts`.

---

## 12. Explicitly out of scope

Deferred to a follow-up, per the scope decision:

- §7.2 two-tier validation gate (deterministic CV sampling + VLM structured check)
- §7.3 deterministic per-attempt seeds and the max-3 retry loop
- §9 calibration harness (8 seeds × 5 arms)
- §10 phased furniture rollout gating

Permanently out of scope, unchanged from the Phase A/B designs: collision-free *automatic* layout,
L-shaped and non-rectangular rooms, multi-floor plans, manual camera override, multiple views per
room, imported 3D asset libraries, multi-room bulk furnishing.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **The fixed camera has dead zones.** Anything behind the camera or inside the 2.6 ft exclusion arc cannot be dragged to | New items are placed by a deterministic search for the first slot that is in-frame, legal and non-overlapping. Arrow-key nudge reaches anything drag can't. The exclusion arc is drawn on the floor |
| **1376 may be rejected by `bfl:5@1`** | Probe first; one constant governs both render and generation either way, §4.4 |
| **Compressing the design spec to 240 chars may visibly weaken style fidelity** | The verbose fields are kept and still shown to the user; only the prompt payload shrinks. If fidelity drops, the brief budget is the first thing to raise — there is 500 chars of headroom under the 1800 cap |
| **Regenerating every greybox against the new value ladder invalidates all cached references** | Intended. `GREYBOX_RENDER_VERSION` makes it explicit and one-line reversible |
| **The histogram assert (§3.7) may fail on legitimate rooms** | It runs client-side at save time with a clear message naming which of the four conditions failed, not as a silent server-side throw |
