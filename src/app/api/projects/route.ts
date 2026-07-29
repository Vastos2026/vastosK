/**
 * Projects persistence API — mirrors the local-first store to Supabase.
 *
 *   GET    /api/projects     → { projects: Project[] }  (the caller's own)
 *   PUT    /api/projects   { project } → upsert one snapshot, owned by the caller
 *   DELETE /api/projects?id=<appId>    → remove one snapshot, only if the caller owns it
 *
 * Ownership is the AUTHENTICATED user's id (`assertAllowed`'s `guard.id`),
 * never a client-supplied value — this used to accept an arbitrary `owner`
 * query/body param with no auth check at all, so any caller (not even
 * logged in) could read, overwrite, or delete any other user's projects by
 * guessing/supplying their `owner`/`id`. The `anon_owner` column now holds
 * the real Supabase Auth user id going forward, not the old pre-auth
 * localStorage device id — snapshots written before this fix (under the old
 * per-browser anon id) won't match and will appear as a fresh, empty list,
 * same as this codebase's existing "best-effort, never breaks the app"
 * degrade pattern for this table.
 *
 * All handlers degrade gracefully when Supabase isn't configured (the store +
 * localStorage stay authoritative), so the app works with or without a DB.
 */

import {
  deleteProjectSnapshot,
  listProjectSnapshots,
  upsertProjectSnapshot,
} from "@/lib/supabase/projects";
import type { Project } from "@/lib/types";
import { assertAllowed } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await assertAllowed(request, { checkOrigin: false });
  if (guard instanceof Response) return guard;
  const projects = await listProjectSnapshots(guard.id);
  return Response.json({ projects });
}

export async function PUT(request: Request) {
  const guard = await assertAllowed(request);
  if (guard instanceof Response) return guard;

  let body: { project?: Project };
  try {
    body = (await request.json()) as { project?: Project };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.project?.id) {
    return Response.json({ error: "project is required" }, { status: 400 });
  }
  await upsertProjectSnapshot(guard.id, body.project);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const guard = await assertAllowed(request);
  if (guard instanceof Response) return guard;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteProjectSnapshot(id, guard.id);
  return Response.json({ ok: true });
}
