/**
 * Projects persistence API — mirrors the local-first store to Supabase.
 *
 *   GET    /api/projects?owner=<anonId>     → { projects: Project[] }
 *   PUT    /api/projects   { owner, project } → upsert one snapshot
 *   DELETE /api/projects?id=<appId>          → remove one snapshot
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner) return Response.json({ error: "owner required" }, { status: 400 });
  const projects = await listProjectSnapshots(owner);
  return Response.json({ projects });
}

export async function PUT(request: Request) {
  let body: { owner?: string; project?: Project };
  try {
    body = (await request.json()) as { owner?: string; project?: Project };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.owner || !body.project?.id) {
    return Response.json({ error: "owner and project are required" }, { status: 400 });
  }
  await upsertProjectSnapshot(body.owner, body.project);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteProjectSnapshot(id);
  return Response.json({ ok: true });
}
