# Vastos

Turns a 2D floor plan into photorealistic AI interior renders and a short
walkthrough video. Next.js 16 (App Router) frontend + API routes, Supabase
for auth and persistence, Gemini for floor-plan extraction and design
reasoning, and a Gemini/Runware toggle for image and video generation.
Licensed product — accounts are admin-issued, there is no signup flow.

See `context.md` for an onboarding walkthrough of the product and flow,
`CLAUDE.md` for the full architecture writeup, and `docs/VASTOS_REVAMP_PLAN.md`
for the current product plan and build status.

## Prerequisites

- Node.js 20+
- A `GEMINI_API_KEY`, to extract rooms from an uploaded floor plan and run
  design planning (optional to start the app, but without it extraction
  fails and the flow routes to manual room entry)
- A Supabase project, for persistence/auth (optional — see below)

## Setup

```bash
npm install
cp .env.example .env.local   # fill in what you need — everything is optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app degrades
gracefully with no env vars set: storage falls back to local disk, there's
no persistence, and floor-plan extraction fails (routing to manual room
entry) until `GEMINI_API_KEY` is set.

**Supabase**: if you set the `SUPABASE_*` vars, run `supabase/schema.sql` in
your project's SQL editor first. Bootstrap your first account per the comment
near the end of that file, then promote it to `master` to reach `/console`.

### Re-running the schema on an existing database

`schema.sql` is written to be idempotent — every statement is guarded with
`if not exists` / `drop ... if exists` / an exception-swallowing `do $$`
block — so re-running the whole file is the intended way to pick up schema
changes.

Two cautions, both worth reading before you paste it in:

- **It is the only way RLS changes reach your database.** In particular the
  `project_snapshots` SELECT policy is scoped to `anon_owner = auth.uid()::text`.
  Until that runs, an older database may still carry a permissive read policy,
  which would let any holder of the publishable key — a key that ships in the
  browser bundle by design — read every user's project data.
- **Two `alter table profiles drop column if exists` statements destroy data**
  if those columns are still populated (`assigned_admin_id`, `trial_ends_at`).
  Check before running:

  ```sql
  select count(*) filter (where assigned_admin_id is not null) as assigned,
         count(*) filter (where trial_ends_at   is not null) as trials
  from profiles;
  ```

  Both zero means the drops are no-ops. Otherwise migrate that data first.

**Storage**: no bucket-side setup is needed beyond the credentials. Every
object is written server-side under a `renders/<projectId>/` prefix with a
`randomUUID()` filename, and reads are ownership-checked against the caller's
own projects (`requireOwnedKey`), so no public bucket policy or CORS rule is
required — the app proxies bytes through `/api/render`.

**Before going live**: make sure `DEBUG_PROMPTS` is unset in the production
environment. It prints assembled prompts, including users' free-text notes,
to the server console.

## Project structure

```
├── src/
│   ├── app/            # Next.js App Router — pages + API routes (src/app/api/*)
│   ├── components/     # React components (ui/ = shared primitives)
│   ├── hooks/          # standalone custom hooks
│   └── lib/            # domain logic: pipeline/, ai/, render/, greybox/, supabase/, auth/
├── config/project-types/ # one JSON per project category, incl. room-type list
├── supabase/schema.sql    # full DB schema, idempotent, run manually in the SQL editor
├── docs/
│   ├── PROMPTING-RULES.md      # rulebook for the prompt-construction layer
│   └── VASTOS_REVAMP_PLAN.md   # product plan / build status
├── .env.example
├── context.md            # onboarding doc — start here
├── CLAUDE.md              # deep architecture guide for AI coding assistants
└── AGENTS.md              # hard rules for AI agents working in this repo
```

## Commands

- `npm run dev` — start the app. Floor-plan extraction and generation run
  synchronously in the request.
- `npm run build` / `npm run start` — production build / run it.
- `npm run lint` — ESLint.
- No test runner is configured — `/api/dev-check` (dev-only) is the test suite; see `context.md`.

## Architecture, briefly

There is no separate backend service — Next.js API routes under
`src/app/api/*` run server-side in the same app. A single Gemini vision call
extracts rooms/walls/openings from an uploaded floor plan; a per-room
"greybox" 3D reference image (deterministic locked camera, client-side
WebGL) conditions image generation; one Gemini structured-output call turns
style/reference selections into per-room design guidance; a deterministic
prompt builder (never an LLM) assembles the final prompt sent to
FLUX.2/Nano Banana (via Runware) or Gemini directly. See `CLAUDE.md` for the
full writeup, including model routing and known gaps.

## Env vars

Every variable is optional — see `.env.example` for the full list with
inline comments, and `CLAUDE.md`'s "Env vars" section for exactly what each
stage falls back to when unset. The load-bearing ones:

| Var | Unlocks |
| --- | --- |
| `GEMINI_API_KEY` | Extraction, design planning, design-reference analysis, and the Gemini fallback tier for images/video |
| `RUNWARE_API_KEY` | Routes image/video generation to Runware (FLUX.2, Nano Banana Pro/2, Wan 2.7) instead of direct Gemini |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SECRET_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Auth and persistence |
| `R2_*` or `AWS_*`/`S3_BUCKET` | Durable storage — required for any deploy without a persistent filesystem; local disk is the fallback otherwise |

## Deploying

Pure Next.js + Gemini/Runware API calls — no Python runtime needed. On a
serverless platform (e.g. Vercel), set the R2 or S3 vars: local disk storage
doesn't persist between invocations, so without them uploaded plans and
renders vanish between requests. `/api/generate-walkthrough` requests up to
300s — confirm your platform's actual function-duration ceiling.
