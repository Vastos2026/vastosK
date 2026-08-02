# Phase B — furniture, implementation plan

**Date:** 2026-08-01
**Branch:** `worktree-greybox-opening-placement`
**Background:** `docs/superpowers/specs/2026-08-01-greybox-full-build-plan.md` section 6 (the
approved high-level sketch this plan makes concrete), `2026-08-01-greybox-opening-placement-design.md`.
**Depends on:** Phase A (openings) shipped and verified in a real browser — task tracked
separately; this phase does not start building until that closes.

---

## 1. Scope recap (from the full build plan, unchanged)

- Furniture is **procedural proxy shapes built from primitives** — no asset library, no text
  ever rendered into the reference image (a box labelled "SOFA" risks the model literally
  rendering that word onto a cushion).
- Furniture is placed in the **3D greybox only** (orbit + drag), not on the 2D plan.
- The exported reference always renders from the **locked automatic camera**
  (`greyboxCamera`), never from wherever the user free-orbited to while editing.
- Build order: Phase A ships and is verified first (already decided, not re-litigated here).

## 2. Furniture catalogue

Keyed by the app's existing room-type strings (`config/project-types/*.json`), so the 3D
editor knows what to offer without the user picking a catalogue by hand. `Custom` category
rooms have no fixed type list — they fall back to a small universal set (rug, plant, side
table) rather than nothing.

| Room type | Items offered |
| --- | --- |
| Living Room / Lounge | sofa, armchair, coffee table, TV unit, rug, plant, side table |
| Dining Room | dining table, dining chair (×N), sideboard, rug |
| Master Bedroom / Bedroom / Guest Room | bed, nightstand (×2), wardrobe, dresser, bench, rug |
| Study / Cabin | desk, office chair, bookshelf, rug |
| Kitchen / Pantry | kitchen island, bar stool |
| Pooja Room | pooja mandir (small altar cabinet) |
| Foyer / Reception | console table, bench, rug |
| Balcony | outdoor chair (×2), small table, plant |
| Meeting Room / Conference Room | conference table, chair (×N) |
| Open Workspace | desk (×N), office chair (×N) |
| Bathroom / Washroom, Utility, Store Room, Storage | none — proxy furniture adds no value here, skip in the editor |

Every catalogue entry is `{ kind, label, footprintFt: {w, d}, build(): THREE.Object3D }`.
`footprintFt` drives both the editor's floor-plane collision-avoidance-free free placement (no
collision detection in v1 — a user dragging two items on top of each other is a real
possibility, not solved here, see Risks) and default spacing when an item is first added.

## 3. Proxy geometry — built from primitives, feet-scale

