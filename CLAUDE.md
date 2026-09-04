# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start the app (http://localhost:3000). Floor-plan extraction runs synchronously in the request; no other services needed.
- `npm run build` — production build.
- `npm run start` — run a production build.
- `npm run lint` — ESLint.
- No test runner is configured in this repo.

## Architecture

There is no separate backend service. Next.js API routes under `src/app/api/*` are the backend, running server-side inside the same app.

### Floor-plan extraction

A single Gemini vision call does the whole job — no OCR/semantic/geometry/merge staged pipeline and no async job queue. Entry point: `src/app/api/parse-plan/route.ts`, which calls `runPlanExtraction` in `src/lib/pipeline/extract-plan.ts`; that in turn calls `extractFloorPlan` in `src/lib/ai/provider.ts` (the only function in that layer allowed to make the extraction call), passing the uploaded image plus the active project category's room-type hints. Gemini returns room names (verbatim), types, printed dimensions where legible, and door/window presence with side + connection, constrained by a response schema; `extract-plan.ts` maps that onto the existing `FloorPlan`/`Room` shape and assigns each room a cosmetic grid position (`PlanThumb`/`project-card.tsx` still render `room.x`/`y`). Without `GEMINI_API_KEY`, extraction fails outright (surfaced to the frontend as `readable: false`, routing to manual entry) rather than falling back to a heuristic — there's no local/offline detection path in the live app. PDFs are rejected outright with an error (`/api/parse-plan/route.ts`) — export to PNG/JPG first.

There is no staged pipeline, no async job queue and no Python/OpenCV geometry step — extraction is the one Gemini vision call described above. Earlier designs that had those are gone from the tree; consult git history if you need them.

### Rendering pipeline — rebuilt, Workstream 8.5 (2026-07-26)

The old 3D furniture-placement studio and its multi-view/orbit-video render pipeline were **destroyed**, not deprecated — see `docs/VASTOS_REVAMP_PLAN.md`'s "What's kept vs. what's destroyed" for the full list. `render/flux-client.ts` (fal.ai), `render/verify.ts` (furniture-presence checker), `render/annotate.ts`, `render/prompt.ts`, `render/video-jobs.ts`, `render-client.ts`, `scene-3d.tsx`, `panorama-360.tsx`, `room-walkthrough.tsx`, `opening-editor.tsx`, `detect-room-client.ts`, `suggest-furniture-client.ts`, the `/api/detect-room` and `/api/suggest-furniture` routes, and the entire `PlacedItem`/furniture-catalog UI are gone.

What's live now, all driven by the Universal JSON Architecture (see "AI prompting pipeline" below):
- `src/lib/render/gemini-image.ts` — Gemini/Nano Banana image edits (direct Google path).
- `src/lib/render/runware-client.ts` — Runware routing for image generation, editing and enhance (see "Model routing" below).
- `src/lib/render/veo-client.ts` — Veo image-to-video, used by `/api/generate-walkthrough`: one 3-second cinematic-zoom-in clip per approved room image (Veo's minimum is 4s — each clip is generated at 4s and trimmed to exactly 3s via `ffmpeg.ts`'s `trimVideo`), concatenated in order.
- `src/lib/render/ffmpeg.ts` — `concatVideos`, `trimVideo`; `assembleSlideshow`/`extractFramesFromVideo`/`probeDuration` are leftover from the old orbit flow, unused but harmless.
- `/api/generate-room-image`, `/api/edit-room-image`, `/api/enhance-room-image`, `/api/generate-walkthrough`, `/api/order-rooms`, `/api/design-plan`, `/api/design-reference` — small, single-purpose routes, replacing the old 859-line `/api/render` (which now only has a `GET ?key=` handler serving stored bytes back to the browser).

### Model routing

Three call families route differently — verify against `src/lib/ai/provider.ts` and `src/lib/render/runware-client.ts` before changing anything here:

