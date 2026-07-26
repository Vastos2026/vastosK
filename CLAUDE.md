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

The old staged pipeline (`pipeline/ocr.ts`, `pipeline/semantic.ts`, `pipeline/merge.ts`, `pipeline/pipeline.ts`, `pipeline/validate.ts`, `pipeline/job-store.ts`) and its Inngest async job path (`lib/inngest/`, `app/api/inngest/route.ts`) were retired 2026-07-26 — nothing in the live app called them. `src/lib/pipeline/opencv.ts` (spawns `scripts/parse_plan.py`/`scripts/detect_rooms_labeled.py` for Python/OpenCV geometry detection) is left in place per this plan's scope but is currently dormant/uncalled — see `DETECTOR`/`DETECTION_MODE` in "Env vars" below.

### Rendering pipeline — rebuilt, Workstream 8.5 (2026-07-26)

The old 3D furniture-placement studio and its multi-view/orbit-video render pipeline were **destroyed**, not deprecated — see `docs/VASTOS_REVAMP_PLAN.md`'s "What's kept vs. what's destroyed" for the full list. `render/flux-client.ts` (fal.ai), `render/verify.ts` (furniture-presence checker), `render/annotate.ts`, `render/prompt.ts`, `render/video-jobs.ts`, `render-client.ts`, `scene-3d.tsx`, `panorama-360.tsx`, `room-walkthrough.tsx`, `opening-editor.tsx`, `detect-room-client.ts`, `suggest-furniture-client.ts`, the `/api/detect-room` and `/api/suggest-furniture` routes, and the entire `PlacedItem`/furniture-catalog UI are gone.

