# Console Analytics + Model Switcher — Design

2026-07-30. Scope: (1) make `supabase/schema.sql` cleanly re-runnable/fresh-DB-safe (already true functionally — cosmetic cleanup only), (2) remove the usage-analytics UI from the standard user's Profile page and from the console's flat page, (3) add a new admin-only `/console/analytics` page with spend/provider/model dashboards sourced from `ai_usage_logs`, (4) add an admin model-switcher (Image Generation / Image Editing / Video) on that same page.

## 1. Schema cleanup

No functional bug exists — verified by manual read-through end to end: every enum is `do $$ ... exception when duplicate_object$$`-guarded, every table/index/trigger uses `if not exists`/`or replace`, and all migration shims are genuine no-ops on a fresh database. Changes are cosmetic robustness only:
- Remove redundant `alter table ... add column if not exists` lines that just re-declare a column already present in the `create table` block directly above it (found in `floor_plans`, `renders`, `render_versions`).
- Add a comment on the `user_role` 'admin'→'user' migration block (currently unreachable on a fresh DB only because its outer `if exists (...)` guard is always false there) flagging it as fragile if ever moved out of that guard.
- Add the new `provider_settings` table (below).

## 2. `provider_settings` table

```sql
create table if not exists provider_settings (
  id text primary key default 'default',
  image_gen_primary  text not null default 'runware',  -- 'runware' | 'gemini'
  image_edit_primary text not null default 'runware',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
```

Single row (`id = 'default'`), upserted. Video is intentionally absent from this table — the video capability stays a fixed Wan display in the UI with no admin toggle, and its provider selection remains exactly as it works today (`VIDEO_PROVIDER` env var, untouched by this change). RLS: enabled, no policies (service-role-only access, same pattern as `feature_flags`).

## 3. Provider-selection logic

New `src/lib/settings/provider-settings.ts`:
- `getProviderPrimary(capability: "image_gen" | "image_edit"): Promise<"runware" | "gemini">` — reads the `provider_settings` row via `supabaseAdmin()`. Falls back to the current env-var-derived default (`IMAGE_PROVIDER`, defaulting to `"runware"` when `RUNWARE_API_KEY` is set) when Supabase is unconfigured, the row doesn't exist yet, or the query errors — a DB hiccup must never break a generation call.
- `setProviderPrimary(capability, value, updatedBy)` — upsert; called only from a new `master`-gated Server Action.

`src/lib/ai/provider.ts`: `resolveProvider` becomes `resolveProvider(capability, envValue)` — async, checks the DB setting first via the new module, falls back to the existing env-var logic unchanged. `generateImage` passes `"image_gen"`, `editImage` passes `"image_edit"`. `generateVideo` is untouched (still reads `process.env.VIDEO_PROVIDER` directly, no DB involvement). The 3-tier fallback chains inside `generateImage`/`editImage` are unchanged — only where `primary` comes from changes.

## 4. Removing the old analytics UI

Deleted: `src/components/usage-chart.tsx`, `src/components/usage-chart-client.tsx`, `src/lib/usage-stats.ts`, `src/app/console/console-usage-chart.tsx`, `src/lib/console/render-stats.ts`.

Edited: `src/app/profile/page.tsx` (remove the `<UsageChart />` import + render — standard users see no usage/analytics data anywhere, by design), `src/app/console/page.tsx` (remove the Analytics section; Users list + status stat bar stay, unrelated).

Untouched: `ai_usage_logs`/`generations` writes (`src/lib/ai/usage-log.ts`, `provider.ts`'s `instrumented`), and the billing/usage-limit enforcement path (`src/lib/api-guard.ts`, `src/lib/billing.ts`) — those are independent of the display code being removed.

## 5. Console structure

- `src/app/console/layout.tsx` — new. Shared header + a "Users | Analytics" tab bar for `/console` and `/console/analytics`. First sub-route this app has had under `/console`.
- `src/app/console/page.tsx` — trimmed to just the Users view (stat bar + `ConsoleUsers`).
- `src/app/console/analytics/page.tsx` — new, `requireRole("master")`-gated server component.

## 6. Analytics data

New `src/lib/console/usage-analytics.ts`, admin-scoped (uses the `supabaseAdmin()` client the console already builds, cross-user by design — same rationale as the old `render-stats.ts`):

- One query: `ai_usage_logs` — `select user_id, feature, provider, model, estimated_cost, success, created_at` — over a 12-month window (`buildTimeWindow(12, "month")`'s `since` boundary), fetched once.
- Aggregated in JS into three shapes from that single fetch (no second round-trip):
  1. **Spend-over-time**: both a 30-day daily bucket series and a 12-month monthly bucket series (`buildTimeWindow` for each), `sum(estimated_cost)` per bucket. A client-side Day/Month toggle picks which one to render — both are already computed server-side.
  2. **Provider & model breakdown**: for the currently-toggled window, total spend + request count grouped by `model`, plus a `runware` vs `google` split.
  3. **Per-user table**: reuses the existing `listAllAuthUsers` + `profiles` join (moved from `console/page.tsx`, still used there for the Users tab too), adding spend / request count / success rate columns for the toggled window, sortable by spend.

**Freshness**: no polling, no webhook, no external API call — `ai_usage_logs` is written synchronously by every AI call (`provider.ts`'s `instrumented`), so a fresh page load is always current. A manual "Refresh" button (`router.refresh()`) covers an admin watching the page stay open; no auto-poll timer, since sub-minute freshness isn't a real requirement for this dashboard and polling would add load for no benefit. (This was an explicit design choice over integrating Runware's Management API: `ai_usage_logs` already has provider/model/cost/timestamp for every call — Runware's own account API would only cover Runware spend, not Gemini, and would need its own sync strategy for no real benefit here.)

## 7. Analytics UI

Recharts (new dependency — no charting library exists in this app today; previous charts were hand-rolled SVG, all being deleted). Layout/color/typography pulled from the `dataviz` and `frontend-design` skills when building, so it reads as one coherent dashboard rather than default-Recharts styling, in the app's existing dark theme.

- Spend-over-time: line/area chart, Day/Month toggle switches the underlying series (client component, data pre-fetched for both).
- Provider & model breakdown: donut (runware vs google split) + sorted horizontal bar list (spend per model), for the toggled window.
- Per-user table: sortable by spend, columns for display name/email, request count, spend, success rate.

## 8. Model switcher (same page)

Three cards:
- **Image Generation** / **Image Editing** (independent settings): two options each — "Flux 2 (Runware)" and "Gemini Flash" — one tagged **In use**, the other **Fallback**. The fallback card has a "Make active" button → Server Action `setProviderPrimary` → upserts `provider_settings` → `revalidatePath("/console/analytics")`. Takes effect immediately on the next generation call anywhere in the app (no caching layer).
- **Video**: read-only row, "Wan 2.7 — Active", no control.

Server Action lives in a new `src/app/console/analytics/actions.ts` (`"use server"`, independently re-checks `requireRole("master")`, matching every other console action's pattern).

## 9. Verification

No test runner in this repo (per `CLAUDE.md`). Verification is `tsc --noEmit` + `npm run lint` + `npm run build` clean, plus a manual walkthrough in the browser preview: `/console/analytics` renders with real `ai_usage_logs` data (or an empty state if none exists yet), Day/Month toggle works, the model-switcher buttons flip the DB row and the UI reflects it after refresh, and `/profile` no longer shows any usage UI.
