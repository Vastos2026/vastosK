/**
 * Stores a client-rendered greybox reference PNG (see
 * src/lib/greybox/build-scene.ts + camera.ts, rendered in the browser via
 * GreyboxPreview) and returns its storage key, which the caller saves onto
 * the room (Room.greyboxKey) and later passes to /api/generate-room-image.
 *
 * No AI/provider cost here — this is a plain storage PUT — so no `checkUsage`,
 * just auth + a modest rate limit against abuse.
 */

import { randomUUID } from "node:crypto";
import { putObject } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedProject } from "@/lib/supabase/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const guard = await assertAllowed(request, { rateLimit: { key: "upload-greybox", limit: 60, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: { projectId?: string; dataUri?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  const owned = await requireOwnedProject(guard.id, body.projectId);
  if (owned instanceof Response) return owned;

  const m = /^data:image\/png;base64,(.+)$/.exec(body.dataUri ?? "");
  if (!m) return Response.json({ error: "dataUri must be a base64 image/png data URI" }, { status: 400 });
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_BYTES) return Response.json({ error: "Reference image too large" }, { status: 400 });

  const key = `renders/${body.projectId}/greybox/${randomUUID()}.png`;
  await putObject(key, bytes, "image/png");
  return Response.json({ key });
}
