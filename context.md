# Vastos — onboarding context

Vastos turns a 2D floor plan into photorealistic AI interior renders and a
short walkthrough video. It is a licensed product: accounts are admin-issued
only (`supabase.auth.admin.createUser`, from `src/app/console/actions.ts`,
behind `requireRole("master")`) — there is no signup route anywhere in the
app, by design. Two roles exist: `user` (a customer/builder working
projects) and `master` (staff, with access to `/console` — user management
and usage/cost analytics, never shown to a `user`).

This file explains what the app is and where things live. For the deep
architecture writeup (subsystem internals, past-tense workstream history,
retired code) see `CLAUDE.md`. For prompt-construction rules, see
`docs/PROMPTING-RULES.md`. For the product plan and build status, see
`docs/VASTOS_REVAMP_PLAN.md`.

## Backend

There is no separate backend service. Next.js API routes under `src/app/api/*`
run server-side inside the same app (`npm run dev` is the whole stack).
Floor-plan extraction and image/video generation run synchronously inside
the request — no job queue.

## The user flow

One route per step, all under `/projects/[id]/`:

| Step | Route | What happens |
| --- | --- | --- |
| 1 | `/floor-plan` | Yes/No — do you have a floor plan image to upload |
| 2 | `/upload` | Upload the plan; one Gemini vision call detects rooms, walls, doors/windows; shown as an overlay with layer toggles |
| 3 | `/plan` | Plan Editor — draw/adjust each room rectangle and drag its doors and windows onto the walls. This is where the geometry the greybox renders actually comes from; `planConfirmedAt` is stamped here |
| 4 | `/review` | Room Confirmation — rename, retype, resize, edit door/window counts, delete rooms, or add rooms manually (detection misses land here) |
| 5 | `/furnish` | Furnish gallery, one card per room. Renders a "greybox" 3D reference image per room and lets you optionally place furniture in a per-room 3D editor (`/furnish/[roomId]`). Skippable per room — generation works fine from an openings-only greybox |
| 6 | `/design` | Pick style/luxury/colour, optionally upload a design-reference photo (`POST /api/design-reference`) whose look gets folded into planning, and write one global "Additional Requirements" note |
| 7 | (server) | `POST /api/design-plan` — one Gemini structured-output call produces per-room design guidance, cached on the project |
| 8 | `/generate` | Room Generation Gallery — `POST /api/generate-room-image` per room, horizontally-scrollable strip of generations, oldest→newest, "Generate More" with its own note |
| 9 | `/generate/[roomId]` | View & Edit — up to 2 numbered lasso regions, `POST /api/edit-room-image` |
| 10 | `/approve` | Final Image Selection per room; from here, `POST /api/enhance-room-image` can do a one-shot whole-image quality/finishing pass on an approved photo |
| 11 | `/walkthrough` | `POST /api/generate-walkthrough` — one ~3s cinematic clip per approved room image, concatenated |
| — | `/api/export-pdf`, `/api/share-link` | Export the finished project to PDF; mint an unauthenticated share link (`/s/[token]`) for a client to view the walkthrough |

## Subsystems and their entry points

