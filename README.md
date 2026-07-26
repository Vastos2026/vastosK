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
