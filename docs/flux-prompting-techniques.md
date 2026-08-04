# Greybox → FLUX.2 Pipeline — Implementation Spec

Authoritative spec for the room-render pipeline. Supersedes prior prompt-builder behaviour.
Read fully before editing `src/lib/greybox/` or `prompt-builder.ts`.

**Priority order, non-negotiable:** openings > wall layout > camera → then furniture.
Furniture yields to everything on its left, always.

---

## A note on how to use this document

This spec was written by an assistant with deep knowledge of FLUX.2's prompting mechanics,
Runware's API surface, and the general failure modes of reference-conditioned diffusion —
verified where possible against source docs (Runware schemas, the `black-forest-labs/flux2`
repo) and against one real generated output (§2.3). It does **not** have visibility into the
current state of this codebase beyond the summary it was given: it hasn't read the actual
`build-scene.ts`, `prompt-builder.ts`, camera scorer, or furniture editor, doesn't know what
else depends on them, and can't see recent changes.

So: treat every rule and number here (§0 aside, which reflects explicit product decisions) as
**a constraint to satisfy, not a diff to apply blindly.** Read the actual current source before
editing. If something in the codebase already satisfies a rule in a different but equally
valid way, prefer the existing pattern. If a rule here conflicts with something structural
about the codebase that this document couldn't have known about, flag it rather than forcing
the change through.

Plan your own implementation order — §11's file list is a manifest of *what* needs to change,
not a required sequence. The one hard dependency: **§7.1 (Pass B mask) must ship in the same
change as the §4 prompt-builder rewrite**, since the opening ledger reads from the mask, not
from `openings.length` — landing one without the other leaves the ledger either broken or
still reading the old source of truth.

Before writing code, work from the checklist in §12 — it's the compressed form of every rule
in this document. If a change satisfies every relevant line in that checklist, it's compliant
regardless of whether it matches the prose above verbatim.

---

## 0. Locked decisions

These are settled. Do not re-litigate them in code review.

| Decision | Value |
|---|---|
| Camera FOV | **85° vertical, locked.** All openings in frame wins over lens realism |
| Camera selection | Deterministic 8-candidate scorer, existing algorithm |
| User camera control | **None.** No orbit, no reposition, no FOV control in the UI |
| Door/window relocation by user | **Not permitted.** Openings are read-only after room definition |
| Opening overlap | **Forbidden.** Enforced at validation, §5 |
| Furniture catalogue | The existing 23 entries. **Do not add new types** |
| Output aspect ratio | Must equal render aspect exactly, §3.4 |

---

## 1. The constraint everything else follows from

**FLUX.2's text encoder truncates at 512 tokens. Runware accepts `positivePrompt` up to
32,000 characters and silently discards the overflow — no error, no warning.**

512 tokens ≈ 1,800–2,050 characters ≈ 260–300 English words.

The current prompt is roughly 3,500 characters (~875–1,000 tokens) with the geometry clause
beginning near character 2,044. **That clause has never reached the model.** Every accuracy
problem attributed to prompt tuning has been diagnosed against a prompt whose most important
paragraph was discarded before inference.

### Rules

- **R1.** Hard-assert `prompt.length <= 1800`. Throw and fail the job. Never send over.
- **R2.** Target 1,300–1,500 chars steady state. Margin absorbs tokenizer variance.
- **R3.** Log `prompt.length` and a prompt hash with every request.
- **R4.** Ordering is a safety mechanism, not style. Truncation eats the tail, so geometry
  goes first and expendable detail goes last. Note the scale of this effect: it mattered a
  great deal when the old prompt ran ~875–1,000 tokens and the geometry clause fell past the
  512-token cut. At the §2.4 budget (~1,300 chars, well under the cap) nothing gets
  truncated, so ordering costs nothing to keep correct but isn't doing heavy lifting on its
  own — don't over-index on section order once the prompt is safely under budget.

---

## 2. Prompt structure

### 2.1 Fixed section order

1. Medium + lens (one line)
2. Structural contract (fixed boilerplate)
3. Opening ledger (generated from geometry)
4. Room brief (palette, materials, light)
5. Furniture materials (generated from `room.furniture`)
6. Accent (optional, always last, expendable by design)

