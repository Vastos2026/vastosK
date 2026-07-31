# Vastos

Turns a 2D floor plan into photorealistic AI interior renders and walkthrough
videos. Next.js 16 (App Router) frontend + API routes, Supabase for auth and
persistence, a single Gemini vision call for floor-plan extraction, Gemini for
reasoning, image generation and video. (A Python/OpenCV geometry-detection
path also exists in the codebase but is currently unused by the live app —
see "Floor-plan extraction" below.)

See `CLAUDE.md` for the full architecture writeup and `docs/VASTOS_REVAMP_PLAN.md`
for the current product plan and build status.

## Prerequisites

- Node.js 20+
- A `GEMINI_API_KEY`, to actually extract rooms from an uploaded floor plan
  (optional to start the app, but without it extraction fails and the flow
  routes to manual room entry — see below)
- A Supabase project, if you want persistence/auth (optional — see below)
- **Python 3.10+** is only needed if you plan to use the dormant Python/OpenCV
  geometry-detection path (`DETECTOR`/`DETECTION_MODE`, see `.env.example`) —
  not required for the live floor-plan extraction flow. See "Floor-plan
  extraction" below.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in what you need — everything is optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app degrades
gracefully with no env vars set at all — storage falls back to local disk,
there's no persistence, and floor-plan extraction fails (routing to manual
room entry) until `GEMINI_API_KEY` is set. Fill in `.env.local` incrementally
as you need each piece (see `.env.example` for what each var unlocks).

**Supabase**: if you set the `SUPABASE_*` vars, run `supabase/schema.sql` in
your project's SQL editor first (it's idempotent — safe to re-run after
pulling changes that touch it). Bootstrap your first account per the comment
near the end of that file.

## Project structure

```
├── src/
│   ├── app/            # Next.js App Router — pages + API routes (src/app/api/*)
│   ├── components/     # React components (ui/ = shared primitives)
│   ├── hooks/          # standalone custom hooks
│   └── lib/            # domain logic: pipeline/, ai/, render/, supabase/, projects/, auth/
├── config/
│   └── project-types/  # one JSON per project category (residential/apartment/commercial/custom)
├── scripts/             # Python floor-plan geometry detectors (currently unused by the live app)
│   ├── parse_plan.py
│   ├── detect_rooms_labeled.py
│   └── requirements.txt
├── supabase/
│   └── schema.sql       # full DB schema, idempotent, run manually in the SQL editor
├── public/
├── docs/
│   └── VASTOS_REVAMP_PLAN.md
├── .env.example
├── package.json
├── CLAUDE.md            # architecture guide for AI coding assistants
└── AGENTS.md            # heads-up: this Next.js version has breaking changes vs. training data
```

## Commands

- `npm run dev` — start the app. Floor-plan extraction runs synchronously in
  the request.
- `npm run build` / `npm run start` — production build / run it.
- `npm run lint` — ESLint. No test runner is configured in this repo.

## Floor-plan extraction

One Gemini vision call does the whole job — no staged pipeline, no async job
queue. `src/app/api/parse-plan/route.ts` calls `runPlanExtraction`
(`src/lib/pipeline/extract-plan.ts`), which calls `extractFloorPlan`
(`src/lib/ai/provider.ts`, the sole entry point for the Gemini call), passing
the uploaded image plus the active project category's room-type hints.
Gemini returns room names (verbatim), types, printed dimensions where
legible, and door/window presence with side + connection; `extract-plan.ts`
maps that onto the app's `FloorPlan`/`Room` shape.

| Stage      | Module                                        | What it does                                                        |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| AWS S3     | `pipeline/storage.ts`                          | Stores the upload; local-temp fallback when AWS env vars are unset   |
| Extraction | `ai/provider.ts` → `pipeline/extract-plan.ts`  | Single Gemini vision call: rooms, types, dimensions, openings        |

It degrades gracefully: missing AWS creds → local storage; missing
`GEMINI_API_KEY` → extraction fails outright, surfaced to the frontend as
`readable: false`, routing to manual room entry (there is no offline/local
fallback in the live app); missing Supabase config → no persistence,
everything else still works.