| Subsystem | Entry point | Purpose |
| --- | --- | --- |
| Floor-plan extraction | `src/app/api/parse-plan/route.ts` → `src/lib/pipeline/extract-plan.ts` → `extractFloorPlan` in `src/lib/ai/provider.ts` | Single Gemini vision call: rooms, types, dimensions, openings. No OCR/heuristic fallback — fails outright without `GEMINI_API_KEY`, routing the frontend to manual entry |
| AI provider layer | `src/lib/ai/provider.ts` | Single entry point for every AI call (`generateImage`, `editImage`, `enhanceImage`, `generateVideo`, `generateStructured`, `extractFloorPlan`). Retries, times, and logs every call to `ai_usage_logs` |
| AI prompting pipeline | `src/lib/ai/prompting/` | `build-universal-input.ts` (validate frontend selections) → `design-planning.ts`'s `runDesignPlanning` (one Gemini structured-output call, the **live** design-planning path) → `prompt-builder.ts`'s `buildRoomPrompt` (deterministic, no AI call — the only place prompt text is assembled) |
| Greybox reference-image pipeline | `src/lib/greybox/` | Builds a plain 3D box (walls/floor/ceiling/openings/furniture) from a locked, deterministic camera, rendered client-side via WebGL into a conditioning image and an opening mask. Feeds both Furnish and Generate |
| Rendering (image/video) | `src/lib/render/` | `gemini-image.ts` (Gemini/Nano Banana), `veo-client.ts` (Veo video), `runware-client.ts` (Runware — FLUX.2, Nano Banana Pro/2), `ffmpeg.ts` (clip trim/concat) |
| Data layer | `src/lib/supabase/` | `server.ts` (service-role, bypasses RLS), `server-client.ts` (cookie-aware, per-request), `browser.ts` (anon key, Realtime only). Supabase is optional everywhere — the app works, degraded, without it |
| Auth | `src/lib/auth/session.ts`, `src/proxy.ts` | `getCurrentUser`/`requireUser`/`requireRole` is the real (non-optimistic) check — call it in every protected page/route. `proxy.ts` is only a cookie-presence redirect, not a security boundary |
| API guard | `src/lib/api-guard.ts` | `assertAllowed` centralizes auth + CSRF (same-origin) + per-user rate limit + admin-set spend cap (`checkUsage: true`) for every route that needs it. All 15 routes under `src/app/api/*` use it except `/api/dev-check` (404s outside development) and the public share-asset proxy, which is scoped by its own token allow-list instead |

## How to run it

```bash
npm install
cp .env.example .env.local   # everything is optional; fill in what you need
npm run dev                  # http://localhost:3000
```

`npm run build` / `npm run start` for a production build. `npm run lint`
runs ESLint — see `AGENTS.md` for which rules are hard errors here.

## How to verify a change

`/api/dev-check` (GET, dev-only) is this repo's stand-in for a test suite —
no test runner is configured. It exercises the greybox math (hashing,
camera-projection determinism, opening counting/validation), the prompt
budget/clamp logic, room-type alias resolution, and furniture-catalogue
mesh generation. Run it after touching prompt text, greybox geometry, or the
furniture catalogue; a failing route means a check failed, not a network
error.

It now also covers the Gemini request budget, the quota classifier, and a
guard that there is exactly one `sharp` install (see the two rules on those
below). As of 2026-09-12 it reports **218 passed / 0 failed**. Treat any drop
in that number as a regression, not as flakiness — every check is a pure
function or a filesystem read, and none of them touch the network or spend
money.

## Non-obvious rules a newcomer will otherwise break

These are enforced in code, not just convention — see `docs/PROMPTING-RULES.md`
for the full rulebook behind the first two:

- **FLUX.2's prompt budget is a hard 1,800-character ceiling that throws, not
  truncates.** `prompt-builder.ts`'s `buildRoomPrompt` trims a fixed priority
  ladder (openings > wall layout > camera > furniture) and throws rather than
  ever silently overflowing — FLUX's encoder truncates silently otherwise,
  which once dropped the entire room-geometry clause from every generated
  image for weeks without an error anywhere.
- **The greybox camera is locked and deterministic.** The same room spec and
  aspect ratio always pick the same viewpoint (`greybox/camera.ts`), so a
  regenerated image never silently changes angle. Candidate order is
  load-bearing (ties break by it) — don't reorder it casually.
- **The opening mask is the single source of spatial truth**, not any
  client-sent count. The server re-derives its own door/window ledger from
  the rendered Pass B mask (`greybox/count-openings.ts`) every time, so a
  stale or tampered client value can never reach a prompt.
- **Room bounds clamp, they don't ask.** The furniture editor clamps a drag
  target continuously to the room (`clampToRoom` in
  `furniture-editor-canvas.tsx`); overlap/exclusion-zone checks stay
  advisory during the gesture and resolve once on release. Feeding the full
  placement-resolution fallback into every frame is what caused the
  original "glitchy drag" — don't reintroduce it.