Section 6 is engineered to be the thing that gets cut if anything gets cut.

### 2.2 Template

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

`{FURNITURE_CLAUSE}` is appended inline only when furniture exists:

```
 Darker grey volumes are furniture: keep their position, footprint and approximate size.
```

### 2.3 No focal length in the prompt — tested and rejected

An earlier draft of this spec called for `Ultra-wide 14mm` on the reasoning that the 85°
render (~117° horizontal, roughly a 12–14mm lens) sits well outside the training distribution
for interior photography, and that the model would "correct" the perspective in a way that
drags opening positions with it.

**Tested against a real output and falsified.** With no lens instruction at all — just
`wide angle, eye level` — FLUX.2 normalised the perspective to roughly 20–24mm, and the
door/window geometry still matched the reference. The coupling assumed above does not hold:
the model can renormalise perspective without moving openings.

Separately, the product requirement is that **small camera drift is acceptable** as long as
door/window/furniture accuracy holds. Naming the focal length would buy camera fidelity that
isn't required, at the cost of real problems: barrel distortion, stretched furniture at frame
edges, a less photographic result.

**Do not add lens/focal-length language to the prompt.** `level camera` in §3.3 stays — it
reduces keystoning in the *input* render, which is free and independent of this question.

### 2.4 Deleted permanently

| Deleted | Reason |
|---|---|
| `extra doors, windows or furniture are a defect, not a stylistic choice` (`prompt-builder.ts:196`) | Threat framing. No mechanism in a diffusion transformer responds to it |
| `Count them in the reference before you finish...` | The model has no verification step and cannot recount |
| `Furniture already placed, keep it in these positions: a bed near the north wall; ...` (`prompt-builder.ts:86-88`) | See §2.5 |
| `The reference also shows exactly N furniture piece(s)... Do not add, remove, or duplicate` (`:167-173`) | Folded into the ledger, §4.2 |
| `no more than 3 furniture pieces` (`:196`) | Negative cap; replaced by positive ledger count |
| `tack-sharp focus`, `not plastic-looking`, `structurally real and buildable` | Quality incantations |
| `no people, no text, no watermarks, no logos` | **There is no `negativePrompt` on `bfl:5@1` or `bfl:6@1`.** Writing exclusions into the positive prompt supplies the concept with no negation channel. Modern interior-photography priors already exclude these |
| `if space allows`, `where appropriate` | Unevaluable conditionals. The model cannot measure; it adds the thing and invents wall space to fit it |
| Room dimensions in feet | The greybox encodes proportion far more precisely |

**General rule: every constraint gets a positive phrasing or gets deleted.** `solid wall` not
`no window`. `one door` not `no extra doors`. `closed` not `not open`.

### 2.5 Delete `describeFurniturePosition` entirely

`describeFurnitureForPrompt` → `describeFurniturePosition` buckets `x,z` into zones and emits
`a bed near the north wall; a nightstand near the northwest corner`. Delete both functions.

Rationale: once furniture is in the render, the render is the single source of spatial truth.
Positional prose creates a second source that can disagree with it — and when the model must
reconcile a text claim against the reference, geometry is what moves. Coarse zone buckets
disagree with the render routinely, because "near the north wall" is a much larger region than
the actual proxy footprint.

Deleting this is a token saving *and* removes a whole class of conflict. The prompt says what
things are made of. The render says where they are.

---

## 3. Greybox render

### 3.1 Value ladder

Furniture must be the darkest thing in frame, well clear of the shell. Current constants fail
this: `FRAME_COLOR 0x8c8c8c` (55%) sits between `REVEAL 0x7c7c7c` (49%) and `FLOOR 0x9a9a9a`
(60%), so proxies do not separate from the room.