> **PDF note:** PDFs are rejected with an error. Export plans to PNG/JPG.

The old staged pipeline (OCR → Gemini Flash semantics → OpenCV geometry →
merge engine → deterministic opening assignment) and its Inngest async job
queue were retired 2026-07-26 — nothing in the live app called them. A
Python/OpenCV geometry-detection path (`pipeline/opencv.ts`,
`scripts/parse_plan.py`, `scripts/detect_rooms_labeled.py`, toggled by the
`DETECTOR`/`DETECTION_MODE` env vars) still exists in the codebase but is
currently dormant/unused by the live app.

## Deploying

The live floor-plan extraction path is pure Next.js + a Gemini API call — no
Python runtime needed, so a plain Vercel deployment works out of the box. A
Python runtime is only required if you additionally want the dormant
`DETECTOR`/`DETECTION_MODE` geometry-detection path (see above) available.

Set the env vars below in the Vercel project's Settings → Environment
Variables (values live in your own `.env.local` / secrets manager — never
commit them). Everything is optional except the two marked required for a
non-degraded deploy.

| Var | Required? | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Required for floor-plan extraction, image edits, video, and AI prompting | Google Gemini API key |
| `GEMINI_MODEL` / `GEMINI_IMAGE_MODEL` / `GEMINI_VIDEO_MODEL` | Optional | Override the default Gemini model IDs |
| `NEXT_PUBLIC_SUPABASE_URL` | Required for persistence/auth | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Required for persistence/auth | Supabase service-role key (server-only, bypasses RLS — never expose client-side) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Required for persistence/auth | Supabase anon/publishable key (safe to expose client-side) |
| `RUNWARE_API_KEY` | Optional | Switches image/video generation to Runware (FLUX.2/FLUX Fill/Wan 2.7) instead of Gemini |
| `IMAGE_PROVIDER` / `VIDEO_PROVIDER` | Optional | `"gemini"` to force Gemini even with `RUNWARE_API_KEY` set |
| `RUNWARE_IMAGE_MODEL` / `RUNWARE_EDIT_MODEL` / `RUNWARE_VIDEO_MODEL` / `RUNWARE_FALLBACK_IMAGE_MODEL` / `RUNWARE_IMAGE_RESOLUTION` | Optional | Runware model/resolution overrides |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Recommended for production storage | Cloudflare R2 (preferred over S3 — no egress fees); takes priority over S3 if both are set |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `S3_BUCKET` | Optional (fallback) | Plain S3 storage; local disk is used if both R2 and S3 are unset — **do not rely on local disk on Vercel**, its filesystem is ephemeral/read-only per invocation |
| `PYTHON_BIN` / `DETECTOR` / `DETECTION_MODE` / `DETECT_FURNITURE` | Optional, dormant | Only relevant if you wire the currently-unused Python/OpenCV geometry path back in; not needed for a standard deploy |
| `RENDER_VERIFY` | Optional | Misc render-verification toggle |

> **Function duration:** `/api/generate-walkthrough` sets `maxDuration = 300`
> (one Veo clip per room, generated concurrently, can still take minutes for a
> many-room project) and `/api/design-plan`/`/api/export-pdf` set 120/180s.
> Vercel enforces its own plan-level ceiling regardless of what the route
> requests — Hobby caps around 60s, Pro defaults to 60s unless you either
> raise the project's function duration in Settings → Functions or enable
> Fluid Compute (which allows up to 800s). If a route is silently killed
> mid-run, the platform returns its own timeout page instead of the route's
> JSON — on the client this can surface as a generic failure with no useful
> message, rather than the specific error the route itself would have
> returned. Confirm your plan's actual limit before relying on the longer
> `maxDuration` values above.

On Vercel specifically: since local disk storage doesn't persist between
invocations, set the R2 (or S3) vars for any real deployment — without them,
uploaded floor plans and generated renders will vanish between requests.