- **Room-type text is normalised through an explicit alias table, never
  fuzzy-matched.** `ROOM_TYPE_ALIASES` in `greybox/furniture-catalogue.ts`
  maps free-text labels (e.g. "Hall") onto canonical types before catalogue
  lookup. It's an explicit table specifically because substring matching
  would make "Store Room" match "Room" and furnish a room that must stay
  empty.
- **Every Gemini call is bounded by a wall clock, and nothing may make one
  without a budget.** The model ladder (5 attempts on the primary, then two
  each on three fallbacks) has no natural end: one spell of `fetch failed`
  once cost 11 requests and about 20 seconds of pure backoff PER CALL, twice
  per extraction, which blew past the route's `maxDuration` and came back to
  the browser as a gateway 504 while the server carried on retrying a request
  nobody was waiting for. `gemini-client.ts` now owns a per-call deadline
  (`DEFAULT_DEADLINE_MS`), a per-attempt abort sized as a share of what is
  left, and backoffs clamped to the remaining time. Running out of budget
  produces a graceful "not readable" result, never a 504. The budget lives in
  the client rather than being passed in per route deliberately — there are
  six call sites across four routes, and bounded-by-construction beats
  bounded-by-convention.
- **The greybox renders a room LARGER than it really is, on purpose.**
  `roomSpecFor` multiplies width and depth by `GREYBOX_ROOM_SCALE` (1.3), so
  the width it returns is greybox world units, NOT a size to show a user or
  put in a prompt — read `room.width`/`room.height` for those. The reason is
  measured: the camera stands inside the room and furniture must clear a fixed
  2.6 ft disk around it, which in a 10x12 ft room (the commonest Indian plan
  shape) blocked 46% of the floor. A wardrobe had **0.0 sq ft** of legal
  positions once a bed was placed — literally zero, which is why the editor
  refused a second piece. Scaling works because the disk is a fixed world size
  and so covers proportionally less of a bigger room: 0.0 -> 30.9 sq ft.
  Nothing else had to move, because `PlacedOpening.t` and
  `PlacedFurniture.x`/`.z` are all stored as FRACTIONS of the room and scale
  with it for free; if either ever becomes absolute feet, this breaks. Scaling
  the room rather than shrinking the furniture is deliberate — matching 1.3x
  by shrinking would need a 3.85 ft "queen" bed, and FLUX reproduces
  undersized furniture faithfully. Ceiling height is deliberately NOT scaled.
