-- ============================================================================
-- Vasto Studios — database schema (full production flow)
--
--   Floor Plan ─▶ OCR ─▶ Gemini Flash ─▶ OpenCV ─▶ Merge
--      (upload)   (text)  (rooms+dims)  (geometry) (semantics+geometry)
--        │
--        ▼  3D House (Three.js) ─▶ Furniture (Gemini) ─▶ 3D Scene
--        ▼  Screenshot ─▶ Prompt (Gemini) ─▶ FLUX Pro ─▶ Photorealistic render
--        ▼  Lasso edit ─▶ Gemini refine ─▶ Nano Banana ─▶ Final render
--
-- Stage → storage map:
--   Floor Plan / OCR / Gemini / OpenCV / Merge .... parse_jobs (+ floor_plans = final)
--   3D House + 3D Scene ............................ scenes
--   Furniture suggestions ......................... placed_items (ghost = AI)
--   Screenshot capture ............................ scenes.capture_url / renders.capture_url
--   Prompt gen + FLUX Pro + render ................ renders
--   Lasso edit / refine / Nano Banana / final ..... render_versions
--
-- Idempotent: safe to paste into the Supabase SQL Editor and re-run.
-- ============================================================================

-- Extensions ----------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- Enums ---------------------------------------------------------------------
do $$ begin
  create type property_type as enum ('apartment', 'villa', 'office', 'commercial');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum ('draft', 'parsing', 'parsed', 'designing', 'rendered');
exception when duplicate_object then null; end $$;

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
-- projects  — the root entity
-- ============================================================================
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  property_type property_type not null,
  status        project_status not null default 'draft',
  style_id      text,                          -- references a style preset (app-side)
  thumbnail_url text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists projects_owner_idx on projects (owner_id, updated_at desc);

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

-- Bring an already-created floor_plans table up to date (no-ops if present).
alter table floor_plans add column if not exists parse_job_id   uuid references parse_jobs (id) on delete set null;
alter table floor_plans add column if not exists storage_backend text;
alter table floor_plans add column if not exists calibrated      boolean;
alter table floor_plans add column if not exists rooms_named     int;
alter table floor_plans add column if not exists ocr             jsonb;
alter table floor_plans add column if not exists semantics       jsonb;

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

alter table renders add column if not exists scene_id    uuid references scenes (id) on delete set null;
alter table renders add column if not exists capture_url text;
alter table renders add column if not exists model       text not null default 'flux-pro';
alter table renders add column if not exists seed        bigint;

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

alter table render_versions add column if not exists kind   text not null default 'initial';
alter table render_versions add column if not exists prompt text;
alter table render_versions add column if not exists model  text;

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
-- project_snapshots — PRE-AUTH persistence bridge.
-- The app is local-first (zustand) and auth isn't wired yet, so the normalized
-- tables above (which require auth.users) can't be written to. This table mirrors
-- the whole client Project as JSONB, scoped by an anonymous device id, so projects
-- survive restarts and sync across tabs/devices. Writes go through the server
-- (service-role key, bypasses RLS); migrate into the normalized tables once auth
-- lands.
-- ============================================================================
create table if not exists project_snapshots (
  app_id      text primary key,                 -- the app's "proj_…" id
  anon_owner  text not null,                     -- localStorage device id (pre-auth)
  name        text,
  status      text,
  data        jsonb not null,                    -- full Project (floorPlan, items, renders)
  updated_at  timestamptz not null default now()
);
create index if not exists project_snapshots_owner_idx on project_snapshots (anon_owner, updated_at desc);

drop trigger if exists project_snapshots_updated_at on project_snapshots;
create trigger project_snapshots_updated_at before update on project_snapshots
  for each row execute function set_updated_at();

-- Pre-auth access: allow anon SELECT so the browser can hydrate + subscribe via
-- Realtime; writes happen server-side with the service role. NOTE: this exposes
-- snapshots to any anon client — replace with owner-scoped RLS once auth is added.
alter table project_snapshots enable row level security;
drop policy if exists "anon read snapshots" on project_snapshots;
create policy "anon read snapshots" on project_snapshots for select using (true);

do $$ begin
  alter publication supabase_realtime add table project_snapshots;
exception when duplicate_object then null; end $$;

-- ============================================================================
-- render_jobs — durable registry for long-running render jobs (the ~100s Veo
-- walkthrough). The mp4 + stills land in S3 either way; this row maps the
-- client's job id to those keys so a page reset, local-store sync race, or
-- dev-server restart can't orphan a PAID generation. The client reclaims stuck
-- "processing" walkthrough records from here on mount (use-video-reconcile).
-- Server-only access (service role bypasses RLS); no anon policies on purpose.
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
