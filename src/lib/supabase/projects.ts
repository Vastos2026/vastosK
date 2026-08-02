/**
 * Supabase persistence for the local-first project store (`project_snapshots`).
 *
 * Mirrors each client `Project` as a JSONB snapshot scoped by an anonymous
 * device id (pre-auth bridge — see supabase/schema.sql). Every call is
 * best-effort: it never throws, so a database hiccup can't break the app (the
 * zustand store + localStorage remain the live source of truth). Migrate into
 * the normalized tables once auth is wired.
 */

import type { Project } from "@/lib/types";
import { allProjectStorageKeys } from "@/lib/projects/approved-rooms";
import { supabaseAdmin } from "./server";

const TABLE = "project_snapshots";

/** Best-effort upsert of one project snapshot. Never throws.
 * Ownership on an existing row must be checked by the CALLER first (see
 * `getSnapshotOwner` below) — this function itself has no way to refuse an
 * upsert, since it runs on the service-role client (bypasses RLS) and
 * `onConflict: "app_id"` will happily overwrite ANY existing row, including
 * reassigning `anon_owner` to a different user (found in review: this was
 * previously the one write path in this file with no ownership gate at all,
 * unlike `deleteProjectSnapshot` below, which already scoped itself to the
 * owner). */
export async function upsertProjectSnapshot(owner: string, project: Project): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.from(TABLE).upsert(
    {
      app_id: project.id,
      anon_owner: owner,
      name: project.name,
      status: project.status,
      data: project,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "app_id" },
  );
  if (error) console.warn("[projects] upsert failed:", error.message);
}

/**
 * The current owner of an existing `project_snapshots` row, or null if no
 * row exists yet with this `appId` (a brand-new project, safe to create) —
 * distinct from `getOwnedProjectSnapshot`, which can't tell "doesn't exist"
 * apart from "exists but owned by someone else" (both return null there).
 * Callers use this to guard `upsertProjectSnapshot`'s upsert-on-conflict
 * path: an `appId` that already belongs to a DIFFERENT owner must be
 * rejected before the upsert ever runs, not silently overwritten.
 */
export async function getSnapshotOwner(appId: string): Promise<string | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db.from(TABLE).select("anon_owner").eq("app_id", appId).maybeSingle();
  if (error || !data) return null;
  return (data as { anon_owner: string }).anon_owner;
}

/** Best-effort list of an owner's project snapshots, newest first. */
export async function listProjectSnapshots(owner: string): Promise<Project[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data, error } = await db
    .from(TABLE)
    .select("data")
    .eq("anon_owner", owner)
    .order("updated_at", { ascending: false });
  if (error) {
    console.warn("[projects] list failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => (r as { data: Project }).data).filter(Boolean);
}

/**
 * Best-effort delete of one project snapshot, scoped to `owner` — without
 * this check, any caller who knows/guesses an `app_id` could delete another
 * user's snapshot (this table's writes go through the service-role key,
 * which bypasses RLS entirely, so ownership MUST be checked here in code).
 * Never throws.
 */
export async function deleteProjectSnapshot(appId: string, owner: string): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.from(TABLE).delete().eq("app_id", appId).eq("anon_owner", owner);
  if (error) console.warn("[projects] delete failed:", error.message);
}

/**
 * Looks up a project snapshot by its public share token (`/s/[token]`) — the
 * one deliberately-unauthenticated read path in the app, scoped to exactly
 * the single row matching an unguessable random token (minted by
 * /api/share-link). Uses `supabaseAdmin()` (service-role, bypasses RLS) since
 * this is called with no session at all. Returns null on any miss/failure —
 * callers render a "link isn't valid" state rather than treating this as an
 * error.
 */
export async function getProjectSnapshotByShareToken(token: string): Promise<{ data: Project } | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db
    .from(TABLE)
    .select("data")
    .eq("share_token", token)
    .maybeSingle();
  if (error || !data) return null;
  return data as { data: Project };
}

/**
 * Looks up a project snapshot by id, scoped to `owner` — used by routes that
 * accept client-resolved storage keys (e.g. /api/export-pdf) and need to
 * verify both that the caller owns this project AND that the keys they sent
 * actually belong to it (see approved-rooms.ts's `allowedProjectStorageKeys`),
 * rather than trusting an arbitrary key from the request body outright.
 * Returns null if unconfigured, not found, or not owned by `owner` — callers
 * should treat all three the same way (reject), not distinguish them.
 */
export async function getOwnedProjectSnapshot(appId: string, owner: string): Promise<Project | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db
    .from(TABLE)
    .select("data, anon_owner")
    .eq("app_id", appId)
    .maybeSingle();
  if (error || !data) return null;
  if (data.anon_owner !== owner) return null;
  return (data as { data: Project }).data;
}

