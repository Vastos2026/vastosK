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
import { toErrorResponse } from "@/lib/ai/errors";
import { getObject, putObject } from "@/lib/pipeline/storage";
import { addBackgroundMusic, concatVideos, ffmpegAvailable, trimVideo } from "@/lib/render/ffmpeg";
import { recordGeneration } from "@/lib/supabase/generations";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedProject } from "@/lib/supabase/projects";
import { allowedProjectStorageKeys } from "@/lib/projects/approved-rooms";

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
  // Video generation is the most expensive AI call in the app (one Veo call
  // per room), so this gets the tightest cap of the AI-triggering routes.
  const guard = await assertAllowed(request, {
    rateLimit: { key: "generate-walkthrough", limit: 5, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

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
  // Mirrors the Walkthrough page's UI rule (a single-room "walkthrough" isn't
  // a real one) — enforced here too, not just client-side, since this route
  // is reachable independently of that page (found in review: a direct call
  // could still produce a 1-room video).
  if (!projectId || !rooms || rooms.length < 2) {
    return Response.json({ error: "projectId and at least 2 rooms are required" }, { status: 400 });
  }
  for (const r of rooms) {
    if (!r.imageKey || !r.imageKey.startsWith("renders/")) {
      return Response.json({ error: `Invalid imageKey for room "${r.name ?? r.id}"` }, { status: 400 });
    }
  }

  // Every imageKey above is client-supplied and only checked for a
  // `renders/` prefix — without this check, an authenticated caller could
  // submit ANY other project's real image keys and have them read + run
  // through paid Veo generation under an attacker-controlled `projectId`
  // (a cross-tenant data/cost leak found in review). Mirrors export-pdf's
  // ownership check: when Supabase is configured, require the caller to
  // actually own `projectId` AND every room's imageKey to belong to that
  // project's own APPROVED room generations (the narrower
  // `allowedProjectStorageKeys`, not the broader `allProjectStorageKeys` —
  // this route's whole purpose is one clip per approved room image, so
  // validating against anything broader would let an unapproved/stale
  // image sneak in). When Supabase isn't configured, there's no
  // persistence layer at all (no other users' data to leak) — degrade to
  // allowing it, matching this app's existing "best-effort, works without
  // Supabase" contract.
  const owned = await requireOwnedProject(guard.id, projectId);
  if (owned instanceof Response) return owned;
  if (owned) {
    const allowedKeys = allowedProjectStorageKeys(owned);
    for (const r of rooms) {
      if (!allowedKeys.has(r.imageKey!)) {
        return Response.json({ error: "One or more room images don't belong to this project" }, { status: 403 });
      }
    }
  }

  try {
    // Independent per-room clips — generated concurrently instead of one at a
    // time, since Veo generation is by far the slowest step and each room's
    // request doesn't depend on any other's. Order is preserved (Promise.all
    // resolves in input order) so concatVideos still joins rooms correctly.
    const clips = await Promise.all(
      rooms.map(async (room) => {
        const imageBytes = await getObject(room.imageKey!);
        const imageDataUri = `data:image/png;base64,${imageBytes.toString("base64")}`;
        const video = await generateVideo(
          imageDataUri,
          ZOOM_PROMPT,
          { durationSeconds: VEO_REQUEST_SECONDS, aspectRatio: "16:9" },
          { projectId, userId: guard.id },
        );
        return trimVideo(video.bytes, CLIP_SECONDS);
      }),
    );

    const joined = clips.length > 1 ? await concatVideos(clips) : clips[0];
    const withMusic = await addBackgroundMusic(joined);
    const key = `renders/${projectId}/${randomUUID()}.mp4`;
    await putObject(key, withMusic, "video/mp4");
    const videoUrl = `/api/render?key=${encodeURIComponent(key)}`;
    void recordGeneration({ projectId, userId: guard.id, roomKey: null, type: "video", storageUrl: videoUrl });
    return Response.json({ videoUrl, key });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Walkthrough generation");
    return Response.json(body, { status });
  }
}