Same coordinate convention `build-scene.ts` already uses: Y-up, floor at y=0, all dimensions in
feet (matching `CEILING_H = 10`, `layoutSize`'s feet-scale room footprint). New file
`src/lib/greybox/furniture-catalogue.ts`.

Representative constructions (all flat `MeshStandardMaterial`, same grey palette as the room
shell — colour is the prompt's job, not the reference's, exactly like walls/doors/windows):

- **Bed**: mattress box (`BoxGeometry`, ~6.5×1.3×4.5 ft) + a taller thin headboard box at one
  edge.
- **Sofa**: seat slab + a back slab + two arm boxes, three primitives.
- **Wardrobe**: one tall box, ~2×7×2 ft.
- **Nightstand / side table**: one small box.
- **Dining/conference table**: one flat-top box on four thin leg cylinders.
- **Chair (dining/office)**: seat box + back slab, simplified — no legs modelled individually,
  a single thin support box is enough for the model to read "chair" without adding visual noise
  a proxy this small can't usefully resolve anyway.
- **TV unit**: a low, wide box.
- **Rug**: a flat plane, slightly inset from the room's footprint, distinguished from the floor
  by a marginally different grey so it reads as a distinct object.
- **Plant**: a cylinder (pot) + a sphere or icosahedron (foliage) — the one non-boxy shape,
  deliberately, since a plant is the one item whose silhouette a box would misread badly.
- **Pooja mandir**: a small tiered box structure (two stacked boxes of decreasing size).

Each `build()` returns a `THREE.Group` centred on its own local origin at floor level, so
placement is just `group.position.set(x, 0, z); group.rotation.y = rotation`.

## 4. Data model

Already sketched in the full build plan, landing as-is:

```ts
furniture?: {
  id: string;
  kind: string;   // catalogue key, e.g. "bed-double"
  x: number;      // room-local, 0..1 across width
  z: number;      // room-local, 0..1 across depth
  rotation: number; // radians
}[];
```

Room-local `0..1` converts to world feet the same way the room footprint itself does:
`worldX = (x - 0.5) * width`, `worldZ = (z - 0.5) * depth` (matching `build-scene.ts`'s
centred-at-origin convention). New helper `src/lib/greybox/furniture-layout.ts` owns this
conversion plus a `defaultFurnitureFor(roomType): PlacedFurniture[]` that seeds a sensible
starting arrangement (e.g. a bedroom starts with a bed centred against the wall opposite its
door) so the editor never opens to an empty room — same "start with something to adjust, not a
blank canvas" principle Phase A already applied to openings.

## 5. 3D room editor — `/projects/[id]/furnish/[roomId]`

New page, one room at a time, reachable from Room Confirmation or Generate (exact entry point
decided during Phase B UI work — likely a "Furnish" action alongside each room card, parallel
to how "Place" worked in Phase A's Plan Editor before auto-seeding).

- Renders the room's greybox scene (reusing `buildGreyboxScene`, extended per section 6) in an
  orbit-controlled `<canvas>` — free look, not locked to the export camera, so the user can
  actually see what they're placing.
- Catalogue panel: buttons for this room type's available items (section 2); clicking adds one
  at a default position via `defaultFurnitureFor`-style placement (spread out, not stacked).
- Drag: raycast from pointer against the floor plane (y=0) to reposition the selected item;
  rotate via a keyboard shortcut or an on-canvas handle (same interaction family
  `plan-editor-canvas.tsx` already uses for openings, translated to 3D); Delete/Backspace
  removes the selected item.
- A visible **framing indicator** — a wireframe camera-frustum gizmo at `greyboxCamera`'s fixed
  position/orientation, always rendered regardless of where the user has orbited to. This is
  the mitigation for the "orbit vs. export camera" risk the full build plan already flagged:
  without it, a user who orbits away from the locked camera has no way to know the render
  won't come from where they're looking.
- "Save" re-renders the export-camera view (not the orbit view) via `renderGreyboxToDataUri`,
  uploads it, and clears any cached `greyboxKey` so `ensureGreyboxKey` re-renders — same
  invalidate-on-change pattern Phase A uses for opening edits.

## 6. Greybox integration

`build-scene.ts`'s `buildGreyboxScene` gains an optional `furniture` param: after the existing
floor/ceiling/walls/corner-posts, iterate `PlacedFurniture[]`, look up each `kind` in the
catalogue, call `build()`, position/rotate per section 4's conversion, add to the group. Purely
additive — a room with no furniture renders exactly as it does today, so this cannot regress
Phase A.

`ensure-greybox-key.ts` passes `room.furniture ?? []` through alongside `room.placedOpenings`,
and its "already rendered, reuse the stored key" short-circuit needs one addition: the cache
must also invalidate when furniture changes, not just when it's missing — track this via a
content hash (or simplest: always clear `greyboxKey` from the store the moment furniture is
edited, same as the 3D editor's "Save" step above already does, so `ensureGreyboxKey`'s
existing `if (room.greyboxKey) return` naturally re-renders).

## 7. Prompt

`prompt-builder.ts` gains a furniture clause, additive to the existing strict geometry block,
naming each placed item and its rough position ("a sofa along the south wall, an armchair near
the east window") — reinforcing what the reference image already shows, in the same spirit as
the existing "every door is closed" / "no glazing at corners" reinforcement lines. This is text
support for a shape already in the pixels, never a substitute for it (per the full build plan's
"shape identifies the item... text stays in the prompt, never in the image").

## 8. Verification

Same method as Phase A6: real project, real generation, compare output against the room's own
greybox reference — do the furniture proxies read as their intended items (sofa reads as sofa,
not an ambiguous grey blob), and does the model's furnished output roughly respect where they
were placed. Per the full build plan's Risks section, this is explicitly the open question
Phase B exists to answer — expect at least one iteration on proxy shapes or prompt wording
before this looks right, not a one-shot pass.

## 9. Risks (carried from the full build plan, made concrete)

- **No collision detection in v1.** A user can drag two items on top of each other. Not solved
  here — flagged as a known gap, revisit only if it proves to actually happen in testing rather
  than solving it speculatively.
- **Control vs. beauty**, still the central open question — crude proxies may read as staged
  rather than photographic once materialised. This plan doesn't presume an answer; Phase B's
  verification step is where that gets found out.
- **Proxies may be mangled** — mitigated by testing the catalogue on 3-4 items before it's
  considered complete, per the full build plan.

## 10. Not building in this pass

Real-world furniture catalogs/asset libraries, furniture on the 2D plan, collision detection,
multi-room bulk furnishing, undo/redo in the 3D editor.
