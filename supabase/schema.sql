-- ============================================================================
-- Vastos — database schema
--
-- CURRENT live architecture (see CLAUDE.md for the full writeup):
--   Floor plan upload ─▶ one Gemini Vision call (rooms/types/dims/openings)
--     ─▶ Room Confirmation ─▶ Design Planning (one Gemini call) ─▶ per-room
--     image generation (Runware FLUX.2 primary, Nano Banana 2/Google Gemini
--     fallback chain) ─▶ lasso edit (Nano Banana Pro/2 via Runware, crop +
--     composite) ─▶ Approve ─▶ Walkthrough (Veo image-to-video clips,
--     concatenated + background music mixed in via ffmpeg).
--
-- The app is LOCAL-FIRST: the live source of truth for a project's data is
-- the browser's Zustand store (`src/lib/store.ts`), best-effort mirrored to
-- `project_snapshots` below (JSONB blob per project, scoped by the real
-- Supabase Auth user id). The normalized `projects`/`parse_jobs`/
-- `floor_plans`/`placed_items`/`scenes`/`renders`/`render_versions` tables
-- below describe an OLDER, now-RETIRED pipeline (staged OCR/OpenCV/Gemini
-- extraction feeding a Three.js 3D furniture-placement studio and a FLUX Pro
-- render pipeline) that the live app no longer calls into at all — kept in
-- this file (not dropped) only because dropping tables is a one-way,
-- higher-risk migration than leaving unused ones in place; a genuinely fresh
-- install does not need them for anything the live app does today.
-- `render_jobs` is ALSO legacy for the same reason (verified 2026-07-30: no
-- file under src/ references it or the "use-video-reconcile" hook its own
-- comment describes — that hook doesn't exist in this codebase, a sign this
-- table predates the Workstream 8.5 rendering-pipeline rebuild too). Tables
-- actually read/written by the live app: `project_snapshots`, `profiles`,
-- `generations`, `ai_usage_logs`, `prompt_templates`, `feature_flags`.
--
-- Idempotent: safe to paste into the Supabase SQL Editor and re-run, and
-- safe to run top-to-bottom on a BRAND NEW Supabase project — every table
-- is created in dependency order (a table's foreign-key targets are always
-- created earlier in this file), every `alter table` migration shim below
-- is a genuine no-op on a fresh database (the same shape is already present
-- from the `create table` statement directly above it), and every enum/type
-- creation is wrapped to tolerate re-running. Verified by reading through
-- the full file's creation order end to end (2026-07-30) — no schema change
-- accumulated across this project's sessions was ever left as a
-- Supabase-SQL-editor-only, undocumented step; anything applied by hand
-- during development is reflected here too.
-- ============================================================================

-- Extensions ----------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- Enums ---------------------------------------------------------------------
do $$ begin
  create type property_type as enum ('apartment', 'villa', 'office', 'commercial');
exception when duplicate_object then null; end $$;

-- Project lifecycle state machine (revamp Workstream 3). Single source of
-- truth for a project's stage — the frontend renders off this field instead
-- of ad-hoc booleans (isUploaded/isParsing/etc). See src/lib/projects/state.ts
-- for the transition graph. `add value if not exists` covers upgrading a
-- database created before this revamp; the `create type` covers a fresh one.
do $$ begin
  create type project_status as enum (
    'created', 'floor_plan_uploaded', 'parsing', 'needs_review', 'ready_for_generation',
    'generating_images', 'images_ready', 'editing', 'generating_walkthrough',
    'completed', 'failed'
  );
exception when duplicate_object then null; end $$;
alter type project_status add value if not exists 'created';
alter type project_status add value if not exists 'floor_plan_uploaded';
alter type project_status add value if not exists 'parsing';
alter type project_status add value if not exists 'needs_review';
alter type project_status add value if not exists 'ready_for_generation';
alter type project_status add value if not exists 'generating_images';
alter type project_status add value if not exists 'images_ready';
alter type project_status add value if not exists 'editing';
alter type project_status add value if not exists 'generating_walkthrough';
alter type project_status add value if not exists 'completed';
alter type project_status add value if not exists 'failed';

