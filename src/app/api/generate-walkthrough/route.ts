/**
 * Walkthrough generation — simplified per the 2026-07-26 alignment review
 * (revamp Workstream 8.5, flow step 11). One short clip per approved room
 * image, concatenated in the confirmed room order, with no orbit or
 * consistency-check machinery.
 *
 * The camera move is now chosen PER ROOM rather than being one fixed zoom for
 * every clip — a push-in, a pan, or a tilt, picked from that room's own
 * geometry by `render/walkthrough-camera.ts`. Read that file before changing
 * anything here: a clip is generated from a single still image, so a move
 * that swings unrendered area into frame is asking the model to invent
 * geometry, and the selection rules exist to decide when a room can afford
 * one. A room whose geometry is unavailable always gets the safe push-in.
 *
 * Every clip is 4 seconds — the shortest duration either model sells.
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
import { selectWalkthroughMove, walkthroughPrompt } from "@/lib/render/walkthrough-camera";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The whole generated clip is kept now. 4s is already the shortest either
 * model will sell (Veo accepts 4 | 6 | 8; Wan 2.7 is asked for the same), so
 * trimming to 3s was throwing away a quarter of every clip that had already
 * been paid for — and a pan or tilt needs the extra second to read as
 * deliberate rather than clipped. `trimVideo` still runs: it is what
 * normalises each clip to libx264/yuv420p before concat.
 *
 * Note concatVideos then plays every clip at 1.25x (see ffmpeg.ts), so 4s of
 * generated motion reaches the viewer as 3.2s.
 */
const CLIP_SECONDS = 4;
// Veo 3.1 only accepts 4 | 6 | 8 — 4 is the shortest and the cheapest.
const VEO_REQUEST_SECONDS = 4;

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
    // Geometry for the per-room camera move. Only available when Supabase is
    // configured — `requireOwnedProject` returns null otherwise — so every
    // clip falls back to the always-safe push-in without it, matching this
    // app's "works, degraded, without Supabase" contract rather than failing.
    const roomGeometry = new Map((owned?.floorPlan?.rooms ?? []).map((r) => [r.id, r]));

    const clips = await Promise.all(
      rooms.map(async (room, index) => {
        // Chosen server-side from the room's own geometry, never sent by the
        // client: which way a camera may safely move is a fact about what the
        // greybox actually rendered, the same reasoning that makes the server
        // re-derive the opening ledger instead of trusting a client count.
        const geometry = room.id ? roomGeometry.get(room.id) : undefined;
        const move = geometry ? selectWalkthroughMove(geometry, index).move : "push_in";
        const imageBytes = await getObject(room.imageKey!);
        const imageDataUri = `data:image/png;base64,${imageBytes.toString("base64")}`;
        const video = await generateVideo(
          imageDataUri,
          walkthroughPrompt(move),
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
    // Awaited, not fire-and-forget — see generate-room-image/route.ts's identical comment:
    // /api/render's ownership check reads this row to authorize a just-created asset
    // immediately, instead of waiting on the client's debounced project-snapshot sync.
    await recordGeneration({ projectId, userId: guard.id, roomKey: null, type: "video", storageUrl: videoUrl });
    return Response.json({ videoUrl, key });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Walkthrough generation");
    return Response.json(body, { status });
  }
}
