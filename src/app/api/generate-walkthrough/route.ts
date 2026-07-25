/**
 * Walkthrough generation — simplified per the 2026-07-26 alignment review
 * (revamp Workstream 8.5, flow step 11). One short Veo clip per approved room
 * image, a single cinematic-zoom-in camera move only (no pan, no invented
 * motion, no orbit/consistency-check machinery), concatenated in the
 * confirmed room order.
 *
 * Every clip is exactly 3 seconds. Veo's shortest supported duration is 4s
 * (no 3s option) — each clip is generated at 4s and trimmed to 3s with
 * ffmpeg before concatenation, so the on-screen requirement is exact
 * regardless of what the model itself supports.
 *
 *   POST /api/generate-walkthrough  { projectId, rooms: [{ id, name, imageKey }] }
 *     → { videoUrl, key }
 *
 * Runs synchronously (matches the plan's existing call-shape for image
 * generation) — for a many-room project this can take minutes; the route's
 * generous `maxDuration` assumes a Node runtime host that allows it. Moving
 * this to an async job is a call-site change if a host's timeout makes that
 * necessary, not a rewrite.
 */

import { randomUUID } from "node:crypto";
import { generateVideo } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/errors";
import { getObject, putObject } from "@/lib/pipeline/storage";
import { concatVideos, ffmpegAvailable, trimVideo } from "@/lib/render/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIP_SECONDS = 3;
// Veo 3.1 only accepts 4 | 6 | 8 — 4 is the closest to 3 and the cheapest.
const VEO_REQUEST_SECONDS = 4;

const ZOOM_PROMPT =
  "A slow, subtle cinematic zoom into the room shown. No panning, no camera rotation, " +
  "no new furniture, people, or objects invented — the room must stay exactly as shown, " +
  "only the camera slowly moves closer.";

interface RoomInput {
  id?: string;
  name?: string;
  imageKey?: string;
}

interface Body {
  projectId?: string;
  rooms?: RoomInput[];
}

export async function POST(request: Request) {
  if (!ffmpegAvailable()) {
    return Response.json({ error: "Video assembly is unavailable on this server (ffmpeg missing)" }, { status: 500 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId, rooms } = body;
  if (!projectId || !rooms?.length) {
    return Response.json({ error: "projectId and at least one room are required" }, { status: 400 });
  }
  for (const r of rooms) {
    if (!r.imageKey || !r.imageKey.startsWith("renders/")) {
      return Response.json({ error: `Invalid imageKey for room "${r.name ?? r.id}"` }, { status: 400 });
    }
  }

  try {
    const clips: Buffer[] = [];
    for (const room of rooms) {
      const imageBytes = await getObject(room.imageKey!);
      const imageDataUri = `data:image/png;base64,${imageBytes.toString("base64")}`;
      const video = await generateVideo(
        imageDataUri,
        ZOOM_PROMPT,
        { durationSeconds: VEO_REQUEST_SECONDS, aspectRatio: "16:9" },
        { projectId },
      );
      const trimmed = await trimVideo(video.bytes, CLIP_SECONDS);
      clips.push(trimmed);
    }

    const joined = clips.length > 1 ? await concatVideos(clips) : clips[0];
    const key = `renders/${projectId}/${randomUUID()}.mp4`;
    await putObject(key, joined, "video/mp4");
    return Response.json({ videoUrl: `/api/render?key=${encodeURIComponent(key)}`, key });
  } catch (e) {
    if (e instanceof ProviderError) {
      const status = e.category === "ValidationError" ? 400 : 502;
      return Response.json({ error: e.message, category: e.category }, { status });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Walkthrough generation failed" },
      { status: 500 },
    );
  }
}