- **Text/vision-to-text** (`extractFloorPlan`, `generateStructured` for design planning, design-reference analysis) always goes direct to Google AI Studio (Gemini). Not affected by the toggle below.
- **Image generation/editing/enhance** routes to Runware whenever `RUNWARE_API_KEY` is set and `IMAGE_PROVIDER` is not `"gemini"`: FLUX.2 [pro] (`RUNWARE_IMAGE_MODEL`, default `bfl:5@1`) for generation, Nano Banana Pro (`RUNWARE_EDIT_MODEL`, default `google:4@2`) for the View & Edit lasso edit, Nano Banana 2 (`RUNWARE_ENHANCE_MODEL`/`RUNWARE_FALLBACK_IMAGE_MODEL`, both default `google:4@3`) for the Approve → Enhance whole-image pass and as the Runware-side fallback tier for generation/editing. Nano Banana 2 is the same underlying model as Gemini 3.1 Flash Image. Direct Gemini image calls (`gemini-image.ts`) are the last-resort emergency tier, reached only with no `RUNWARE_API_KEY` or `IMAGE_PROVIDER=gemini`.
- **Video** follows the equivalent `VIDEO_PROVIDER` toggle: Wan 2.7 via Runware, or Veo direct.

### Data layer

Supabase (hosted Postgres + Auth + Realtime), no ORM — schema is raw SQL in `supabase/schema.sql`, applied manually via the Supabase SQL editor. Two client wrappers in `src/lib/supabase/`: `server.ts` uses the service-role key and bypasses RLS; `browser.ts` uses the publishable key and is used only for Realtime subscriptions. Both return `null` when unconfigured, and callers treat persistence as best-effort — the app works without Supabase.

Main tables (RLS-scoped by `auth.users`): `projects`, `parse_jobs` (was one row per old async pipeline run, storing OCR/semantic/geometry/merge JSON + status), `floor_plans`, `placed_items`, `scenes`, `renders`/`render_versions`, `project_snapshots` (JSONB mirror of client state — predates real auth below and hasn't been migrated onto it yet, still local-first via an anonymous browser id), `render_jobs` (durable registry for long-running Veo video jobs). Realtime is enabled on `parse_jobs`, `renders`, `render_versions`, `project_snapshots`. **Note**: `parse_jobs`, `placed_items`, `scenes`, `renders`/`render_versions`, `render_jobs` back retired/destroyed flows above (`parse_jobs` backed the old async Inngest job path, retired 2026-07-26 along with its only reader/writer `src/lib/pipeline/job-store.ts`/`src/lib/supabase/parse-jobs.ts`) — the local-first `useVasto` store (`src/lib/store.ts`) no longer reads or writes those shapes (`Project.roomCards`/`Project.walkthrough` replaced them client-side); the tables themselves are left alone pending a real migration, not touched by this pass.

### Auth

Real auth now exists (revamp Workstream 2), built on Supabase Auth rather than a custom users table — `owner_id references auth.users(id)` was already in the schema, and Supabase Auth means no hand-rolled password hashing or session crypto. Clients never self-register; accounts are admin-issued via `supabase.auth.admin.createUser`.

- `profiles` table (`supabase/schema.sql`) carries the app-specific fields Supabase Auth doesn't: `role` (`user`/`master` — just two, no admin tier), `status`, `trial_ends_at`. A trigger (`handle_new_auth_user`) auto-creates the matching row whenever a new `auth.users` row is created, reading `role` out of that call's `user_metadata` if passed.
- `src/lib/supabase/server-client.ts` — cookie-aware Supabase client (`@supabase/ssr`) for Server Components/Route Handlers/Server Actions, distinct from `server.ts` (service-role, bypasses RLS, for privileged one-off calls like `admin.createUser`) and `browser.ts` (anon key, Realtime only).
- `src/lib/auth/session.ts` — `getCurrentUser()`/`requireUser()`/`requireRole()`, the actual (non-optimistic) auth check. Verifies the JWT via `getClaims()` then loads the `profiles` row. Call this in every protected page/API route — don't rely on the proxy alone.
- `src/proxy.ts` — Next 16 renamed `middleware.ts` → `proxy.ts` (now defaults to the Node.js runtime, not Edge). This is an *optimistic* redirect-only check (session cookie present or not); it does not query the database or check role.
- `src/app/login/` — the sign-in page + `actions.ts` (`signIn`/`signOut` Server Actions). No signup route exists anywhere in the app by design.
- Bootstrapping the first account: create a user in the Supabase dashboard, then `update profiles set role = 'master' where id = '<uuid>';` — see the comment in `schema.sql`.

### API guard

`src/lib/api-guard.ts`'s `assertAllowed(request, opts)` centralizes auth + same-origin CSRF check + per-user rate limit + the admin-set `$` usage cap (opt in via `checkUsage: true`, only paid AI-generation routes) for every API route. It exists because routes used to repeat these checks inline and could be — and once were (`/api/share-link`) — left unguarded by omission. All 14 routes under `src/app/api/*` use it except `/api/dev-check` (404s outside development) and `/api/s/[token]/asset` (the public share-asset proxy, scoped instead by a server-built allow-list of exactly the keys that share token's project references, plus its own rate limit). Every AI-calling route passes `checkUsage: true`.

