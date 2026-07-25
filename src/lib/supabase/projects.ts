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

/** Best-effort delete of one project snapshot. Never throws. */
export async function deleteProjectSnapshot(appId: string): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.from(TABLE).delete().eq("app_id", appId);
  if (error) console.warn("[projects] delete failed:", error.message);
}