| Element | Current | **New** | Notes |
|---|---|---|---|
| Window filler | `0xf2f2f2` | `0xfafafa` | **`MeshBasicMaterial`** — see §3.2 |
| Ceiling | `0xc8c8c8` | `0xc4c4c4` | |
| Wall | `0xb4b4b4` | `0xb0b0b0` | |
| Floor | `0x9a9a9a` | `0x9c9c9c` | |
| Door filler | `0x8a7c6a` | `0x8a7c6a` | **Keep.** Empirically validated, desaturated, small frame area |
| Reveal | `0x7c7c7c` | `0x6e6e6e` | Darker reads depth better |
| Corner post | `0x7c7c7c` | `0x6e6e6e` | |
| Rug | `0xacacac` | `0x8a8a8a` | Was brighter than floor; now sits between floor and furniture |
| Furniture frame | `0x8c8c8c` | `0x585858` | |
| Furniture seat | `0x707070` | `0x484848` | |
| Foliage | `0x7c8c7c` | `0x6b7d6b` | Same hue, moved into the furniture band |

**Gaps matter more than absolute values.** Keep furniture (28–35%) far from door (~49% luma)
so a wardrobe is never read as a door panel — a real and common failure mode.

### 3.2 Colour policy

The rule is not "greyscale." It is: **colour encodes semantic invariants; grey encodes design
variables.**

- **Colour permitted** on things whose colour never varies across briefs and which occupy
  **under ~10% of frame area**: foliage green, door-panel brown, window white.
- **Grey required** on everything the prompt is *for*: walls, floor, ceiling, upholstery,
  cabinetry, wood finishes. Rendering a wardrobe in oak brown makes the reference compete with
  the prompt for material authority — and the reference wins on geometry, so you would lose
  "matte black cabinetry" to a baked-in brown.
- The area cap exists because as colour accumulates, the greybox stops reading as a massing
  study and starts reading as a finished render. FLUX.2 then lightly denoises rather than
  re-synthesising, and the output looks CGI. Small colour patches don't trigger this. Large
  ones do.

### 3.3 Camera

FOV stays at 85° vertical. Two mitigations, both free:

**Level the camera.** Change `lookAt(0, EYE_H * 0.9, 0)` → `lookAt(0, EYE_H, 0)`.

The downward tilt introduces vertical keystoning — walls converge toward the top of frame. At
85° this is severe. Architectural photography keeps the sensor plane vertical precisely to
avoid it, so a tilted ultra-wide is doubly outside the training distribution. A level camera
gives clean two-point perspective, verticals stay parallel, and the model has far less reason
to "fix" anything. This addresses the worse half of the ultra-wide problem without touching FOV.

**Near-plane and exclusion zone.** Corner candidates inset 4% put the camera ~0.4 ft off the
wall in a 10 ft room. With furniture this puts proxies at the lens.

- `camera.near = 0.15` ft
- No furniture within **2.6 ft** of the camera position. Enforced in §6.

Keep the deterministic 8-candidate scorer and its fixed candidate order — same room spec must
always yield the same viewpoint.

### 3.4 Resolution and aspect lock

Render is 1376×768 (aspect 1.7917).

**The generation `width`/`height` must produce exactly this aspect.** Any mismatch and FLUX.2
letterboxes or crops, which breaks the camera match the entire pipeline depends on. 1376×768
is valid for Runware (both divisible by 16, within 256–2048).

- Generate at **1376×768**. Do not "round to 16:9" — 1.7778 ≠ 1.7917 and the drift is visible.
- Supersample the greybox: render at **2752×1536**, downscale to 1376×768 before upload.
  Cleaner edges on reveals and corner posts, no aliasing speckle for the model to read as
  texture. Cheap — it's one offscreen render.
- Assert `renderAspect === genAspect` within 0.002 before dispatch.

### 3.5 Renderer settings

```ts
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;  // keep values predictable and flat
renderer.setPixelRatio(1);                    // supersample explicitly, not via DPR
```

Window filler must be unlit so it is brightest by construction:

```ts
new THREE.MeshBasicMaterial({ color: 0xfafafa })
```

Currently it's a lit material, so the light rig decides its final value — meaning the "bright
panel is a window" contract in the prompt is not guaranteed by the render.

### 3.6 Lighting

Materials are darker now, so pull the rig back to avoid clipping:

| | Current | New |
|---|---|---|
| Ambient | 0.55 | 0.45 |
| Hemisphere | 0.5 | 0.35 |
| Directional key | 0.75 | 0.65 |
| Directional fill | 0.4 | 0.35 |