- **Prompt text never names an opening kind the room does not have.** The
  sentences that tell the model how to read the greybox ("A framed recessed
  panel is a closed door", "A bright panel is a window") and the clearance
  order at the end are each gated on the ledger. Both used to be
  unconditional, so a room with a door and no window still told the model what
  a window looks like — an invitation to read any bright patch in the render
  as one — and a room with no openings defined both and then said neither
  existed. `/api/dev-check`'s `legendPreview` field prints the contract for
  all four door/window combinations so this stays reviewable without building
  a room that has none.
- **There must be exactly one `sharp` install.** Next declares `sharp` in its
  own `optionalDependencies`; the moment `package.json` stops satisfying that
  range, npm installs a second copy under `next/node_modules` with its own
  native libvips. Two libvips in one process produce either a
  `GLib-GObject-CRITICAL ... VipsInterpretation` warning on every call, or on
  Vercel an outright `ERR_DLOPEN_FAILED` on the first request that touches
  sharp — with a perfectly green build either way. Both have happened here.
  After ANY `next` upgrade, run `npm ls sharp` and confirm one non-deduped
  entry; `/api/dev-check` asserts it too.
- **Prompt template wording is data, not code** — it lives in the
  `prompt_templates` table (versioned, `published`-gated), with hardcoded
  fallbacks in `templates.ts` only for when Supabase is unconfigured. Don't
  casually reword prompt strings inline; they are load-bearing for what the
  image model actually receives.
- **Opening-geometry violations warn, they never block.** The Furnish editor
  shows a dismissible warning banner and an advisory gallery badge instead of
  refusing to open a room — real Gemini-derived plans trip the strict
  thresholds often enough that blocking made too many real plans
  unfurnishable. The violation never reaches the image model; it means the
  greybox itself renders geometry that reads as a missing wall.

## Model routing

Three call families, routed differently:

- **Text/vision-to-text** (floor-plan extraction, opening geometry, design
  planning, design-reference analysis) always goes direct to Google AI Studio.
  Never affected by the Runware toggle below.
- **Image generation/editing/enhance** goes to Runware whenever
  `RUNWARE_API_KEY` is set and `IMAGE_PROVIDER` is not `"gemini"`: FLUX.2
  [pro] (`bfl:5@1`) for generation, Nano Banana Pro (`google:4@2`) for the
  View & Edit lasso, Nano Banana 2 (`google:4@3`) for Enhance and as the
  Runware-side fallback. Nano Banana 2 is the same underlying model as Gemini
  3.1 Flash Image. With no `RUNWARE_API_KEY`, everything falls back to direct
  Gemini image calls — the emergency tier.
- **Video** follows the equivalent `VIDEO_PROVIDER` toggle: Wan 2.7 via
  Runware, or Veo direct.

Which Gemini model serves which call is pinned per purpose in
`src/lib/ai/gemini-models.ts`, overridable per call by
`GEMINI_EXTRACTION_MODEL` / `GEMINI_PLANNING_MODEL` / `GEMINI_GEOMETRY_MODEL`:

| Call | Model |
| --- | --- |
| extraction, design planning, reference read | `gemini-3.5-flash-lite` |
| opening geometry | `gemini-3.5-flash` — deliberately stronger |

Geometry keeps the strong model on purpose: it returns bounding boxes, spatial
precision is the first thing to go on a cheap model, and its output feeds the
greybox and therefore every render — a regression there damages images
silently instead of failing loudly.

Two rules hold the model tables together, both asserted in `/api/dev-check`:

- **No `-latest` alias, ever.** Google repoints aliases without notice and
  they bill at whatever they currently resolve to, so a call's price and
  behaviour can change under a deploy that changed nothing.
- **Ladders are cost-capped.** No fallback may cost more per output token than
  the primary it backs up — otherwise a cheap primary makes every *failure*
  dearer than the success it replaced.

**Availability is per-account, and this one is already constrained.** Tested
live on the production key (2026-08-24), `gemini-flash-latest` and
`gemini-3.7-flash` return **429, no quota**, and `gemini-2.5-flash` and
`gemini-2.5-flash-lite` return **404, no longer available to new users**. The
first was the default primary for all three calls, so every call was spending
a round-trip being refused; the third was sitting in the fallback list as a
dead tier. The pipeline works today only because the remaining models answer.
Being listed on Google's pricing page does NOT mean a key can call it — re-test
with a real key before adding any model.

Enabling billing on the Google project is the fix, and it is a pre-launch
action, not a code change. Note that Google Cloud budgets only *alert*; the
app's own per-user cap (`profiles.usage_limit_usd`, enforced by
`assertAllowed({ checkUsage: true })`) is the only real ceiling.

Per-generation costs, token maths and the full prompt-by-prompt breakdown live
in two standalone documents, the **Vastos AI Ledger** and the **Vastos Prompt
Book** — deliberately not repeated here, because they are commercial detail
rather than what you need to work on the code.

## What the user sees when something fails

Errors are categorised (`src/lib/ai/errors.ts`), and the category — not the
message text — decides what reaches the browser. This matters because upstream
error strings routinely carry account ids, absolute server paths and provider
names, none of which is a customer's business.

| Category | Status | What the user sees |
| --- | --- | --- |
| `ValidationError` | 400 | the real message — it describes what was wrong with their own request |
| `QuotaError` | 429 | the fixed sentence `Quota limit hit. Contact Vastos Admin` |
| everything else | 502 / 500 | a generic `<context> failed`; the real detail goes to the server log only |

`QuotaError` is the newest and the one worth understanding. It means a
provider account is out of credit or a daily API quota is spent, and it is
handled specially in three places:

- It is **not retryable**. Every retry and every fallback tier bills the same
  two accounts, so retrying an empty balance only fails slower.