/**
 * Whether `key` is a storage key any of `owner`'s own projects has ever
 * referenced (see `allProjectStorageKeys`) — used by GET /api/render, which
 * only receives a bare storage key (no `projectId`) and previously served
 * any key to any authenticated caller with zero ownership check at all. Scans
 * across all of the owner's snapshots rather than trying to parse a project
 * id back out of the key, since keys come in two different unrelated shapes
 * (`renders/<projectId>/<uuid>.<ext>` vs `plans/<uuid>/<name>`, the latter
 * not even containing a project id). Returns false on any failure — callers
 * should treat that as "not proven owned," same reject-by-default posture as
 * `getOwnedProjectSnapshot`.
 */
export async function isOwnedStorageKey(owner: string, key: string): Promise<boolean> {
  const projects = await listProjectSnapshots(owner);
  return projects.some((p) => allProjectStorageKeys(p).has(key));
}

/**
 * Shared ownership guard for routes that take a client-supplied `projectId`
 * (`/api/generate-room-image`, `/api/edit-room-image`, `/api/generate-walkthrough`,
 * `/api/share-link`) — previously each route re-typed the same
 * "if configured, fetch, 403 if not owned" shape independently (found in
 * review: the wording had already started drifting between copies). Returns:
 *   - `null` when Supabase isn't configured — no persistence layer, no
 *     cross-user data to leak, caller should skip the check entirely (same
 *     degrade-to-allow contract every route in this app already has).
 *   - a ready-to-return 403 `Response` when the project doesn't exist or
 *     isn't owned by `userId`.
 *   - the resolved `Project` when ownership is confirmed.
 * Callers: `const owned = await requireOwnedProject(...); if (owned instanceof
 * Response) return owned; if (owned) { ...key checks against owned... }`.
 */
export async function requireOwnedProject(
  userId: string,
  projectId: string,
): Promise<Project | Response | null> {
  if (!supabaseAdmin()) return null;
  const project = await getOwnedProjectSnapshot(projectId, userId);
  if (!project) {
    return Response.json({ error: "Project not found or not owned by you" }, { status: 403 });
  }
  return project;
}

/**
 * Whether a `generations` row exists proving `userId` owns this exact
 * `renders/...` key — written SYNCHRONOUSLY, in the same request that
 * created the image (see `recordGeneration`, `/api/generate-room-image`),
 * unlike the project snapshot below which only updates via a client-side
 * sync that's debounced 800ms then makes its own round-trip. Checking this
 * FIRST closes a real race: an `<img>` requesting a just-generated image
 * used to 403 (browsers don't auto-retry a failed `<img>`, so it just sat
 * broken) whenever it beat that debounced sync — found via a direct user
 * report of images intermittently failing to load / appearing to hang.
 */
async function isRecordedGeneration(userId: string, projectId: string, key: string): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return false;
  const storageUrl = `/api/render?key=${encodeURIComponent(key)}`;
  const { data } = await db
    .from("generations")
    .select("id")
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("storage_url", storageUrl)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Same immediate-ownership check as `isRecordedGeneration`, for `plans/...`
 * keys — which, unlike `renders/<projectId>/...`, have no project id embedded
 * in the key itself (see this file's header comment), so there's no
 * `projectId` to filter on here; `user_id` + the exact `storage_url` (which
 * embeds a random uuid) is enough. Written synchronously by
 * `/api/parse-plan` in the same request that uploads the plan image — see
 * that route's comment for the race this closes.
 */
async function isRecordedPlanUpload(userId: string, key: string): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return false;
  const storageUrl = `/api/render?key=${encodeURIComponent(key)}`;
  const { data } = await db
    .from("generations")
    .select("id")
    .eq("user_id", userId)
    .eq("type", "plan")
    .eq("storage_url", storageUrl)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Shared ownership guard for `/api/render`, which only ever receives a bare
 * storage `key` (no `projectId`). For the common `renders/<projectId>/...`
 * shape, checks the immediate `generations` record first (see
 * `isRecordedGeneration`), then falls back to a single targeted
 * `getOwnedProjectSnapshot` lookup instead of `isOwnedStorageKey`'s full scan
 * of every one of the caller's projects — this route is the hottest in the
 * app (every thumbnail/version/floor-plan preview/video goes through it),
 * and the broad scan re-fetches every project's full JSONB blob on every
 * single image request (found in review). `plans/<uuid>/...` keys have no
 * embedded project id, so there's no targeted lookup available for them —
 * checks the immediate `generations` record first (see
 * `isRecordedPlanUpload`), then falls back to `isOwnedStorageKey`'s broad
 * scan for uploads from before that immediate record existed.
 */
export async function requireOwnedKey(userId: string, key: string): Promise<true | Response> {
  if (!supabaseAdmin()) return true;
  const renderMatch = key.match(/^renders\/([^/]+)\//);
  if (renderMatch) {
    const projectId = renderMatch[1];
    if (await isRecordedGeneration(userId, projectId, key)) return true;
    const project = await getOwnedProjectSnapshot(projectId, userId);
    if (project && allProjectStorageKeys(project).has(key)) return true;
    return Response.json({ error: "Not found" }, { status: 403 });
  }
  if (key.startsWith("plans/") && (await isRecordedPlanUpload(userId, key))) return true;
  const owned = await isOwnedStorageKey(userId, key);
  return owned ? true : Response.json({ error: "Not found" }, { status: 403 });
}