Keep the two-directional setup — the reasoning that adjacent walls must never share exact
brightness is correct and load-bearing. Keep soft/ambient character; **no hard shadows**, they
get read as material and lighting intent and baked into the output.

### 3.7 Post-render histogram assertion

Material colours are not rendered values. Verify the actual pixels:

```
readPixels → luma histogram, then assert:
  1. window region occupies the top 1% of luma, and no wall pixel exceeds it
  2. median(furniture pixels) <= median(wall pixels) - 0.15
  3. < 0.5% of non-window pixels are clipped at 255
  4. door-panel median luma is at least 0.10 from furniture median
```

Fail the render, don't fail silently. This is the only thing standing between a lighting tweak
and a silent collapse of the value ladder.

---

## 4. Prompt builder

### 4.1 Single source of truth

`room.furniture: Array<{ type: CatalogueKey; x: number; z: number; rot: number }>`

The prompt is a **pure function** of `(room.openings, room.furniture, room.brief, camera)`.
No hand-entered counts, no manual sync. Add a plant, remove a wardrobe — the prompt changes
because the derivation re-runs, not because anything was edited.

### 4.2 Opening ledger

Counts come from the **Pass B mask** (§7.1), not from `room.openings.length`. Openings clipped
at frame edge, behind the camera, or occluded by furniture must not be claimed.

```ts
const { windows, doors } = countVisibleOpenings(maskPixels); // connected components

// numbers as WORDS — word-forms are single semantic tokens and are better
// represented in text-encoder space than digits
const ledger = [
  `The room has ${word(windows)} ${plural(windows,'window')} and ${word(doors)} ${plural(doors,'door')}.`,
  `All doors are closed.`,
  furniture.length ? `${cap(word(furniture.length))} furniture ${plural(furniture.length,'piece')} are already placed.` : ''
].filter(Boolean).join(' ');
```

The furniture count is folded here as a positive statement. It replaces both the old
`:167-173` clause and the `:196` negative cap.

### 4.3 Furniture materials — the add/remove logic

This is the mechanism for "user adds a plant, removes the wardrobe."

Each catalogue entry carries a material phrase and a priority. The prompt line is derived from
the *set of types present*, never from a hand-maintained string.

```ts
// furniture-catalogue.ts — extend existing entries, add no new types
interface CatalogueEntry {
  key: CatalogueKey;
  build(): THREE.Group;
  rooms: RoomType[];
  materialPhrase: string;  // NEW
  promptPriority: number;  // NEW — lower = dropped first under budget
}
```

Suggested phrases (all material, zero position — that is the whole point):

```
bed             upholstered bed in {soft}
wardrobe        {wood} wardrobe
dresser         {wood} dresser
nightstand      {wood} nightstands
sofa            {soft} sofa
armchair        {soft} armchair
coffee_table    {wood} coffee table
tv_unit         low {wood} media console with a black screen
dining_table    {wood} dining table
dining_chair    {soft} dining chairs
sideboard       {wood} sideboard
desk            {wood} desk
office_chair    dark task chair
bookshelf       {wood} open shelving
kitchen_island  {stone}-topped island
bar_stool       {wood} bar stools
pooja_mandir    carved {wood} pooja mandir
console_table   slim {wood} console
bench           {wood} bench
conference_table {wood} conference table
outdoor_chair   woven outdoor chair
side_table      {wood} side table
rug             a soft neutral rug
plant           a potted green plant
```

`{wood}`, `{soft}`, `{stone}` interpolate from `room.brief` so the line inherits the palette
rather than restating it.

```ts
function buildFurnitureMaterials(furniture, brief, budget = 200): string {
  if (!furniture.length) return '';

  // dedupe by type, pluralise on count, stable catalogue order
  const groups = groupByType(furniture);
  let parts = CATALOGUE
    .filter(e => groups.has(e.key))
    .sort((a, b) => a.order - b.order)
    .map(e => interpolate(e.materialPhrase, brief, groups.get(e.key).length));

  // budget enforcement: drop lowest promptPriority first, never truncate mid-phrase
  while (render(parts).length > budget && parts.length > 1) {
    parts = dropLowestPriority(parts);
  }

  return `The dark massing volumes are furniture: ${joinList(parts)}.`;
}
```