- `runChain` **prefers it over the last error**. Once one tier reports no
  credit the later tiers usually fail too, for their own unrelated reasons,
  and reporting only the last one threw away the single actionable diagnosis.
- The message is a **constant**, never the upstream text, so no provider name
  or account detail crosses into the browser on a failure path.

Detection is text-matching (`looksLikeQuotaExhaustion`) because neither
provider gives a stable machine-readable marker everywhere: Runware reports a
spent balance as a task-level error inside an HTTP **200**, Google as a
`RESOURCE_EXHAUSTED` status inside a 429. The matcher is deliberately narrow —
"rate limit" and "too many requests" are excluded, because a per-minute limit
clears on its own and must stay retryable. `/api/dev-check` asserts both
directions, and the negative direction is the important one.

Progress state for a room lives in the store, not in a page's `useState`
(`generatingRoomIds` for generation, `roomOps` for edit/enhance, `roomErrors`
for the last failure). A local flag disappeared the moment you navigated away,
so leaving mid-Enhance and returning made the screen look idle even though the
request was still running — the work itself was never lost, because the
completion path writes through a store action that does not care whether the
component is still mounted. `roomOps` and `generatingRoomIds` are cleared on
rehydrate (a page reload destroys both the request and the only code that
would clear the flag); `roomErrors` is deliberately kept, because a failure is
a fact about what happened, not a request still in flight.

## Known gaps and deliberate decisions

- **Two design-planning implementations exist; only one is live.**
  `runDesignPlanning` (one Gemini structured-output call) is what
  `/api/design-plan` actually calls. `src/lib/ai/prompting/design-spec-tables.ts`
  is a deterministic, table-driven alternative that is not wired into any
  route — exercised only from `/api/dev-check`. Do not assume it runs in
  production.
- **The normalized `projects` table/state machine is not wired into the live
  app.** Every page still persists through `project_snapshots` (a JSONB
  mirror of client state, local-first via the authenticated user's id). The
  `projects.status` and `projects.manifest` columns exist in the schema but
  nothing in the app reads or writes them. That wiring is future work, not a
  bug.
- **Local disk storage is a real fallback, not just a dev convenience** —
  used automatically when neither R2 nor S3 env vars are set. It does not
  persist across serverless invocations (e.g. on Vercel); set R2 or S3 vars
  before deploying anywhere without a persistent filesystem.
- **No cost/usage figures are ever shown to a `user`** — that surface exists
  only at `/console` (`master` role).
- **`DEBUG_PROMPTS=1` is currently ON in `.env.local`** (enabled 2026-08-24 at
  the owner's request, to read assembled prompts in the terminal). It prints
  every prompt the app sends, including users' free-text notes, to the server
  console, and it is read once at module load — changing it needs a dev-server
  restart. **Remove it before production.**

## Where this stands

Last verified 2026-08-25, on `main`, nothing pushed to origin:

- `tsc` clean, `npm run lint` clean, production build clean,
  `/api/dev-check` 218 passed / 0 failed.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- Next 16.3.2, sharp 0.35.3 (single install, libvips 8.18.3), Node 24 local.

Owner actions still outstanding:

1. Run `supabase/schema.sql` in the Supabase SQL editor. Until it runs, an
   older database may still carry a permissive `project_snapshots` read
   policy, which would let any holder of the publishable key — a key that
   ships in the browser bundle by design — read every user's project data.
   Read the cautions in `README.md` first; two `drop column` statements in
   that file destroy data if those columns are still populated.
2. Enable billing on the Google AI Studio project. Model pinning is done;
   billing is not, and four models already refuse this key — see "Model
   routing" above.
3. Regenerate one 10x12 bedroom and judge `GREYBOX_ROOM_SCALE`. 1.3x was
   derived from placement legality, not from how the render looks — if rooms
   now read too empty, or furniture too small against the walls, it is a
   one-line change in `greybox/room-scale.ts`, as are the catalogue
   footprints.
4. Unset `DEBUG_PROMPTS` before going live.
5. `git push origin main`.
