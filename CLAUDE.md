# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start the app (http://localhost:3000). The floor-plan pipeline runs synchronously here by default; no other services needed.
- `npm run dev:inngest` — run alongside `npm run dev` in a second terminal to test the async (Inngest) job path.
- `npm run build` — production build.
- `npm run start` — run a production build.
- `npm run lint` — ESLint.
- No test runner is configured in this repo.

## Architecture

There is no separate backend service. Next.js API routes under `src/app/api/*` are the backend, running server-side inside the same app. One of them spawns a Python subprocess for image geometry detection.

### Floor-plan parsing pipeline

Core domain logic, spread across `src/lib/pipeline/`:

```
Upload (JPG/PNG) → AWS S3 → Inngest → OCR (Gemini Vision) → Gemini Flash (semantics) → OpenCV (geometry) → Merge Engine → FloorPlan
```

| Stage | Module | Purpose |
| --- | --- | --- |
| Storage | `pipeline/storage.ts` | Uploads to S3; falls back to local temp storage if AWS env vars are unset |
| Queue | `inngest/` + `app/api/inngest` | Optional retryable/observable async job execution |
| OCR | `pipeline/ocr.ts` + `pipeline/gemini-client.ts` | Gemini Vision, prompted as an OCR engine, transcribes room names/dimensions/scale from the image |
| Semantics | `pipeline/semantic.ts` | Gemini Flash reasons over OCR text into structured rooms/types/scale |
| Geometry | `pipeline/opencv.ts` → `scripts/parse_plan.py` | Spawns Python/OpenCV to detect walls, doors, windows, room boxes in pixels. `scripts/detect_rooms_labeled.py` is an alternate detector (`DETECTOR=labeled`) that uses local EasyOCR to grow labeled rooms out to walls |
| Merge | `pipeline/merge.ts` | Resolves px→feet scale and merges OCR + geometry into one `FloorPlan` |

Entry point: `src/app/api/parse-plan/route.ts`. Each stage degrades gracefully when its credentials are missing (e.g. no `GEMINI_API_KEY` → generic room names from geometry alone; no AWS creds → local disk storage). PDFs are not rasterized — they currently fall back to a sample layout; only PNG/JPG go through the real pipeline.

### Rendering pipeline — rebuilt, Workstream 8.5 (2026-07-26)

The old 3D furniture-placement studio and its multi-view/orbit-video render pipeline were **destroyed**, not deprecated — see `docs/VASTOS_REVAMP_PLAN.md`'s "What's kept vs. what's destroyed" for the full list. `render/flux-client.ts` (fal.ai), `render/verify.ts` (furniture-presence checker), `render/annotate.ts`, `render/prompt.ts`, `render/video-jobs.ts`, `render-client.ts`, `scene-3d.tsx`, `panorama-360.tsx`, `room-walkthrough.tsx`, `opening-editor.tsx`, `detect-room-client.ts`, `suggest-furniture-client.ts`, the `/api/detect-room` and `/api/suggest-furniture` routes, and the entire `PlacedItem`/furniture-catalog UI are gone.