**Determinism requirements:**
- Stable catalogue ordering, never insertion order — otherwise moving a piece in the editor
  changes prompt text, which busts caches and destroys A/B comparability.
- Empty array → the line is **omitted entirely**, never `"zero furniture pieces"`. The current
  code already gets this right; preserve it.
- Same `(openings, furniture, brief)` → byte-identical prompt. Assert in tests.

### 4.4 Budget allocation

| Section | Budget |
|---|---|
| Medium + lens | 80 chars |
| Structural contract | 520 chars (fixed) |
| Opening ledger | 160 chars |
| Room brief | 240 chars |
| Furniture materials | 200 chars |
| Accent | 100 chars |
| **Total** | **~1,300 chars** — 500 under cap |

Overflow order: drop accent → trim furniture by priority → trim brief. **Never trim the
structural contract or the ledger.**

---

## 5. Opening validation

Users cannot relocate openings, but generated/imported geometry still needs checking.

```ts
function validateOpenings(openings: GreyboxOpening[], room): ValidationResult
```

Per wall, with `t` = centre ∈ [0,1] and `span` = width fraction, interval
`[t - span/2, t + span/2]`:

1. **No overlap.** For any two openings on the same wall, intervals must not intersect.
2. **Minimum separation.** ≥ 0.5 ft of solid wall between adjacent openings, converted to
   normalised units via that wall's length.
3. **Corner clearance.** Interval must stay ≥ 0.75 ft from both wall ends. Corner posts are
   0.22 ft wide; an opening flush to a corner reads as a missing wall.
4. **In bounds.** `t - span/2 >= 0 && t + span/2 <= 1`.
5. **Head height.** `DOOR_HEAD 7` and `WINDOW_HEAD 7` must be < `CEILING_H 10`. Already true;
   assert so a future ceiling change can't silently produce a wall-less opening.
6. **Minimum span.** ≥ 2.0 ft absolute. Narrower reads as a niche, not an opening.

Fail closed — refuse to render, surface the specific violation. Do not auto-repair; silently
moving an opening breaks the guarantee the whole product rests on.

---

## 6. Furniture validation

Occlusion is the **only** mechanism by which furniture threatens opening accuracy. An opening
the camera cannot see is an opening the model will invent.

Run all three checks before render. Furniture always yields.

### 6.1 Opening occlusion (raycast)

```ts
for (const opening of openings) {
  // 5×5 grid across the opening's face rectangle
  const samples = sampleFace(opening, 5, 5);
  const visible = samples.filter(p => {
    const hit = raycaster.set(camera.position, dir(p)).intersectObjects(scene, true)[0];
    return hit && hit.object.userData.openingId === opening.id;
  }).length;
  if (visible / 25 < 0.85) violations.push({ opening, furniture: blocker(opening) });
}
```

**Gate: `visible_fraction >= 0.85` for every opening.** On failure, in order: shift the
blocker along its wall → shrink to ≥70% footprint → drop it (lowest `promptPriority` first).
Never move an opening to accommodate furniture.

### 6.2 Placement heuristics (cheap, run first)

- **Tall furniture (>1.2 ft above 1.2 m — wardrobe, bookshelf, conference-scale pieces) only
  on walls with no openings.** This alone prevents most violations.
- 300 mm clear band around every opening's wall projection.
- Nothing within **2.6 ft** of the camera (§3.3).
- Low furniture (<700 mm — beds, coffee tables, consoles, rugs) may sit under windows. Normal
  and reads correctly.

### 6.3 Collision and bounds

