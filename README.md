# Vastos

Turns a 2D floor plan into photorealistic AI interior renders and walkthrough
videos. Next.js 16 (App Router) frontend + API routes, Supabase for auth and
persistence, Python/OpenCV for floor-plan geometry detection, Gemini for OCR,
reasoning, image generation and video.

See `CLAUDE.md` for the full architecture writeup and `docs/VASTOS_REVAMP_PLAN.md`
for the current product plan and build status.

## Prerequisites

- Node.js 20+
- **Python 3.10+** with a real interpreter on `PATH` as `python` — the floor-plan
  geometry stage (`scripts/parse_plan.py`) spawns it as a subprocess. On Windows,
  the built-in `python` command may resolve to a non-functional Microsoft Store
  stub; either install Python from [python.org](https://www.python.org/) and
  check "Add to PATH", or set `PYTHON_BIN` in `.env.local` to a real interpreter's
  path. You can also disable the stub at Settings → Apps → Advanced app settings
  → App execution aliases.
- A Supabase project, if you want persistence/auth (optional — see below)

## Setup

```bash
npm install
pip install -r scripts/requirements.txt
cp .env.example .env.local   # fill in what you need — everything is optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app degrades
gracefully with no env vars set at all — floor-plan parsing runs on geometry
alone, storage falls back to local disk, and there's no persistence. Fill in
`.env.local` incrementally as you need each piece (see `.env.example` for
what each var unlocks).

**Supabase**: if you set the `SUPABASE_*` vars, run `supabase/schema.sql` in
your project's SQL editor first (it's idempotent — safe to re-run after
pulling changes that touch it). Bootstrap your first account per the comment
near the end of that file.

**Python-free option**: set `DETECTION_MODE=gemini` to skip the Python
subprocess entirely and rely on Gemini vision alone for floor-plan geometry
(requires `GEMINI_API_KEY`). Useful if Python is broken locally, or for a
deploy target without a Python runtime.

## Project structure

```
├── src/
│   ├── app/            # Next.js App Router — pages + API routes (src/app/api/*)
│   ├── components/     # React components (ui/ = shared primitives)
│   ├── hooks/          # standalone custom hooks
│   └── lib/            # domain logic: pipeline/, ai/, render/, supabase/, projects/, auth/
├── config/
│   └── project-types/  # one JSON per project category (residential/apartment/commercial/custom)
├── scripts/             # Python floor-plan geometry detectors
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

- `npm run dev` — start the app. Floor-plan parsing runs synchronously by default.
- `npm run dev:inngest` — run alongside `npm run dev` in a second terminal to
  test the async (Inngest) job path (`INNGEST_ENABLED=1`).
- `npm run build` / `npm run start` — production build / run it.
- `npm run lint` — ESLint. No test runner is configured in this repo.

## Floor-plan parsing pipeline

Uploaded plans flow through discrete, observable stages (`src/lib/pipeline/`,
orchestrated by `src/lib/ai/provider.ts` for the AI calls):

```
Upload (JPG/PNG) → AWS S3 → Inngest → OCR → Gemini Flash → OpenCV → Merge Engine → openings → FloorPlan
```

| Stage        | Module                                          | What it does                                                          |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| AWS S3       | `pipeline/storage.ts`                           | Stores the upload; local-temp fallback when AWS env vars are unset    |
| Inngest      | `inngest/` + `app/api/inngest`                  | Runs the job as retryable, observable steps (opt-in)                  |
| OCR          | `ai/provider.ts` → `pipeline/ocr.ts`            | Gemini Vision transcribes labels (room names, dimensions, scale)      |
| Gemini Flash | `ai/provider.ts` → `pipeline/semantic.ts`       | Reasons over OCR text into structured rooms / types / scale          |
| OpenCV       | `pipeline/opencv.ts` + `scripts/parse_plan.py`  | Detects walls, doors, windows, room boxes (pixels) — skippable, see `DETECTION_MODE` above |
| Merge Engine | `pipeline/merge.ts`                             | Resolves scale, converts px→feet, labels each room                   |
| Openings     | `pipeline/assign-openings.ts`                   | Deterministically assigns each door/window to its room + side        |

It degrades gracefully at every stage: missing AWS creds → local storage;
missing `GEMINI_API_KEY` → OpenCV geometry with generic room names; missing
Supabase config → no persistence, everything else still works.

> **PDF note:** PDFs currently fall back to a sample layout — OpenCV needs a
> raster image. Export plans to PNG/JPG for the full pipeline.

## Deploying

The floor-plan pipeline's Python step needs a runtime that can spawn a
subprocess with OpenCV/numpy installed — a plain Vercel deployment can't do
that. Either deploy somewhere with a Python runtime available (a container,
or a platform with a Python buildpack), or set `DETECTION_MODE=gemini` to
drop the Python dependency entirely and deploy anywhere Next.js runs.
