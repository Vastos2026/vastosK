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
below). As of 2026-08-24 it reports **189 passed / 0 failed**. Treat any drop
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

## What the AI actually costs

Two providers, and you have very different visibility into each.

**Runware** (all image and video generation) is prepaid and metered per
generation — that balance is the one that runs out in practice, and running it
out is what produces the `QuotaError` above.

**Google AI Studio / Gemini** handles every text-and-vision-to-text call, and
is billed per token. There are **three Gemini calls per project**:

| # | Call | Shape |
| --- | --- | --- |
| 1 | floor-plan extraction | one ~1280px JPEG + a short prompt, structured JSON out |
| 2 | opening geometry | the same image again + a prompt, structured JSON out |
| 3 | design planning | text only, structured JSON out |

Rough order of magnitude at posted rates, on stated assumptions (roughly 4k
input and 11k output tokens across all three calls, output dominating because
thinking tokens bill at the output rate):

| Landing model | Per project | Per 1,000 projects |
| --- | --- | --- |
| `gemini-2.5-flash` / `gemini-3.5-flash-lite` ($0.30 / $2.50 per 1M) | ~$0.03 | ~$29 |
| `gemini-3.5-flash` ($1.50 / $9.00 per 1M) | ~$0.10 | ~$105 |

Treat these as order-of-magnitude. Google does not itemise how many tokens a
1280px image costs, so the input side rests on an assumption; the output side,
which dominates, is firmer.

**Which model each call runs on** is pinned per purpose in
`src/lib/ai/gemini-models.ts`, overridable by `GEMINI_EXTRACTION_MODEL` /
`GEMINI_PLANNING_MODEL` / `GEMINI_GEOMETRY_MODEL`:

| Call | Model | Output rate / 1M |
| --- | --- | --- |
| extraction | `gemini-3.5-flash-lite` | $2.50 |
| design planning | `gemini-3.5-flash-lite` | $2.50 |
| opening geometry | `gemini-3.5-flash` | $9.00 |

Geometry keeps the strong model on purpose: it returns bounding boxes, spatial
precision is the first thing to go on a cheap model, and its output feeds the
greybox and therefore every render — a regression there damages images
silently instead of failing loudly.

Ladders are **cost-capped**: no fallback may cost more per output token than
the primary it backs up, or making a primary cheap would make every *failure*
more expensive than the success it replaced. `/api/dev-check` asserts it.

Verified live against this project's key on 2026-08-24 — and worth
re-verifying with your own key, because availability is per-account and
being listed on the pricing page does NOT mean your key can call it:

| Model | Result | Latency |
| --- | --- | --- |
| `gemini-3.5-flash-lite` | 200 | 1.3s |
| `gemini-3.1-flash-lite` | 200 | 1.7s |
| `gemini-3.5-flash` | 200 | 10.4s |
| `gemini-3.6-flash` | 200 | 12.9s |
| `gemini-flash-latest` | **429, no quota** | — |
| `gemini-3.7-flash` | **429, no quota** | — |
| `gemini-2.5-flash` | **404, retired** | — |
| `gemini-2.5-flash-lite` | **404, retired** | — |

Two of those matter a lot. `gemini-flash-latest` was the default primary for
all three calls and it 429s, so every call was already spending a round-trip
being told no before falling through to `gemini-3.5-flash` — which is why
pinning geometry to that model changes nothing about what actually executes.
And `gemini-2.5-flash` was in the fallback list while being retired: a dead
tier nobody had noticed.

Three things remain genuinely uncertain and should be checked against the
live account rather than trusted from any document:

- **Free-tier request limits are no longer published.** Google moved per-model
  RPM/RPD/TPM off its public rate-limits page onto the authenticated
  dashboard at `aistudio.google.com/rate-limit`. Any RPD number you find in a
  blog post is unverifiable. So "how many projects per day fit in the free
  tier" cannot be answered from documentation — read it off that dashboard
  with the real key.
- **`gemini-flash-latest` is an alias whose target Google can move without
  telling you.** It was repointed to `gemini-3.5-flash` in May 2026; whether
  the August 2026 `gemini-3.7-flash` release moved it again is not stated
  anywhere official. Since the alias is billed at whatever it resolves to, the
  price of a call can change under a deploy that changed nothing. **This is
  now fixed** — no alias appears anywhere in the codebase, and dev-check fails
  if one reappears. Left here because it is the reason the pinned table above
  exists, and the same trap applies to any model anyone adds later.
- **Billing has no hard spend cap.** Google Cloud budgets raise *alerts*, they
  do not stop the meter. The app's own per-user cap (`profiles.usage_limit_usd`,
  enforced by `assertAllowed({ checkUsage: true })`) is the only actual
  ceiling, and it is per user, not per account.

Before taking paying customers: enable billing on the Google project. The 429s
above are not a rate limit that clears — they are the free tier saying no for
those models — and the app currently works only because two other models still
answer. Also set a budget alert, remembering it alerts and never caps.

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

Last verified 2026-08-24, on `main`, nothing pushed to origin:

- `tsc` clean, `npm run lint` clean, production build clean,
  `/api/dev-check` 189 passed / 0 failed.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- Next 16.3.2, sharp 0.35.3 (single install, libvips 8.18.3), Node 24 local.

Owner actions still outstanding, none of them code:

1. Run `supabase/schema.sql` in the Supabase SQL editor. Until it runs, an
   older database may still carry a permissive `project_snapshots` read
   policy, which would let any holder of the publishable key — a key that
   ships in the browser bundle by design — read every user's project data.
   Read the cautions in `README.md` first; two `drop column` statements in
   that file destroy data if those columns are still populated.
2. Decide the Gemini billing and model-pinning questions in "What the AI
   actually costs" above.
3. Unset `DEBUG_PROMPTS` before going live.
4. `git push origin main`.
