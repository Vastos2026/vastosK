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
import { supabaseAdmin } from "./server";

const TABLE = "project_snapshots";

/** Best-effort upsert of one project snapshot. Never throws. */
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