do $$ begin
  create type render_status as enum ('queued', 'processing', 'completed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type render_view as enum ('front', 'side', 'corner', 'top');
exception when duplicate_object then null; end $$;

-- Parsing pipeline job lifecycle (mirrors JobStatus in src/lib/pipeline/types.ts)
do $$ begin
  create type parse_status as enum ('queued', 'running', 'done', 'failed');
exception when duplicate_object then null; end $$;

-- Pipeline stages (mirrors PipelineStage in src/lib/pipeline/types.ts)
do $$ begin
  create type parse_stage as enum ('upload', 'ocr', 'gemini', 'opencv', 'merge', 'done');
exception when duplicate_object then null; end $$;

-- updated_at trigger helper -------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ============================================================================
-- LEGACY / DORMANT — projects through render_versions below are the retired
-- pipeline's normalized tables (see the file header). Not written or read by
-- the live app (which uses `project_snapshots` further down instead). Left
-- in place, not dropped; skip this whole section if you're just trying to
-- understand how the CURRENT app persists data.
-- ============================================================================

-- ============================================================================
-- projects  — the root entity
-- ============================================================================
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  property_type property_type not null,
  status        project_status not null default 'created',
  -- Single JSONB manifest: Universal Input (design selections + additional
  -- requirements), detected rooms + user edits, the cached Design
  -- Specification from the Design Planning Layer, generation settings, and a
  -- pointer to each room's currently-selected generation. See "AI prompting
  -- architecture" / "Database model" in docs/VASTOS_REVAMP_PLAN.md.
  manifest      jsonb not null default '{}'::jsonb,
  style_id      text,                          -- references a style preset (app-side)
  thumbnail_url text,
  -- Stable, unguessable link for a finished walkthrough (revamp Workstream 11)
  -- distinct from any signed/expiring URL scheme used elsewhere — this one is
  -- meant to be reshared by the builder with their client over time, so it's
  -- long-lived rather than short-lived. Generated lazily (null until the first
  -- "Get shareable link" click) via a random token, never derived from a
  -- guessable value like the project id.
  share_token   text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists projects_owner_idx on projects (owner_id, updated_at desc);

-- Bring an already-created projects table up to date (no-ops if fresh).
alter table projects add column if not exists manifest jsonb not null default '{}'::jsonb;
alter table projects add column if not exists share_token text;
create unique index if not exists projects_share_token_idx on projects (share_token) where share_token is not null;
alter table projects alter column status set default 'created';

drop trigger if exists projects_updated_at on projects;
create trigger projects_updated_at before update on projects
  for each row execute function set_updated_at();

-- ============================================================================
-- parse_jobs  — one row per pipeline run (replaces the in-memory job store).
-- Persists the async Inngest job + every stage's artifact so the client can
-- poll/subscribe and so runs are reproducible/auditable.
--   OCR        → ocr           (OcrResult json)
--   Gemini     → semantics     (SemanticPlan: rooms + dimensions)
--   OpenCV     → raw_geometry  (pixel-space walls/doors/windows/rooms)
--   Merge      → merged        (feet-space FloorPlan)
-- ============================================================================
create table if not exists parse_jobs (
  id               uuid primary key default gen_random_uuid(),
  -- project_id is nullable + we also keep app_project_id: the local-first app
  -- uses string ids ("proj_…") that aren't yet rows in `projects`, so we don't
  -- force the FK. Populate project_id once projects are synced to Supabase.
  project_id       uuid references projects (id) on delete cascade,
  app_project_id   text,                            -- local-first project id (no FK yet)
  status           parse_status not null default 'queued',
  stage            parse_stage  not null default 'upload',
  progress         numeric not null default 0,      -- 0..1
  message          text,
  -- AWS S3 (or local/supabase) location of the uploaded plan
  storage_key      text,
  storage_backend  text,                            -- 's3' | 'local' | 'supabase'
  file_name        text,
  mime_type        text,
  -- per-stage artifacts
  ocr              jsonb,                            -- { tokens, rawText, source }
  semantics        jsonb,                            -- { rooms[], longestSideFt, scale, source }
  raw_geometry     jsonb,                            -- OpenCV pixel-space detection
  merged           jsonb,                            -- merged feet-space FloorPlan
  -- resolved scalars
  confidence       numeric,                          -- 0..1 detector confidence
  scale            numeric,                          -- feet per pixel
  calibrated       boolean,                          -- true = real measurement, not fallback
  rooms_named      int,                              -- boxes that got a Gemini name
  stage_ms         jsonb,                            -- per-stage timings
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists parse_jobs_project_idx on parse_jobs (project_id, created_at desc);

drop trigger if exists parse_jobs_updated_at on parse_jobs;
create trigger parse_jobs_updated_at before update on parse_jobs
  for each row execute function set_updated_at();

-- Bring an already-created parse_jobs table up to date (no-ops if fresh).
alter table parse_jobs alter column project_id drop not null;
alter table parse_jobs add column if not exists app_project_id text;

-- ============================================================================
-- floor_plans  — the durable, merged result the 2D editor & 3D builder read.
-- `geometry` holds the final feet-space FloorPlan; `raw_geometry` the pixel
-- OpenCV output; `ocr`/`semantics` the upstream artifacts for traceability.
-- ============================================================================
create table if not exists floor_plans (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  parse_job_id  uuid references parse_jobs (id) on delete set null,
  file_name     text not null,
  storage_path  text,                          -- S3 / Supabase Storage key
  storage_backend text,
  preview_url   text,
  plan_width    numeric,                       -- feet
  plan_height   numeric,                       -- feet
  scale         numeric,                       -- feet per pixel used
  calibrated    boolean,
  source        text not null default 'merged',-- 'merged' | 'opencv' | 'sample' | 'manual'
  confidence    numeric,                       -- 0–1 detector confidence
  rooms_named   int,
  ocr           jsonb,                         -- OCR tokens (traceability)
  semantics     jsonb,                         -- Gemini rooms + dimensions
  raw_geometry  jsonb,                         -- pixel-space OpenCV output
  geometry      jsonb not null default '{"rooms":[],"doors":[],"walls":[],"windows":[]}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists floor_plans_project_idx on floor_plans (project_id);

drop trigger if exists floor_plans_updated_at on floor_plans;
create trigger floor_plans_updated_at before update on floor_plans
  for each row execute function set_updated_at();

-- ============================================================================
-- placed_items  — furniture in the 3D scene. `ghost = true` marks a Gemini
-- suggestion that the user hasn't accepted yet ("Furniture Suggestions").
-- ============================================================================
create table if not exists placed_items (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  catalog_id  text not null,
  name        text not null,
  room_id     text,                            -- app-side room id within geometry
  x           numeric not null,                -- feet
  y           numeric not null,
  rotation    numeric not null default 0,      -- degrees
  w           numeric not null,                -- footprint feet
  d           numeric not null,
  h           numeric not null,
  color       text,
  ghost       boolean not null default false,  -- AI-suggested, not yet accepted
  created_at  timestamptz not null default now()
);
create index if not exists placed_items_project_idx on placed_items (project_id);

-- ============================================================================
-- scenes  — an assembled 3D scene (Three.js) + the screenshot that seeds a
-- render. Camera/items captured so a render is reproducible from its scene.
-- ============================================================================
create table if not exists scenes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  floor_plan_id uuid references floor_plans (id) on delete set null,
  style_id      text,
  name          text,
  camera        jsonb,                          -- { position, target, fov } for Three.js
  items         jsonb,                          -- snapshot of placed items at capture
  capture_url   text,                           -- 3D screenshot (feeds prompt + FLUX)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists scenes_project_idx on scenes (project_id, created_at desc);

drop trigger if exists scenes_updated_at on scenes;
create trigger scenes_updated_at before update on scenes
  for each row execute function set_updated_at();

-- ============================================================================
-- renders  — one photorealistic render request: capture → Gemini prompt →
-- FLUX Pro → image. `render_versions` then tracks the edit chain.
-- ============================================================================
create table if not exists renders (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  scene_id    uuid references scenes (id) on delete set null,
  view        render_view not null,
  style_id    text not null,
  status      render_status not null default 'queued',
  progress    int not null default 0,          -- 0–100
  capture_url text,                             -- source 3D screenshot
  prompt      text,                             -- Gemini-built FLUX prompt
  model       text not null default 'flux-pro', -- generation model
  seed        bigint,
  image_url   text,                             -- final render in storage
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists renders_project_idx on renders (project_id, created_at desc);

drop trigger if exists renders_updated_at on renders;
create trigger renders_updated_at before update on renders
  for each row execute function set_updated_at();

-- ============================================================================
-- render_versions  — the iterative edit chain on a render:
--   kind 'initial'    → the first FLUX Pro output
--   kind 'lasso_edit' → masked region re-generated (mask_url)
--   kind 'refine'     → Gemini-refined prompt re-run (model 'nano-banana')
-- The newest row is the "Final Render".
-- ============================================================================
create table if not exists render_versions (
  id          uuid primary key default gen_random_uuid(),
  render_id   uuid not null references renders (id) on delete cascade,
  label       text not null,
  kind        text not null default 'initial', -- 'initial' | 'lasso_edit' | 'refine'
  note        text,
  style_id    text,                            -- style snapshot for style-switch
  prompt      text,                            -- refined prompt for this iteration
  model       text,                            -- 'flux-pro' | 'nano-banana' | …
  image_url   text,
  mask_url    text,                            -- lasso mask used for this edit
  created_at  timestamptz not null default now()
);
create index if not exists render_versions_render_idx on render_versions (render_id, created_at);

-- ============================================================================
-- Row-Level Security — every table is scoped to the project owner.
-- ============================================================================
alter table projects        enable row level security;
alter table parse_jobs      enable row level security;
alter table floor_plans     enable row level security;
alter table placed_items    enable row level security;
alter table scenes          enable row level security;
alter table renders         enable row level security;
alter table render_versions enable row level security;

-- projects: owner-only
drop policy if exists "own projects" on projects;
create policy "own projects" on projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Helper macro pattern: child rows are accessible when their parent project
-- belongs to the current user.
drop policy if exists "own parse_jobs" on parse_jobs;
create policy "own parse_jobs" on parse_jobs
  for all using (exists (select 1 from projects p where p.id = parse_jobs.project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = parse_jobs.project_id and p.owner_id = auth.uid()));

drop policy if exists "own floor_plans" on floor_plans;
create policy "own floor_plans" on floor_plans
  for all using (exists (select 1 from projects p where p.id = floor_plans.project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = floor_plans.project_id and p.owner_id = auth.uid()));

drop policy if exists "own placed_items" on placed_items;
create policy "own placed_items" on placed_items
  for all using (exists (select 1 from projects p where p.id = placed_items.project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = placed_items.project_id and p.owner_id = auth.uid()));

drop policy if exists "own scenes" on scenes;
create policy "own scenes" on scenes
  for all using (exists (select 1 from projects p where p.id = scenes.project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = scenes.project_id and p.owner_id = auth.uid()));

drop policy if exists "own renders" on renders;
create policy "own renders" on renders
  for all using (exists (select 1 from projects p where p.id = renders.project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p where p.id = renders.project_id and p.owner_id = auth.uid()));

drop policy if exists "own render_versions" on render_versions;
create policy "own render_versions" on render_versions
  for all using (exists (
    select 1 from renders r join projects p on p.id = r.project_id
    where r.id = render_versions.render_id and p.owner_id = auth.uid()))
  with check (exists (
    select 1 from renders r join projects p on p.id = r.project_id
    where r.id = render_versions.render_id and p.owner_id = auth.uid()));

-- ============================================================================
-- profiles — role/status metadata for each Supabase Auth user.
--
-- Identity + password hashing + sessions are handled entirely by Supabase Auth
-- (auth.users) — this table only carries the app-specific fields the revamp
-- plan calls for: role (user/master), status, trial tracking. Only two roles
-- on purpose — `user` (clients) and `master` (Vastos team, full access, no
-- subdivision between team members). Clients never self-register: accounts
-- are created via the Admin API (auth.admin.createUser), which fires the
-- trigger below to create the matching profile row automatically.
-- ============================================================================
do $$ begin
  create type user_role as enum ('user', 'master');
exception when duplicate_object then null; end $$;

-- Migration for a database created before roles were simplified from
-- user/admin/master down to user/master: recreate the enum without 'admin'
-- (reassigning any existing 'admin' rows to 'user' first). No-op on a fresh
-- database, where the `create type` above already defines the 2-value shape.
-- FRAGILE: this block references `profiles` before that table is created
-- further down this file — safe today only because the outer `if exists`
-- guard is always false on a database that never had 'admin' in the enum
-- (i.e. every fresh install), so the body never actually runs. Do not move
-- this block out of that guard, and do not move it above without also
-- moving `create table profiles` earlier.
do $$
begin
  if exists (
    select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'user_role' and e.enumlabel = 'admin'
  ) then
    alter table profiles alter column role drop default;
    alter table profiles alter column role type text;
    update profiles set role = 'user' where role = 'admin';
    drop type user_role;
    create type user_role as enum ('user', 'master');
    alter table profiles alter column role type user_role using role::user_role;
    alter table profiles alter column role set default 'user';
  end if;
end $$;

do $$ begin
  -- 'trial_ended' is a legacy value, never produced or checked by the app
  -- anymore (trial tracking was removed entirely, per explicit product
  -- decision) — left in the enum since dropping an enum value is a riskier
  -- migration than just never using it again.
  create type user_status as enum ('active', 'trial_ended', 'suspended', 'pending_approval');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  display_name     text,
  role             user_role not null default 'user',
  status           user_status not null default 'active',
  -- Billing (admin-managed): billing_cycle + next_billing_date together
  -- define a recurring schedule — next_billing_date is a ONE-TIME ANCHOR the
  -- admin sets once (must be strictly in the future, see console/actions.ts's
  -- updateBilling), not something re-entered every renewal. Every reader
  -- (profile page's reminder, the console's display, the usage-limit period
  -- calc) rolls it forward through src/lib/billing.ts's
  -- computeCurrentBillingDate to get the genuinely-active next billing date —
  -- nothing in the database itself auto-advances the stored value, and
  -- nothing needs to.
  billing_cycle      text,          -- e.g. 'Monthly' | 'Quarterly' | 'Yearly' — free label, not enforced
  next_billing_date  timestamptz,   -- the billing anchor date (see above)
  -- Usage cap (admin-managed, new): total USD this user may spend on AI
  -- generation within the current billing period (billing_cycle +
  -- next_billing_date define the period window). Null = unlimited. Checked
  -- against the sum of ai_usage_logs.estimated_cost for the period so far —
  -- see src/lib/api-guard.ts.
  usage_limit_usd  numeric,
  -- Scheduled stop (admin-managed, new): a future date this account stops
  -- working entirely — checked on every request (src/lib/auth/session.ts),
  -- not a cron job, so it takes effect on the account's very next request
  -- once the date passes. Null = no scheduled stop. Distinct from `status =
  -- 'suspended'`, which is immediate and manual.
  scheduled_stop_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists profiles_role_idx on profiles (role);
-- Console's user list orders by created_at desc (src/app/console/page.tsx).
create index if not exists profiles_created_at_idx on profiles (created_at desc);

-- Bring an already-created profiles table up to date (no-ops if fresh).
alter table profiles add column if not exists billing_cycle text;
alter table profiles add column if not exists next_billing_date timestamptz;
alter table profiles add column if not exists usage_limit_usd numeric;
alter table profiles add column if not exists scheduled_stop_at timestamptz;
-- Trial tracking removed entirely (product decision) — drop the column.
alter table profiles drop column if exists trial_ends_at;

-- Drop the admin-tier assignment field from the earlier 3-role design.
-- No-op if this database never had it (fresh installs never create it).
drop index if exists profiles_assigned_admin_idx;
alter table profiles drop column if exists assigned_admin_id;

drop trigger if exists profiles_updated_at on profiles;
create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- Auto-create a profile row whenever a new Supabase Auth user is created.
-- `role` can be passed via the Admin API's user_metadata at creation time
-- (defaults to a plain 'user' otherwise).
create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'user')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_auth_user();

-- RLS: everyone can read/update only their own profile. Broader access (the
-- admin console's user list) goes through the service-role key server-side,
-- same pattern the rest of this codebase already uses for privileged reads —
-- avoids a recursive "admins can see all profiles" RLS policy entirely.
alter table profiles enable row level security;
drop policy if exists "own profile select" on profiles;
create policy "own profile select" on profiles
  for select using (id = auth.uid());
drop policy if exists "own profile update" on profiles;
create policy "own profile update" on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- The RLS policy above is ROW-scoped only ("you may update your own row") —
-- Postgres RLS can't restrict which COLUMNS a policy allows, so on its own
-- it lets a signed-in user set role='master' (or unsuspend themselves, or
-- grant themselves a billing plan) on their OWN row via a direct Supabase
-- REST call, completely bypassing this app's requireRole("master") checks
-- (found in a 2026-07-27 code review). This trigger closes that: any update
-- NOT made by the service role (i.e. not `supabaseAdmin()`, which is the
-- only client that ever legitimately changes these fields — see
-- src/app/console/actions.ts) silently reverts the privileged columns back
-- to their prior value, leaving harmless self-service fields (display_name)
-- untouched.
create or replace function protect_privileged_profile_columns()
returns trigger language plpgsql as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.role := old.role;
    new.status := old.status;
    new.billing_cycle := old.billing_cycle;
    new.next_billing_date := old.next_billing_date;
    new.usage_limit_usd := old.usage_limit_usd;
    new.scheduled_stop_at := old.scheduled_stop_at;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileged_columns on profiles;
create trigger profiles_protect_privileged_columns before update on profiles
  for each row execute function protect_privileged_profile_columns();

-- Bootstrapping the first account: create a user in the Supabase dashboard
-- (Authentication → Users → Add user), then promote it once via SQL editor:
--   update profiles set role = 'master' where id = '<the new user's uuid>';

-- ============================================================================
-- project_snapshots — local-first persistence bridge (still not the
-- normalized `projects` table above — the frontend isn't rebuilt onto that
-- yet). Mirrors the whole client Project as JSONB so projects survive
-- restarts and sync across tabs/devices. Writes go through the server
-- (service-role key, bypasses RLS) via /api/projects, which now (2026-07-27)
-- requires auth and checks ownership in code — see that route's comment.
--
-- `anon_owner` originally held a random per-browser localStorage id from
-- before real auth existed; it now holds the real Supabase Auth user id
-- (`api/projects/route.ts` writes `assertAllowed`'s `guard.id` here). Rows
-- written under the old per-browser scheme won't match any real user id and
-- are effectively orphaned — acceptable during early testing, not migrated.
-- ============================================================================
create table if not exists project_snapshots (
  app_id      text primary key,                 -- the app's "proj_…" id
  anon_owner  text not null,                     -- real Supabase Auth user id (uuid, stored as text)
  name        text,
  status      text,
  data        jsonb not null,                    -- full Project (floorPlan, items, renders)
  -- Public share token (new): lets /s/[token] resolve straight to this row's
  -- `data` (which already holds the walkthrough video key + approved room
  -- image keys) without needing the mostly-empty `projects` table wired up
  -- first. Minted by /api/share-link, read by /s/[token]'s server component
  -- via supabaseAdmin() (bypasses RLS — this is the one place a totally
  -- unauthenticated caller is allowed to read a slice of this data, scoped
  -- to exactly the one row matching an unguessable token).
  share_token text unique,
  updated_at  timestamptz not null default now()
);
create index if not exists project_snapshots_owner_idx on project_snapshots (anon_owner, updated_at desc);
alter table project_snapshots add column if not exists share_token text;
create unique index if not exists project_snapshots_share_token_idx on project_snapshots (share_token) where share_token is not null;

drop trigger if exists project_snapshots_updated_at on project_snapshots;
create trigger project_snapshots_updated_at before update on project_snapshots
  for each row execute function set_updated_at();

-- Anon SELECT stays open so the browser's Realtime subscription can work:
-- `src/lib/supabase/browser.ts`'s client is a bare anon client with no
-- session/cookies, so `auth.uid()` is never available to scope this policy
-- by user identity — writes are the actual security boundary (server-side,
-- ownership-checked, see above), reachable only server-side. This IS a real
-- residual gap: a client that talks to Supabase's Realtime API directly
-- (bypassing this app's own JS) could read any user's project data. Closing
-- it fully needs `browser.ts` switched to a cookie-aware client
-- (`@supabase/ssr`'s `createBrowserClient`) so this policy can require
-- `anon_owner = auth.uid()::text` — flagged, not done in this pass.
alter table project_snapshots enable row level security;
drop policy if exists "anon read snapshots" on project_snapshots;
create policy "anon read snapshots" on project_snapshots for select using (true);

do $$ begin
  alter publication supabase_realtime add table project_snapshots;
exception when duplicate_object then null; end $$;

-- ============================================================================
-- LEGACY / DORMANT — render_jobs was a durable registry for the OLD render
-- pipeline's long-running jobs. Verified 2026-07-30: nothing under src/
-- references this table or the "use-video-reconcile" hook this comment
-- block originally described (that hook doesn't exist in this codebase).
-- The CURRENT walkthrough flow (`/api/generate-walkthrough`) runs
-- synchronously and stores its result directly via `generations` instead.
-- Kept, not dropped, same reasoning as the other legacy tables above.
-- ============================================================================
create table if not exists render_jobs (
  id              text primary key,                    -- client-generated render id ("rnd_…")
  app_project_id  text,                                -- local-first project id ("proj_…")
  kind            text not null default 'video',
  status          text not null default 'processing',  -- 'processing' | 'done' | 'failed'
  result          jsonb,                               -- { key, videoUrl, frames[] }
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists render_jobs_project_idx on render_jobs (app_project_id, updated_at desc);

drop trigger if exists render_jobs_updated_at on render_jobs;
create trigger render_jobs_updated_at before update on render_jobs
  for each row execute function set_updated_at();

alter table render_jobs enable row level security;

-- ============================================================================
-- ai_usage_logs — one row per AI provider call, written by src/lib/ai/provider.ts.
-- Cost/analytics data an admin aggregates (Workstream 9's spend cards); distinct
-- from `generations` (Workstream 11), which holds product-facing output artifacts
-- a user browses/restores. Server-only writes (service role); a user can read
-- their own rows (a Profile page usage summary can query this directly instead
-- of a separate aggregate table).
-- ============================================================================
create table if not exists ai_usage_logs (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users (id) on delete set null,
  -- text, not uuid+FK: every real caller passes the local-first string id
  -- ("proj_...", not a UUID) since most projects have no row in `projects`
  -- yet — a uuid-typed FK column could never be satisfied, so every insert
  -- with a project id silently failed (found + fixed 2026-07-27).
  project_id             text,
  feature                text not null,   -- 'ocr' | 'semantic' | 'image' | 'edit' | 'video'
  provider               text not null default 'google',
  model                  text,
  success                boolean not null,
  duration_ms            integer,
  estimated_cost         numeric,
  error_category         text,            -- ValidationError | AiProviderError | StorageError | TimeoutError | InternalError
  pipeline_version       text,
  system_prompt_version  text,
  planning_prompt_version text,
  prompt_builder_version text,
  design_spec_version    text,
  post_processing_version text,
  created_at             timestamptz not null default now()
);
create index if not exists ai_usage_logs_user_idx on ai_usage_logs (user_id, created_at desc);
create index if not exists ai_usage_logs_project_idx on ai_usage_logs (project_id, created_at desc);

-- Migration for a database created before this fix: project_id was
-- uuid+FK-to-projects, which no real insert could ever satisfy. No-op on a
-- fresh database, where the `create table` above already has the right type.
-- Drops "own ai_usage_logs" first defensively (see the identical, confirmed
-- failure on `generations` below: ALTER COLUMN TYPE fails outright if any
-- policy's USING/CHECK clause depends on the column, even indirectly) —
-- a no-op if this table's policy never referenced project_id, harmless
-- either way since it's recreated unconditionally right after.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'ai_usage_logs' and column_name = 'project_id' and data_type = 'uuid'
  ) then
    drop policy if exists "own ai_usage_logs" on ai_usage_logs;
    alter table ai_usage_logs drop constraint if exists ai_usage_logs_project_id_fkey;
    alter table ai_usage_logs alter column project_id type text using project_id::text;
  end if;
end $$;

alter table ai_usage_logs enable row level security;
drop policy if exists "own ai_usage_logs" on ai_usage_logs;
create policy "own ai_usage_logs" on ai_usage_logs
  for select using (user_id = auth.uid());

-- ============================================================================
-- prompt_templates — versioned, admin-editable prompting layer (Workstream 5).
-- Three independently-versioned types (see "AI prompting architecture" in
-- docs/VASTOS_REVAMP_PLAN.md): 'system' (fixed scaffolding rules), 'planning'
-- (one row per project category, holds that category's planner persona),
-- 'builder' (the Prompt Builder's wording snippets). Only the published row
-- for a given (type, category) feeds live generation, so drafts are safe to
-- edit without affecting production. Server-only access (service role) —
-- src/lib/ai/prompting/templates.ts falls back to hardcoded defaults (kept in
-- sync with the seed rows below) when unconfigured or nothing is published
-- yet, so generation works before anyone touches the admin console.
-- ============================================================================
do $$ begin
  create type prompt_template_type as enum ('system', 'planning', 'builder');
exception when duplicate_object then null; end $$;

create table if not exists prompt_templates (
  id          uuid primary key default gen_random_uuid(),
  type        prompt_template_type not null,
  category    text,   -- set for 'planning' rows only; null for 'system'/'builder'
  version     int not null default 1,
  body        jsonb not null,
  published   boolean not null default false,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists prompt_templates_lookup_idx on prompt_templates (type, category, published);

alter table prompt_templates enable row level security;

-- Seed the MVP templates on a fresh install (no-ops once any row of that
-- type/category exists, so re-running this file never clobbers admin edits).
insert into prompt_templates (type, category, version, body, published)
select 'system', null, 1,
  '{"rules":"Photorealistic interior-design magazine photograph. Realistic materials, lighting, shadows and reflections. No people, no text or watermarks, no visible logos. Render exactly the furniture and fixtures implied by the brief below - do not invent unrelated objects."}'::jsonb,
  true
where not exists (select 1 from prompt_templates where type = 'system');

insert into prompt_templates (type, category, version, body, published)
select 'planning', c.category, 1, c.persona::jsonb, true
from (values
  ('Residential', '{"persona":"Think like an experienced interior designer creating a family home: prioritise comfort, warmth and everyday liveability alongside the chosen style."}'),
  ('Apartment',   '{"persona":"Think like an interior designer working within an apartment''s real space constraints: prioritise efficient layouts and multi-purpose furniture while still honouring the chosen style."}'),
  ('Commercial',  '{"persona":"Think like a commercial interior designer working on an office or workspace: prioritise productivity, circulation and a professional client-facing impression alongside the chosen style."}'),
  ('Custom',      '{"persona":"Think like a specialist interior designer. The project brief below names the exact business type in its project.subcategory field (for example a dental clinic, a restaurant, a retail store, a temple, or any other business the client named). Treat that exact named type as your primary design driver, not a generic interior, and prioritise the functional, safety and customer-experience needs specific to that named business alongside the chosen style."}')
) as c(category, persona)
where not exists (select 1 from prompt_templates where type = 'planning' and category = c.category);

-- The insert above is a no-op once a 'planning'/'Custom' row already exists (e.g. on a
-- database seeded before this wording change), so re-running this file wouldn't update
-- an already-applied deployment. Directly update the published row's body to bring
-- existing installs in line with the current Custom persona wording (keep this in sync
-- with DEFAULT_PLANNING_PERSONA.Custom in src/lib/ai/prompting/templates.ts).
update prompt_templates
set body = '{"persona":"Think like a specialist interior designer. The project brief below names the exact business type in its project.subcategory field (for example a dental clinic, a restaurant, a retail store, a temple, or any other business the client named). Treat that exact named type as your primary design driver, not a generic interior, and prioritise the functional, safety and customer-experience needs specific to that named business alongside the chosen style."}'::jsonb
where type = 'planning' and category = 'Custom' and published = true;

insert into prompt_templates (type, category, version, body, published)
select 'builder', null, 1,
  '{"intro":"Generate one photorealistic interior photograph of the following room.","cameraPrefix":"Camera guidance:","negativePrefix":"Do not include:"}'::jsonb,
  true
where not exists (select 1 from prompt_templates where type = 'builder');

-- ============================================================================
-- generations — version-history table (Workstream 11). Every "Generate",
-- "Generate more", lasso edit, and walkthrough video call inserts a new row
-- here rather than overwriting one — distinct from `ai_usage_logs` above,
-- which holds cost/analytics data an admin aggregates; this table holds the
-- product-facing output artifacts a user browses/restores (same underlying
-- events, different consumers). Written best-effort, server-side, via the
-- service role — a write failure here must never fail the generation call
-- itself, same "best-effort" contract as ai_usage_logs.
-- ============================================================================
create table if not exists generations (
  id                      uuid primary key default gen_random_uuid(),
  -- text, not uuid+FK to `projects`: every real caller passes the
  -- local-first string id ("proj_...", not a UUID), which a uuid-typed FK
  -- could never satisfy — every insert with a project id silently failed
  -- (found + fixed 2026-07-27). RLS below is scoped by user_id instead of
  -- the (no-longer-meaningful) projects-ownership join this used to use.
  project_id              text not null,
  user_id                 uuid references auth.users (id) on delete set null,
  room_key                text,            -- room id/name, or null for a project-level (walkthrough) generation
  type                    text not null,   -- 'image' | 'edit' | 'video'
  storage_url             text not null,
  pipeline_version        text,
  system_prompt_version   text,
  planning_prompt_version text,
  prompt_builder_version  text,
  design_spec_version     text,
  model_used              text,
  created_at              timestamptz not null default now()
);
create index if not exists generations_project_idx on generations (project_id, created_at desc);

-- Migration for a database created before this fix. No-op on a fresh
-- database, where the `create table` above already has the right shape.
-- MUST run before the `user_id` index below — an existing table's
-- `create table if not exists` above is a no-op, so `user_id` doesn't exist
-- yet until this `add column` runs.
--
-- Drops "own generations" first: a database old enough to still have a
-- uuid-typed project_id also predates the RLS rescope to user_id (see the
-- policy below) and still has the OLD policy, whose USING clause reads
-- project_id directly — Postgres refuses to ALTER COLUMN TYPE on a column a
-- policy depends on ("cannot alter type of a column used in a policy
-- definition"). Safe to drop unconditionally here: it's recreated
-- unconditionally right after this block regardless of which branch ran.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'generations' and column_name = 'project_id' and data_type = 'uuid'
  ) then
    drop policy if exists "own generations" on generations;
    alter table generations drop constraint if exists generations_project_id_fkey;
    alter table generations alter column project_id type text using project_id::text;
  end if;
end $$;
alter table generations add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists generations_user_idx on generations (user_id, created_at desc);

alter table generations enable row level security;
drop policy if exists "own generations" on generations;
create policy "own generations" on generations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- feature_flags — lightweight on/off toggles (Workstream 7), for anything
-- that should be flippable without a redeploy. Deliberately minimal per the
-- plan's CTO review: no rollout percentages, no user targeting, no admin UI
-- yet — flip a row directly in the SQL editor (or a basic list in the console
-- later). Server-only reads; src/lib/feature-flags.ts falls back to a
-- caller-supplied default when unconfigured or the key doesn't exist yet.
-- ============================================================================
create table if not exists feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now()
);

drop trigger if exists feature_flags_updated_at on feature_flags;
create trigger feature_flags_updated_at before update on feature_flags
  for each row execute function set_updated_at();

alter table feature_flags enable row level security;

-- ============================================================================
-- provider_settings — single-row, admin-configurable choice of which AI
-- provider is primary for image generation and image editing (each
-- independently switchable between 'runware' (FLUX.2 / Nano Banana Pro) and
-- 'gemini' (direct Google Gemini API) from the console's Analytics page,
-- src/lib/settings/provider-settings.ts). Whichever isn't primary becomes the
-- fallback the existing 3-tier chain in src/lib/ai/provider.ts falls through
-- to. Video is deliberately NOT here — it stays a fixed Wan/Runware display
-- with no admin toggle, governed by the VIDEO_PROVIDER env var as before.
-- Server-only access (service role), same pattern as feature_flags; a
-- missing row or an unconfigured Supabase project falls back to the
-- env-var-derived default in code, never breaks a generation call.
-- ============================================================================
create table if not exists provider_settings (
  id                  text primary key default 'default',
  image_gen_primary   text not null default 'runware',  -- 'runware' | 'gemini'
  image_edit_primary  text not null default 'runware',
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null
);

drop trigger if exists provider_settings_updated_at on provider_settings;
create trigger provider_settings_updated_at before update on provider_settings
  for each row execute function set_updated_at();

alter table provider_settings enable row level security;

-- ============================================================================
-- Realtime — push live progress to the browser (pipeline + render status).
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table parse_jobs;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table renders;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table render_versions;
exception when duplicate_object then null; end $$;