What's live now, all driven by the Universal JSON Architecture (see "AI prompting pipeline" below):
- `src/lib/render/gemini-image.ts` — Nano Banana image edits, used by `/api/edit-room-image` (View & Edit's up-to-2-region lasso edit).
- `src/lib/render/veo-client.ts` — Veo image-to-video, used by `/api/generate-walkthrough`: one 3-second cinematic-zoom-in clip per approved room image (Veo's minimum is 4s — each clip is generated at 4s and trimmed to exactly 3s via `ffmpeg.ts`'s `trimVideo`), concatenated in order.
- `src/lib/render/ffmpeg.ts` — `concatVideos`, `trimVideo`; `assembleSlideshow`/`extractFramesFromVideo`/`probeDuration` are leftover from the old orbit flow, unused but harmless.
- `/api/generate-room-image`, `/api/edit-room-image`, `/api/generate-walkthrough`, `/api/order-rooms`, `/api/design-plan` — small, single-purpose routes, replacing the old 859-line `/api/render` (which now only has a `GET ?key=` handler serving stored bytes back to the browser).

### Data layer

Supabase (hosted Postgres + Auth + Realtime), no ORM — schema is raw SQL in `supabase/schema.sql`, applied manually via the Supabase SQL editor. Two client wrappers in `src/lib/supabase/`: `server.ts` uses the service-role key and bypasses RLS; `browser.ts` uses the publishable key and is used only for Realtime subscriptions. Both return `null` when unconfigured, and callers treat persistence as best-effort — the app works without Supabase.

Main tables (RLS-scoped by `auth.users`): `projects`, `parse_jobs` (one per pipeline run, stores OCR/semantic/geometry/merge JSON + status), `floor_plans`, `placed_items`, `scenes`, `renders`/`render_versions`, `project_snapshots` (JSONB mirror of client state — predates real auth below and hasn't been migrated onto it yet, still local-first via an anonymous browser id), `render_jobs` (durable registry for long-running Veo video jobs). Realtime is enabled on `parse_jobs`, `renders`, `render_versions`, `project_snapshots`. **Note**: `placed_items`, `scenes`, `renders`/`render_versions`, `render_jobs` back the destroyed old studio/render flow above — the local-first `useVasto` store (`src/lib/store.ts`) no longer reads or writes those shapes (`Project.roomCards`/`Project.walkthrough` replaced them client-side); the tables themselves are left alone pending a real migration, not touched by this pass.

### Auth

Real auth now exists (revamp Workstream 2), built on Supabase Auth rather than a custom users table — `owner_id references auth.users(id)` was already in the schema, and Supabase Auth means no hand-rolled password hashing or session crypto. Clients never self-register; accounts are admin-issued via `supabase.auth.admin.createUser`.

- `profiles` table (`supabase/schema.sql`) carries the app-specific fields Supabase Auth doesn't: `role` (`user`/`master` — just two, no admin tier), `status`, `trial_ends_at`. A trigger (`handle_new_auth_user`) auto-creates the matching row whenever a new `auth.users` row is created, reading `role` out of that call's `user_metadata` if passed.
- `src/lib/supabase/server-client.ts` — cookie-aware Supabase client (`@supabase/ssr`) for Server Components/Route Handlers/Server Actions, distinct from `server.ts` (service-role, bypasses RLS, for privileged one-off calls like `admin.createUser`) and `browser.ts` (anon key, Realtime only).
- `src/lib/auth/session.ts` — `getCurrentUser()`/`requireUser()`/`requireRole()`, the actual (non-optimistic) auth check. Verifies the JWT via `getClaims()` then loads the `profiles` row. Call this in every protected page/API route — don't rely on the proxy alone.
- `src/proxy.ts` — Next 16 renamed `middleware.ts` → `proxy.ts` (now defaults to the Node.js runtime, not Edge). This is an *optimistic* redirect-only check (session cookie present or not); it does not query the database or check role.
- `src/app/login/` — the sign-in page + `actions.ts` (`signIn`/`signOut` Server Actions). No signup route exists anywhere in the app by design.
- Bootstrapping the first account: create a user in the Supabase dashboard, then `update profiles set role = 'master' where id = '<uuid>';` — see the comment in `schema.sql`.

### AI provider layer

`src/lib/ai/provider.ts` (revamp Workstream 4) is the single entry point for AI calls: `generateImage`, `editImage`, `generateVideo`, `generateStructured`, `runOCR`, `runSemantic`. Each call retries per `src/lib/ai/errors.ts`'s policy, times itself, and writes a best-effort row to the `ai_usage_logs` table (`src/lib/ai/usage-log.ts`) with a normalized `ErrorCategory`. `pipeline.ts` calls `runOCR`/`runSemantic` (not `ocr.ts`/`semantic.ts` directly) so the live upload flow is instrumented. `editImage`/`generateVideo` delegate to `render/gemini-image.ts`/`render/veo-client.ts`. `render/flux-client.ts` (fal.ai/FLUX) is fully removed as of Workstream 8.5 — it was kept only as the old 3D-studio render path's fallback, and that path no longer exists.

### AI prompting pipeline — live end-to-end as of Workstream 8.5

`src/lib/ai/prompting/` (revamp Workstream 5) implements the Universal JSON Architecture: `build-universal-input.ts` (validates frontend selections into a `UniversalInput`), `design-planning.ts` (`runDesignPlanning` — one Gemini call, via `provider.generateStructured`, into a `DesignSpecification` with per-room guidance), `prompt-builder.ts` (`buildRoomPrompt` — deterministic, no AI call, the only place natural-language prompt text is produced). Template wording (`system`/`planning`/`builder`) lives in the `prompt_templates` table, versioned and `published`-gated; `templates.ts` falls back to hardcoded defaults when unconfigured.

The full flow, in order: `/projects/[id]/floor-plan` (Yes/No) → `upload` (OCR/OpenCV/Gemini detection) → `review` (Room Confirmation: rename, type, size, door/window counts, unit selector) → `design` (style/luxury/colour + one global Additional Requirements box) → `POST /api/design-plan` (`buildUniversalInput` + `runDesignPlanning`, cached on the project via `setDesignPlan`) → `generate` (Room Generation Gallery: `POST /api/generate-room-image`, `buildRoomPrompt` + `provider.generateImage`, one card per room, Generate More with its own per-call note) → `generate/[roomId]` (View & Edit: up to 2 numbered lasso regions, `POST /api/edit-room-image`) → `approve` (Final Image Selection) → `walkthrough` (`POST /api/generate-walkthrough`, one 3-second clip per approved image, concatenated). Everything is cached on the local-first `useVasto` project (`universalInput`, `designSpec`, `roomCards`, `walkthrough`) — not yet the real `projects.manifest` row (see the state-machine note below), same situation as before Workstream 8.5.

### Config-driven project types, detection toggle, room openings

`config/project-types/*.json` (Workstream 6) — one file per category, loaded by `src/lib/project-types/config.ts`. `DETECTION_MODE=gemini` (Workstream 7) skips the Python/OpenCV subprocess via `opencv.ts`'s `emptyGeometry()`, relying on `merge.ts`'s existing under-segmentation fallback to build the plan from Gemini vision alone — useful if Python is broken locally, or for a future Python-free deploy. `feature_flags` table + `src/lib/feature-flags.ts` is a separate, generic on/off-toggle mechanism (no rollout logic), not yet read anywhere. `src/lib/pipeline/assign-openings.ts` (Workstream 7a) deterministically assigns each detected door/window to the room(s) it borders (`Room.openings`), run post-merge in both the sync and async (Inngest) pipelines; `ai/prompting/prompt-builder.ts` turns that into a natural-language clause when present.

### Profile page

`/profile` (`src/app/profile/page.tsx`) shows account info (from `getCurrentUser()`) and a project list/count via `src/components/profile-projects.tsx`, which reads the same local-first `useVasto` store `/projects` uses — not the `projects` table, which isn't wired into any live page yet (see below). No cost figures are shown to a client; that stays admin-only.

### Project lifecycle state machine

`projects.status` (11-value enum, `supabase/schema.sql`) plus `projects.manifest` (JSONB) are the backend foundation for the revamped flow — the frontend is meant to read this one field instead of maintaining separate boolean flags. `src/lib/projects/state.ts` has the transition graph (`transitionProject`) and manifest helpers (`getProjectManifest`/`updateProjectManifest`). Named `ProjectState` to avoid colliding with the unrelated, pre-existing `ProjectStatus` in `src/lib/types.ts` (the old local-first store's status, a different concept).

**Not wired into the live app yet.** Every current page still persists through `project_snapshots` (see below), not the normalized `projects` table — nothing calls `transitionProject` today. That wiring happens once the frontend is rebuilt onto real `projects` rows.

### Env vars

`.env.example` documents every variable below (`.env*` is otherwise gitignored). Everything is optional and the app degrades gracefully without it:

- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_VIDEO_MODEL` — OCR, semantic reasoning, image edits, video
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` — real S3 upload storage
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — persistence (run `supabase/schema.sql` first)
- `INNGEST_ENABLED` — switch parsing to the async Inngest path
- `DETECTOR=labeled` — use the EasyOCR-assisted room detector instead of the default contour-based one
- `PYTHON_BIN` — override the Python executable used to spawn geometry-detection scripts
