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

### Rendering pipeline

`src/lib/render/`: `flux-client.ts` (fal.ai FLUX Pro — photorealistic stills), `gemini-image.ts` (Gemini/"Nano Banana" image edits), `veo-client.ts` (walkthrough video generation), plus `ffmpeg.ts`, `annotate.ts`, `prompt.ts`, `verify.ts`, `video-jobs.ts` supporting that flow.

### Data layer

Supabase (hosted Postgres + Auth + Realtime), no ORM — schema is raw SQL in `supabase/schema.sql`, applied manually via the Supabase SQL editor. Two client wrappers in `src/lib/supabase/`: `server.ts` uses the service-role key and bypasses RLS; `browser.ts` uses the publishable key and is used only for Realtime subscriptions. Both return `null` when unconfigured, and callers treat persistence as best-effort — the app works without Supabase.

Main tables (RLS-scoped by `auth.users`): `projects`, `parse_jobs` (one per pipeline run, stores OCR/semantic/geometry/merge JSON + status), `floor_plans`, `placed_items`, `scenes`, `renders`/`render_versions`, `project_snapshots` (JSONB mirror of client state, since auth isn't wired up yet — the app is local-first), `render_jobs` (durable registry for long-running Veo video jobs). Realtime is enabled on `parse_jobs`, `renders`, `render_versions`, `project_snapshots`.

### Env vars

No `.env.example` is committed (`.env*` is gitignored). Everything is optional and the app degrades gracefully without it:

- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_VIDEO_MODEL` — OCR, semantic reasoning, image edits, video
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` — real S3 upload storage
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — persistence (run `supabase/schema.sql` first)
- `FAL_KEY`, `FAL_TXT2IMG_MODEL`, `FAL_IMG2IMG_MODEL`, `FAL_INPAINT_MODEL`, `FAL_IMG2IMG_STRENGTH` — FLUX Pro rendering
- `INNGEST_ENABLED` — switch parsing to the async Inngest path
- `DETECTOR=labeled` — use the EasyOCR-assisted room detector instead of the default contour-based one
- `PYTHON_BIN` — override the Python executable used to spawn geometry-detection scripts