- No AABB overlap between any two proxies (rugs exempt — they're floor-level planes).
- All proxies fully inside the room footprint, ≥ 50 mm off walls.
- **Cap 5 pieces**, enforced in the `/furnish/[roomId]` editor UI, not just at render.
  Past ~6 the massing reads as clutter and buries the wall junctions the model needs.

---

## 7. Validation gate

Nothing exists yet. Build this before the first batch. At 50–100 rooms you cannot eyeball
every output, and no prompt reaches 100% compliance.

**Budget ~1.3–1.6 generations per delivered room.**

`generate → validate → accept | retry(new seed, max 3) → escalate to human`

### 7.1 Pass B — the opening mask

The highest-leverage asset available, and it exists only because you own the scene.

Second render, **same camera, same resolution, same frame**: openings pure white
(`MeshBasicMaterial 0xffffff`), everything else pure black, furniture hidden.

```ts
renderGreyboxMask(scene, camera) // → PNG, stored beside the conditioning render, never sent to FLUX
```

Uses:
- **Ground-truth opening count** via connected components → feeds the §4.2 ledger. No manual
  entry, no drift between prompt and geometry.
- **Deterministic CV validation** — sample the generated output at each mask centroid and
  confirm brightness/glazing; sample known-solid wall regions and confirm they are *not*
  bright. Far stronger than asking a VLM to count windows, and free per call.
- Debug overlays on failure.

Store the mask under `{greyboxKey}-mask`.

### 7.2 Two-tier validation

**Tier 1 — deterministic CV (always, ~free):**

```
1. For each mask component centroid → sample 32×32 in output.
   Window: mean luma > wall-region mean + 0.20  → pass
   Door:   detectable vertical rectangular edge → pass
2. For solid-wall regions (mask black, ≥ 40px from any component):
   assert no window-like bright rectangular region → catches invented openings
3. Frame-edge histogram correlation between greybox and output
   → catches camera/FOV drift. Threshold: r > 0.6
```

**Tier 2 — VLM, only on Tier 1 pass (Qwen2.5-VL-7B-Instruct on Runware, or Claude):**

Structured JSON, one question per field. Never ask for a holistic judgement.

```json
{
  "window_count": 2,
  "door_count": 1,
  "any_door_open": false,
  "camera_matches_reference": true,
  "wall_layout_matches_reference": true,
  "openings_at_same_positions": true,
  "furniture_count": 3
}
```

Accept only on exact match to the ledger. Log every rejection with seed, prompt hash and
failing field — that dataset is the only thing that will tell you whether a future template
change actually helped.

### 7.3 Retry

```ts
seed = int(sha256(`${projectId}:${roomId}:${attempt}`).slice(0,8), 16)
```

Deterministic per attempt, so any room is exactly reproducible. Max 3 attempts, then flag for
human review. **Do not mutate the prompt between retries** — you lose the ability to attribute
the failure.

---

## 8. Runware call

```json
{
  "taskType": "imageInference",
  "taskUUID": "<uuid4>",
  "model": "bfl:5@1",
  "positivePrompt": "<§2 template, asserted <1800 chars>",
  "width": 1376,
  "height": 768,
  "seed": 1734829102,
  "numberResults": 1,
  "outputFormat": "JPG",
  "outputQuality": 95,
  "deliveryMethod": "async",
  "webhookURL": "<...>",
  "includeCost": true,
  "inputs": { "referenceImages": ["<greybox_url>"] }
}
```

- **`promptUpsampling` must never be enabled.** It routes the prompt through Mistral for
  "enhancement," which paraphrases and can drop or soften the structural contract. Not exposed
  on `[pro]`; on `[flex]` it defaults false — leave it.
- **No `negativePrompt` exists on `bfl:5@1` or `bfl:6@1`.** Confirmed against both schemas.
  Exclusions must be deleted or positively phrased, never relocated.
- **`[pro]` for production** (~$0.03/1024²). `[flex]` (`bfl:6@1`, ~$0.06) only for calibration
  — it is the sole way to measure `CFGScale` (1.5–5.0, default 2.5) against structural fidelity.
- Always send an explicit seed. Never rely on the random default.
- `referenceImages` accepts 1–9 on pro, 1–10 on flex. **Send exactly one.** Multi-reference is
  built for attribute transfer across different subjects and carries no spatial-correspondence
  guarantee between two views of one scene.

---

## 9. Calibration before the first batch

Fix one room, fix 8 seeds, change exactly one variable, 8 images per arm, score with §7.

The original comparison changed prompt length, resolution *and* room simultaneously, so it
could not identify a cause. Do not repeat that.

Arms, in priority order:

1. **Truncation fix alone** — current prompt vs §2 template, same room, same resolution, same
   seeds. Should dominate every other effect. Confirm before touching anything else.
2. **Level camera** — `EYE_H * 0.9` vs `EYE_H`.
3. **Value ladder** — current constants vs §3.1.
4. **Furniture on/off** — the Phase 1 → Phase 2 gate, §10.
5. **CFGScale** on flex — 2.0 / 2.5 / 3.5 / 4.5.

(Lens naming was a candidate arm in an earlier draft. It's been tested directly against a real
output — §2.3 — and dropped from the harness; no need to re-run it.)

~100 images ≈ $3–6. Cheap against re-running a 100-room batch that silently broke its geometry.

---

## 10. Rollout

Furniture is secondary. Stage it behind the gate.

**Phase 1 — openings only.** §2 prompt, §3 render, no furniture. Establish baseline opening
pass-rate. Do not proceed until stable.

**Phase 2 — furniture on.** 3–4 pieces. Identical harness, same seeds, same rooms. Compare
opening pass-rate to Phase 1.

- Holds within noise → furniture is free. Proceed.
- Drops → **check §6.1 occlusion logs before touching the prompt.** Nearly always a
  `visible_fraction` violation that slipped the gate, not a prompt problem.

**Phase 3 — sweep count.** 3/4/5 pieces. Run production one step below where opening accuracy
starts to degrade.

If Phase 2 regresses and occlusion is clean, fall back to Phase 1. You lose furniture control,
not door and window accuracy.

---

## 11. File-by-file changes

| File | Change |
|---|---|
| `prompt-builder.ts` | Rewrite against §2. Delete `:86-88`, `:167-173`, `:196`. Delete `describeFurnitureForPrompt` + `describeFurniturePosition`. Add 1800-char assert |
| `build-scene.ts` | New colour constants §3.1; window filler → `MeshBasicMaterial`; light intensities §3.6 |
| `camera.ts` | `lookAt(0, EYE_H, 0)`; `camera.near = 0.15`; keep FOV 85 and the scorer |
| `furniture-catalogue.ts` | Add `materialPhrase` + `promptPriority` to all 23 entries. **No new types** |
| `furniture-layout.ts` | Delete position→prose. Add `buildFurnitureMaterials` (§4.3) |
| `render-to-data-uri.ts` | Supersample 2752×1536 → 1376×768; renderer settings §3.5; histogram assert §3.7 |
| `ensure-greybox-key.ts` | Also render + upload Pass B mask as `{key}-mask` |
| **new** `greybox/validate-openings.ts` | §5 |
| **new** `greybox/validate-furniture.ts` | §6 |
| **new** `greybox/render-mask.ts` | §7.1 |
| **new** `validation/gate.ts` | §7.2, §7.3 |

---

## 12. Checklist

```
✅ prompt.length <= 1800, asserted, throws
✅ Geometry first, accent last — truncation eats the tail
✅ Positive phrasing only — no negativePrompt exists on pro or flex
✅ Numbers as words, singular/plural matched
✅ Ledger from the Pass B mask, never from openings.length
✅ Prompt is a pure function of (openings, furniture, brief, camera)
✅ Furniture materials derived from catalogue; empty array omits the line
✅ Zero positional prose about furniture — the render owns position
✅ Furniture darkest in frame, ≥0.15 luma clear of walls
✅ Window filler unlit
✅ Level camera, near = 0.15
✅ Render aspect === generation aspect, asserted
✅ visible_fraction >= 0.85 per opening, pre-render
✅ Openings: no overlap, 0.5ft separation, 0.75ft corner clearance
✅ Deterministic seed per (project, room, attempt)
✅ Pass B mask rendered and stored every time
✅ Phase furniture in behind the openings-only baseline

❌ promptUpsampling
❌ Multiple reference images
❌ "defect", "count them", "do not add"
❌ Colour on walls/floor/ceiling/upholstery/cabinetry
❌ New furniture catalogue types
❌ Text labels in the render, ever
❌ Auto-repairing an invalid opening
❌ Mutating the prompt between retries
❌ Changing two variables in one experiment
```