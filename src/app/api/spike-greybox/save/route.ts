/**
 * THROWAWAY — Phase 0 proof spike. Delete with the rest of the spike files
 * once the gate decision is recorded.
 *
 * Writes a data-URI image to the scratchpad so the greybox render and the two
 * generated outputs can be inspected as real files (they otherwise only exist
 * in the page's React state and die with the tab).
 *
 * Gated on SPIKE_ENABLED, which lives only in .env.local (gitignored, never
 * deployed) — this writes to an arbitrary-ish path and must never be live.
 */

import { writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUT_DIR =
  "C:/Users/varoo/AppData/Local/Temp/claude/P--vastos-interior-main/a71f1220-0822-4253-bbaf-3f42d8281d69/scratchpad";

export async function POST(request: Request) {
  if (process.env.SPIKE_ENABLED !== "1") {
    return new Response("Not found", { status: 404 });
  }

  let body: { name?: string; dataUri?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body.dataUri ?? "");
  if (!m) return Response.json({ error: "dataUri must be a base64 png/jpeg data URI" }, { status: 400 });
  if (!body.name) return Response.json({ error: "name is required" }, { status: 400 });

  // basename() keeps a caller-supplied name from escaping OUT_DIR.
  const file = join(OUT_DIR, basename(body.name));
  await writeFile(file, Buffer.from(m[2], "base64"));
  return Response.json({ written: file, bytes: m[2].length });
}
