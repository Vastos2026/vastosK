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
| 3 | `/review` | Room Confirmation — rename, retype, resize, edit door/window counts, delete rooms, or add rooms manually (detection misses land here) |
| 4 | `/furnish` | Furnish gallery, one card per room. Renders a "greybox" 3D reference image per room and lets you optionally place furniture in a per-room 3D editor (`/furnish/[roomId]`). Skippable per room — generation works fine from an openings-only greybox |
| 5 | `/design` | Pick style/luxury/colour, optionally upload a design-reference photo (`POST /api/design-reference`) whose look gets folded into planning, and write one global "Additional Requirements" note |
| 6 | (server) | `POST /api/design-plan` — one Gemini structured-output call produces per-room design guidance, cached on the project |
| 7 | `/generate` | Room Generation Gallery — `POST /api/generate-room-image` per room, horizontally-scrollable strip of generations, oldest→newest, "Generate More" with its own note |
| 8 | `/generate/[roomId]` | View & Edit — up to 2 numbered lasso regions, `POST /api/edit-room-image` |
| 9 | `/approve` | Final Image Selection per room; from here, `POST /api/enhance-room-image` can do a one-shot whole-image quality/finishing pass on an approved photo |
| 10 | `/walkthrough` | `POST /api/generate-walkthrough` — one ~3s cinematic clip per approved room image, concatenated |
| — | `/api/export-pdf`, `/api/share-link` | Export the finished project to PDF; mint an unauthenticated share link (`/s/[token]`) for a client to view the walkthrough |

`src/app/projects/[id]/sketch/page.tsx` (a draw-boundary/calibrate tool) is
disabled and unlinked by product decision — left in the codebase, not
deleted, pending a future call on reviving it.

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
| API guard | `src/lib/api-guard.ts` | `assertAllowed` centralizes auth + CSRF (same-origin) + per-user rate limit + admin-set spend cap (`checkUsage: true`) for every route that needs it. All 14 routes under `src/app/api/*` use it except `/api/dev-check` (404s outside development) and the public share-asset proxy, which is scoped by its own token allow-list instead |

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

- **Text/vision-to-text** (floor-plan extraction, design planning, design-reference
  analysis) always goes direct to Google AI Studio (Gemini). This is not
  affected by the Runware toggle below.
- **Image generation/editing/enhance** goes to Runware whenever
  `RUNWARE_API_KEY` is set and `IMAGE_PROVIDER` is not `"gemini"`: FLUX.2
  [pro] (`bfl:5@1`) for generation, Nano Banana Pro (`google:4@2`) for the
  View & Edit lasso, Nano Banana 2 (`google:4@3`) for Enhance and as the
  Runware-side fallback tier. Nano Banana 2 is the same underlying model as
  Gemini 3.1 Flash Image. With no `RUNWARE_API_KEY` (or `IMAGE_PROVIDER=gemini`),
  everything falls back to direct Gemini image calls — the emergency,
  last-resort tier when Runware itself fails.
- **Video** follows the equivalent `VIDEO_PROVIDER` toggle (Wan 2.7 via
  Runware, or Veo direct).

See `src/lib/render/runware-client.ts`'s header comment and `CLAUDE.md`'s
"AI provider layer" for the exact env-var fallback chain.

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