### Console (master role)

`/console` (`src/app/console/`) is gated by `requireRole("master")` and is where staff create accounts (`console/actions.ts`, via `supabase.auth.admin.createUser` — the only account-creation path in the app; there is no signup route) and view usage/cost analytics (`/console/analytics`). No cost or usage figures are ever shown to a plain `user`.

### AI provider layer

`src/lib/ai/provider.ts` (revamp Workstream 4) is the single entry point for AI calls: `generateImage`, `editImage`, `enhanceImage`, `generateVideo`, `generateStructured`, `extractFloorPlan`. Each call retries per `src/lib/ai/errors.ts`'s policy, times itself, and writes a best-effort row to the `ai_usage_logs` table (`src/lib/ai/usage-log.ts`) with a normalized `ErrorCategory`. `pipeline/extract-plan.ts` calls `extractFloorPlan` so the live upload flow is instrumented (the old `runOCR`/`runSemantic` wrappers around `pipeline/ocr.ts`/`pipeline/semantic.ts` were removed 2026-07-26 along with those two files — nothing called them once the old staged pipeline was retired). `editImage`/`enhanceImage`/`generateVideo` delegate to `render/gemini-image.ts`/`render/veo-client.ts` (Gemini) or `render/runware-client.ts` (Runware), per the `IMAGE_PROVIDER`/`VIDEO_PROVIDER` toggle and the model routing described above — see "Env vars" below, this is a temporary testing config, not a rewrite of this layer. `render/flux-client.ts` (fal.ai/FLUX) is fully removed as of Workstream 8.5 — it was kept only as the old 3D-studio render path's fallback, and that path no longer exists (not to be confused with `render/runware-client.ts`'s FLUX.2/FLUX Fill models, an unrelated newer addition).

`enhanceImage` backs `POST /api/enhance-room-image`, reached from Approve — a one-shot whole-image enhance of an approved room photo (not a masked/cropped edit like `/api/edit-room-image`): material/lighting quality is raised and finishing details (rug, cushions, art, plants) are filled in, while camera, proportions, wall/opening positions, wall colour and every existing furniture piece are held pixel-identical by the prompt itself (`provider.ts`'s `buildEnhancePrompt`).

### AI prompting pipeline — live end-to-end as of Workstream 8.5

`src/lib/ai/prompting/` (revamp Workstream 5) implements the Universal JSON Architecture: `build-universal-input.ts` (validates frontend selections into a `UniversalInput`), `design-planning.ts` (`runDesignPlanning` — one Gemini call, via `provider.generateStructured`, into a `DesignSpecification` with per-room guidance — **this is the live design-planning path, called directly by `/api/design-plan`**), `prompt-builder.ts` (`buildRoomPrompt` — deterministic, no AI call, the only place natural-language prompt text is produced). Template wording (`system`/`planning`/`builder`) lives in the `prompt_templates` table, versioned and `published`-gated; `templates.ts` falls back to hardcoded defaults when unconfigured.

**`design-spec-tables.ts` is not wired up.** `src/lib/ai/prompting/design-spec-tables.ts` (`buildDesignSpec`) is a deterministic, table-driven alternative to `runDesignPlanning` — same output shape, no LLM call. Nothing in `/api/design-plan/route.ts` or any live page calls it; it's exercised only from `/api/dev-check`. Don't write code that assumes it runs in production, and don't assume it's dead either — check for it before deleting.

`src/app/api/design-reference/route.ts` backs the Design page's "Upload design reference": a photo of a look the user wants, analysed once (`analyseDesignReference`) into the same six design-look attributes the planning call otherwise infers, cached on the project (`Project.designReference`) and sent alongside the design plan. The uploaded bytes are never persisted to object storage — only a small downscaled preview lives on the local-first project.

The full flow, in order: `/projects/[id]/floor-plan` (Yes/No) → `upload` (detection: one panel showing the image + wall/door/window/room overlay + layer toggles + stats — detected rooms land on the plan directly, no per-room confirmation step here) → `plan` (Plan Editor: draw/adjust each room rectangle and drag its doors and windows onto the walls — this is where the geometry the greybox renders actually comes from; stamps `planConfirmedAt`, which is what the stepper reads) → `review` (Room Confirmation: rename, type, size, door/window counts, unit selector, delete room, and a manual "Add room" form — name/type/width/height — for anything detection missed) → `furnish` (Furnish gallery, one card per room: renders + caches each room's greybox reference image, then routes into a per-room 3D editor to place furniture — skippable per room, generates fine from an openings-only greybox) → `design` (style/luxury/colour, optional design-reference upload, + one global Additional Requirements box) → `POST /api/design-plan` (`buildUniversalInput` + `runDesignPlanning`, cached on the project via `setDesignPlan`) → `generate` (Room Generation Gallery: `POST /api/generate-room-image`, `buildRoomPrompt` + `provider.generateImage`, one horizontally-scrollable strip of generations per room, oldest→newest, Generate More with its own per-call note) → `generate/[roomId]` (View & Edit: up to 2 numbered lasso regions, `POST /api/edit-room-image`) → `approve` (Final Image Selection, plus `POST /api/enhance-room-image` for a one-shot whole-image enhance) → `walkthrough` (`POST /api/generate-walkthrough`, one 3-second clip per approved image, concatenated). `/api/export-pdf` and `/api/share-link` hang off the finished project. Everything is cached on the local-first `useVasto` project (`universalInput`, `designSpec`, `roomCards`, `walkthrough`) — not yet the real `projects.manifest` row (see the state-machine note below), same situation as before Workstream 8.5.

For the prompt-construction rules behind `prompt-builder.ts` and `design-planning.ts` (FLUX's 1,800-char cliff, JSON-vs-prose model handling, negative-instruction avoidance, etc.), see `docs/PROMPTING-RULES.md` — a portable rulebook extracted from this pipeline. Don't restate its content here; point at it.

`src/lib/greybox/` is the greybox reference-image pipeline that feeds both Furnish and Generate: for each room it builds a plain 3D box (walls/floor/ceiling/openings, plus any placed furniture) from a **locked, deterministic camera** (`camera.ts`'s `greyboxCamera` — the same room spec and aspect always pick the same viewpoint, so a regenerated image never silently changes angle), rendered client-side via WebGL (`render-to-data-uri.ts`/`render-mask.ts`) into two PNGs at a fixed aspect (`dimensions.ts`'s `GREYBOX_RENDER_W`/`GREYBOX_RENDER_H`, 1376×768, asserted equal to the generation aspect so FLUX never letterboxes or crops): a photoreal-ish Pass A conditioning image and a flat-colour Pass B **opening mask**, from which the server re-derives the door/window ledger itself (`count-openings.ts`) rather than trusting a client-sent count. `ensure-greybox-key.ts`'s `ensureGreybox` is the single entry point every page calls — hash-gated (`greybox-hash.ts`) so it only re-renders when a room's geometry actually changed. **The room is built `GREYBOX_ROOM_SCALE` (1.3) times its true size** — applied in `room-spec.ts`'s `roomSpecFor`, the one funnel every caller uses, so it can never be applied twice. `roomSpecFor`'s `width`/`depth` are therefore greybox world units, not a size to show a user or put in a prompt. See `greybox/room-scale.ts` for the measurements: a 10×12 ft room gave a wardrobe **0.0 sq ft** of legal positions once a bed was placed, because the camera's fixed 2.6 ft clearance disk ate 46% of the floor; at 1.3× that becomes 30.9 sq ft. It needs no data migration because `PlacedOpening.t` and `PlacedFurniture.x`/`.z` are fractions of the room, and it changes no angle because the camera's standoff is a fraction too — but it DOES require a `GREYBOX_RENDER_VERSION` bump, since the hash is built from the room's true size and would otherwise keep every stale unscaled image while the server rebuilt a scaled camera to describe it. `prompt-builder.ts` assembles the final FLUX.2 prompt against a hard **1,800-character budget**, trimming a fixed priority ladder (openings > wall layout > camera > furniture) rather than ever truncating mid-phrase. `/api/dev-check` is this repo's stand-in for a test suite (no test runner is configured) — most of the greybox math (hashing, projection, opening counting/validation, camera determinism, the prompt budget/clamp logic) is covered there instead.

**Opening violations warn, they do not block** (changed 2026-08-10). `validate-openings.ts` still fails closed in the sense that matters — it never auto-repairs, and an opening is never moved to make a render succeed — but its violations no longer gate the UI. The Furnish editor used to refuse to open such a room entirely; Section 5's thresholds are tuned for deliberately-placed geometry and Gemini-derived openings trip them often enough that blocking made a large share of real plans unfurnishable. The editor now renders a dismissible warning banner and lets the user furnish and generate anyway, and the gallery card's badge is advisory ("Check openings", warning colour) rather than a gate. Note what this warning actually means: the violation never reaches the image model, and it does not cause hallucination — it means the *greybox itself* renders geometry that reads as a missing wall, which the model then faithfully reproduces.

**The opening legend is gated on the ledger** (changed 2026-08-25). The sentences defining how to read the greybox — "A framed recessed panel is a closed door", "A bright panel is a window" — and the clearance order in `furnishFullyFor` each name only the kinds the ledger actually contains. All were unconditional before, so a door-only room still told the model what a window looks like (an invitation to read any bright patch as one) and a room with no openings defined both and then denied both. One shared helper feeds the FLUX prose and the Gemini JSON so neither flow can define an opening the other does not. `/api/dev-check` exposes a `legendPreview` field with all four door/window combinations.

**Room types are alias-normalised before catalogue lookup.** `furnitureForRoomType` matches `roomTypes` exactly (case-insensitive), which silently gave a room typed "Hall" — common on Indian plans — only the rug/plant/side-table fallback, with no sofa and no coffee table. `ROOM_TYPE_ALIASES` in `furniture-catalogue.ts` maps common labels onto canonical ones first. It is an explicit table, not fuzzy or substring matching, because substring matching would make "Store Room" match "Room" and drag furniture into rooms that must stay empty. Aliases also route toilet/washroom/WC into `NO_FURNITURE_ROOM_TYPES`. `/api/dev-check` asserts the aliases resolve, that unknown free-text types still reach the fallback, and that every entry's `build()` produces a real, floor-seated mesh matching its declared `footprintFt` — that last one is the general guard against "this item doesn't show up in the 3D scene".

**Furniture seeding is camera-aware.** `first-free-slot.ts`'s `defaultArrangementFor` seeds a new room's starting arrangement through the same `resolvePlacement` + `isInFrame` gate the editor's Add button uses, picking spread-apart slots greedily. It replaced `furniture-layout.ts`'s `defaultFurnitureFor`, which placed pieces at a hardcoded `z: 0.18` with neither check and so routinely seeded furniture outside the locked camera's frustum and overlapping in small rooms. Both failure modes are asserted in `/api/dev-check`.

**The camera is selectable per room** (added 2026-08-10). `Room.cameraView` (`GreyboxCameraView` — `"auto"` or a wall) picks the viewpoint; it rides on `GreyboxRoomSpec` so the Pass A render, the Pass B mask, `projectOpenings`, the furniture exclusion zone and `isInFrame` all derive the same camera from the one object they already share. `"auto"` (the default, and what an absent field means) is the original 8-candidate best-coverage scorer, unchanged. A wall value names the wall the camera **stands against**, so it shows the other three — the wall behind an 85° camera aimed at the room's centre can never be in shot, which means a room with openings on all four walls always loses at least one whatever is chosen. `cameraCoverage()` reports what each option would see so the picker can show the tradeoff up front. Two things this must keep doing: the candidate order in `greyboxCamera` (north, south, **west**, east, then corners) is load-bearing because ties break by it, and the hash **omits** the key when the view is auto so shipping the field re-rendered nobody's cached greybox. Switching view can push existing furniture out of frame or into the exclusion disk; the editor detects that, lists the affected pieces, and offers a "Bring into view" button. Nothing moves on its own.

**Furnish editor drag rules.** Room bounds are enforced LIVE, by clamping the drag target to the item's rotated footprint (`clampToRoom` in `furniture-editor-canvas.tsx`) — furniture can never leave the room. Overlap and the camera exclusion disk stay advisory during the gesture (a red tint) and are resolved once on pointerup. The split is deliberate: a clamp is continuous, so it holds the piece against the wall without flicker, whereas feeding `resolvePlacement`'s four-candidate fallback into the mesh every frame makes the winning candidate flip near a boundary, which is the original "glitchy drag". Selection is a green emissive tint and outranks the amber blocker tint. Every transient warning panel is absolutely positioned INSIDE the canvas box; they used to be flex siblings, so one appearing resized the aspect-locked viewport and made it visibly jump.

**The furnish editor is one route with two modes.** `furnish/[roomId]` offers Save only when reached from the Furnish gallery, and Save plus Generate when reached from the Generate gallery's "Adjust with 3D" (`?from=generate`). That one query param drives the Generate button, the back link, Save's destination, and which stepper pill `workspace-frame.tsx` highlights, so they cannot disagree.

**Upload page has no lasso tool** (removed 2026-07-26) — `lasso-select.tsx` (freehand-on-the-upload-image drawing) and `lasso-extract.ts` (its `pxToFtTransform` helper, orphaned once `pipeline.ts` was retired in the same pass) are both deleted. The View & Edit screen's lasso (`lasso-canvas.tsx`, numbered mask regions on a *generated* room image) is a separate, still-live component — don't confuse the two.

### Config-driven project types, detection toggle, room openings

`config/project-types/*.json` (Workstream 6) — one file per category, loaded by `src/lib/project-types/config.ts`, and passed into `extractFloorPlan` as room-type hints. Room types are config-driven, not a hardcoded enum — `apartment.json` and `residential.json` both include Portico and Parking (outdoor/semi-outdoor types common on Indian plans). Catalogue footprints are Indian-typical rather than Western (bed 5.0 ft not 6.3, wardrobe 4 ft not 5) — a 6.3 ft king was 63% of a 10 ft wall on its own. `greybox/furniture-catalogue.ts` gives Portico/Parking/Garage their own catalogue entry (a single parked car, `promptPriority: 100` — same tier as a bed or sofa) rather than falling through to the generic rug/plant/side-table fallback; a comment there notes Garage was deliberately dropped from `NO_FURNITURE_ROOM_TYPES` for the same reason. `src/lib/pipeline/assign-openings.ts` (Workstream 7a) used to deterministically assign each detected door/window to the room(s) it borders via pixel geometry; that algorithm was retired 2026-07-26 — the new extraction pipeline gets door/window side + connection directly from Gemini instead, and only the file's `OpeningSide`/`RoomOpening` types remain, still consumed by `ai/prompting/prompt-builder.ts` to turn `Room.openings` into a natural-language clause.

### Profile page

`/profile` (`src/app/profile/page.tsx`) shows account info (from `getCurrentUser()`) and a project list/count via `src/components/profile-projects.tsx`, which reads the same local-first `useVasto` store `/projects` uses — not the `projects` table, which isn't wired into any live page yet (see below). No cost figures are shown to a client; that stays admin-only.

### Project lifecycle state machine

`projects.status` (11-value enum, `supabase/schema.sql`) plus `projects.manifest` (JSONB) exist as columns and are **read and written by nothing**. The TypeScript transition helper that once accompanied them was deleted as dead code; the columns are left alone because the table may hold rows.

Persistence is entirely local-first: every page's state is mirrored to `project_snapshots` (a JSONB blob keyed by the authenticated user's id) via `/api/projects`, and that is the row every other feature resolves against — share links, PDF export and storage-key ownership checks all read it. Moving onto the normalized `projects` table is future work, not a bug.

### Gemini model selection

`src/lib/ai/gemini-models.ts` pins a model per call purpose — sibling of
`model-labels.ts`, which does the same for image/video. `extraction` and
`planning` run `gemini-3.5-flash-lite`; `geometry` runs `gemini-3.5-flash`,
deliberately stronger because it returns bounding boxes that feed the greybox
and therefore every render. Override with `GEMINI_EXTRACTION_MODEL` /
`GEMINI_PLANNING_MODEL` / `GEMINI_GEOMETRY_MODEL`; the legacy `GEMINI_MODEL`
still wins over all three and flattens them back onto one model.

Two invariants, both asserted in `/api/dev-check`:

- **No `-latest` alias, anywhere.** Google repoints aliases without notice and
  they bill at whatever they resolve to. `gemini-flash-latest` was the default
  primary for all three calls and, tested live on this project's key
  (2026-08-24), returns **429 — no quota**; every call was already spending a
  round-trip to be refused before falling through to `gemini-3.5-flash`.
- **Ladders are cost-capped**: no fallback may cost more per output token than
  the primary (`geminiFallbacksFor` filters against the RESOLVED primary, so
  an env override cannot reintroduce an expensive tier). Otherwise a cheap
  primary makes every failure dearer than the success it replaced.

Only models with a published price are eligible, and availability is
per-account: `gemini-2.5-flash` (which was in the old fallback list) and
`gemini-2.5-flash-lite` both 404 as "no longer available to new users", and
`gemini-3.7-flash` 429s. Re-test with a real key before adding a model —
being on the pricing page does not mean the key can call it.

### Request budgets and quota

Two failure modes that used to reach users as a timeout or as silence:

- **Every `generateJson` call is bounded by a wall clock.** `gemini-client.ts`
  owns a per-call deadline (`DEFAULT_DEADLINE_MS`, 45s default; routes may
  pass a tighter or looser `deadlineMs`), a per-attempt abort sized as a share
  of what is left (`attemptCapMs`), and backoffs clamped to the remaining time
  (`retryBackoffMs`). Without it the model ladder — 5 attempts on the primary
  plus 2 on each of three fallbacks — was unbounded, and one spell of
  `fetch failed` overran the route's `maxDuration`, which the platform
  returned as a 504. Note that `toErrorResponse` cannot emit 504 at all, so a
  504 is always the gateway. `parse-plan` runs TWO calls sharing one budget
  (split 65/35, geometry skipped outright if nothing is left) and declares
  `maxDuration = 120`; `design-plan` passes an explicit 100s budget.
- **`QuotaError`** (`ai/errors.ts`) marks a spent provider balance or daily
  quota. Not retryable, preferred by `runChain` over a later tier's error, and
  the only non-validation category whose message reaches the browser verbatim
  — the fixed `QUOTA_MESSAGE`, never upstream text. Detection is
  `looksLikeQuotaExhaustion`, matched on text because Runware reports it in a
  task-level error on an HTTP 200 and Google as `RESOURCE_EXHAUSTED` in a 429.
  It deliberately excludes rate limits, which must stay retryable.

Client-side, in-flight and failed state for a room lives in `store.ts`
(`generatingRoomIds`, `roomOps`, `roomErrors`) rather than in a page's
`useState`, so it survives soft navigation. `roomOps`/`generatingRoomIds`
reset on rehydrate; `roomErrors` does not.

### Dependency constraint: exactly one sharp

`package.json`'s `sharp` MUST satisfy the range Next declares in its own
`optionalDependencies` (`node -p "require('next/package.json').optionalDependencies.sharp"`).
Miss it and npm installs a second copy under `next/node_modules` with its own
native libvips, which yields either a `GLib-GObject-CRITICAL ... VipsInterpretation`
warning on every sharp call or, on Vercel, `ERR_DLOPEN_FAILED` on the first
request that touches sharp — with a green build either way. `npm ls sharp`
must show exactly one non-deduped entry; `/api/dev-check` asserts it. See the
comment in `next.config.ts` for the full history.

### Env vars

`.env.example` documents every variable below (`.env*` is otherwise gitignored). Everything is optional and the app degrades gracefully without it:

- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_VIDEO_MODEL` — floor-plan extraction, design planning, design-reference analysis (always Gemini), plus the Gemini-direct fallback tier for image edits/enhance/video
- `RUNWARE_API_KEY`, `IMAGE_PROVIDER`, `VIDEO_PROVIDER`, `RUNWARE_IMAGE_MODEL`, `RUNWARE_EDIT_MODEL`, `RUNWARE_VIDEO_MODEL`, `RUNWARE_ENHANCE_MODEL`, `RUNWARE_FALLBACK_IMAGE_MODEL`, `RUNWARE_IMAGE_RESOLUTION` — **temporary testing provider (2026-07-27)**. `provider.ts`'s `generateImage`/`editImage`/`enhanceImage`/`generateVideo` route to Runware whenever `RUNWARE_API_KEY` is set AND the matching `IMAGE_PROVIDER`/`VIDEO_PROVIDER` isn't explicitly set to `"gemini"` — see "Model routing" above for which model each call uses and the 3-tier fallback chain (primary Runware model → `RUNWARE_FALLBACK_IMAGE_MODEL` → direct Gemini). **The Gemini code paths are untouched and still the default the moment `RUNWARE_API_KEY` is unset** — to go back to Gemini permanently, either blank out `RUNWARE_API_KEY` or set `IMAGE_PROVIDER=gemini`/`VIDEO_PROVIDER=gemini`. `extractFloorPlan` and `generateStructured` (Design Planning) are NOT affected by this toggle — always Gemini. `RUNWARE_IMAGE_RESOLUTION` (`sd`/`hd`, default `sd`) is a cost/quality tier, not a provider switch.
- `DEBUG_PROMPTS=1` — logs every prompt this app sends to an AI provider to the server console, with its reference image(s) and target model/fallback chain (`src/lib/ai/debug-log.ts`). A testing aid, not meant to run in production.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` — Cloudflare R2 upload storage, preferred over plain S3 below (zero egress fees, no per-unit tiers). S3-API-compatible, same `@aws-sdk/client-s3` code path, different endpoint/creds. Takes priority over S3 when both are set.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` — real S3 upload storage; local disk storage is used automatically when these and the R2 vars above are all unset
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — persistence (run `supabase/schema.sql` first)