What's live now, all driven by the Universal JSON Architecture (see "AI prompting pipeline" below):
- `src/lib/render/gemini-image.ts` — Nano Banana image edits, used by `/api/edit-room-image` (View & Edit's up-to-2-region lasso edit).
- `src/lib/render/veo-client.ts` — Veo image-to-video, used by `/api/generate-walkthrough`: one 3-second cinematic-zoom-in clip per approved room image (Veo's minimum is 4s — each clip is generated at 4s and trimmed to exactly 3s via `ffmpeg.ts`'s `trimVideo`), concatenated in order.
- `src/lib/render/ffmpeg.ts` — `concatVideos`, `trimVideo`; `assembleSlideshow`/`extractFramesFromVideo`/`probeDuration` are leftover from the old orbit flow, unused but harmless.
- `/api/generate-room-image`, `/api/edit-room-image`, `/api/generate-walkthrough`, `/api/order-rooms`, `/api/design-plan` — small, single-purpose routes, replacing the old 859-line `/api/render` (which now only has a `GET ?key=` handler serving stored bytes back to the browser).

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

### AI provider layer

`src/lib/ai/provider.ts` (revamp Workstream 4) is the single entry point for AI calls: `generateImage`, `editImage`, `generateVideo`, `generateStructured`, `extractFloorPlan`. Each call retries per `src/lib/ai/errors.ts`'s policy, times itself, and writes a best-effort row to the `ai_usage_logs` table (`src/lib/ai/usage-log.ts`) with a normalized `ErrorCategory`. `pipeline/extract-plan.ts` calls `extractFloorPlan` so the live upload flow is instrumented (the old `runOCR`/`runSemantic` wrappers around `pipeline/ocr.ts`/`pipeline/semantic.ts` were removed 2026-07-26 along with those two files — nothing called them once the old staged pipeline was retired). `editImage`/`generateVideo` delegate to `render/gemini-image.ts`/`render/veo-client.ts`. `render/flux-client.ts` (fal.ai/FLUX) is fully removed as of Workstream 8.5 — it was kept only as the old 3D-studio render path's fallback, and that path no longer exists.

### AI prompting pipeline — live end-to-end as of Workstream 8.5

`src/lib/ai/prompting/` (revamp Workstream 5) implements the Universal JSON Architecture: `build-universal-input.ts` (validates frontend selections into a `UniversalInput`), `design-planning.ts` (`runDesignPlanning` — one Gemini call, via `provider.generateStructured`, into a `DesignSpecification` with per-room guidance), `prompt-builder.ts` (`buildRoomPrompt` — deterministic, no AI call, the only place natural-language prompt text is produced). Template wording (`system`/`planning`/`builder`) lives in the `prompt_templates` table, versioned and `published`-gated; `templates.ts` falls back to hardcoded defaults when unconfigured.

The full flow, in order: `/projects/[id]/floor-plan` (Yes/No) → `upload` (detection: one panel showing the image + wall/door/window/room overlay + layer toggles + stats — detected rooms land on the plan directly, no per-room confirmation step here) → `review` (Room Confirmation: rename, type, size, door/window counts, unit selector, delete room, and a manual "Add room" form — name/type/width/height — for anything detection missed) → `design` (style/luxury/colour + one global Additional Requirements box) → `POST /api/design-plan` (`buildUniversalInput` + `runDesignPlanning`, cached on the project via `setDesignPlan`) → `generate` (Room Generation Gallery: `POST /api/generate-room-image`, `buildRoomPrompt` + `provider.generateImage`, one card per room, Generate More with its own per-call note) → `generate/[roomId]` (View & Edit: up to 2 numbered lasso regions, `POST /api/edit-room-image`) → `approve` (Final Image Selection) → `walkthrough` (`POST /api/generate-walkthrough`, one 3-second clip per approved image, concatenated). Everything is cached on the local-first `useVasto` project (`universalInput`, `designSpec`, `roomCards`, `walkthrough`) — not yet the real `projects.manifest` row (see the state-machine note below), same situation as before Workstream 8.5.

**Upload page has no lasso tool** (removed 2026-07-26) — `lasso-select.tsx` (freehand-on-the-upload-image drawing) is deleted; `lasso-extract.ts` is trimmed to just `pxToFtTransform`, which had no caller left once `pipeline.ts` was retired in the same pass — left in place (unused) rather than deleted, since it wasn't in this pass's file list. The View & Edit screen's lasso (`lasso-canvas.tsx`, numbered mask regions on a *generated* room image) is a separate, still-live component — don't confuse the two.

### Config-driven project types, detection toggle, room openings

`config/project-types/*.json` (Workstream 6) — one file per category, loaded by `src/lib/project-types/config.ts`, and passed into `extractFloorPlan` as room-type hints. `DETECTOR`/`DETECTION_MODE` (Workstream 7) describe the dormant Python/OpenCV path (`opencv.ts`, `scripts/parse_plan.py`/`scripts/detect_rooms_labeled.py`) — left in the codebase per this plan's scope but currently unused by the live app, which extracts via Gemini vision alone (see "Floor-plan extraction" above). `feature_flags` table + `src/lib/feature-flags.ts` is a separate, generic on/off-toggle mechanism (no rollout logic), not yet read anywhere. `src/lib/pipeline/assign-openings.ts` (Workstream 7a) used to deterministically assign each detected door/window to the room(s) it borders via pixel geometry; that algorithm was retired 2026-07-26 — the new extraction pipeline gets door/window side + connection directly from Gemini instead, and only the file's `OpeningSide`/`RoomOpening` types remain, still consumed by `ai/prompting/prompt-builder.ts` to turn `Room.openings` into a natural-language clause.

### Profile page

`/profile` (`src/app/profile/page.tsx`) shows account info (from `getCurrentUser()`) and a project list/count via `src/components/profile-projects.tsx`, which reads the same local-first `useVasto` store `/projects` uses — not the `projects` table, which isn't wired into any live page yet (see below). No cost figures are shown to a client; that stays admin-only.

### Project lifecycle state machine

`projects.status` (11-value enum, `supabase/schema.sql`) plus `projects.manifest` (JSONB) are the backend foundation for the revamped flow — the frontend is meant to read this one field instead of maintaining separate boolean flags. `src/lib/projects/state.ts` has the transition graph (`transitionProject`) and manifest helpers (`getProjectManifest`/`updateProjectManifest`). Named `ProjectState` to avoid colliding with the unrelated, pre-existing `ProjectStatus` in `src/lib/types.ts` (the old local-first store's status, a different concept).

**Not wired into the live app yet.** Every current page still persists through `project_snapshots` (see below), not the normalized `projects` table — nothing calls `transitionProject` today. That wiring happens once the frontend is rebuilt onto real `projects` rows.

### Env vars

`.env.example` documents every variable below (`.env*` is otherwise gitignored). Everything is optional and the app degrades gracefully without it:

- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_VIDEO_MODEL` — floor-plan extraction, image edits, video
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` — real S3 upload storage
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — persistence (run `supabase/schema.sql` first)
- `DETECTOR=labeled` — use the EasyOCR-assisted room detector (`scripts/detect_rooms_labeled.py`) instead of the default contour-based one (`scripts/parse_plan.py`). **Currently unused by the live app** — this and `DETECTION_MODE` describe the dormant Python/OpenCV path (`opencv.ts`), not called by anything since the old staged pipeline was retired 2026-07-26; left in the codebase per this plan's scope. Requires `easyocr` installed (`pip install -r scripts/requirements.txt`).
- `DETECTION_MODE=gemini` — see above; also currently unused by the live app.
- `PYTHON_BIN` — override the Python executable used to spawn geometry-detection scripts (also currently unused by the live app, see above)
