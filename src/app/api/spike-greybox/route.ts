/**
 * THROWAWAY — Phase 0 proof spike. Delete with the rest of the spike files
 * once the gate decision is recorded.
 *
 * Runs the SAME room two ways and returns both images: greybox-conditioned,
 * and today's text-only path. Deliberately bypasses assertAllowed (no auth,
 * no rate limit, no usage metering) — which is exactly why it hard-404s
 * unless SPIKE_ENABLED=1, a flag that lives only in .env.local (gitignored,
 * never deployed).
 */

import { generateImage } from "@/lib/ai/provider";
import { toErrorResponse } from "@/lib/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Identical in both prompts, so the ONLY variable under test is the geometry channel. */
const ROOM_DESCRIPTION =
  "A 13 ft by 15 ft bedroom in a premium contemporary Indian home. Warm neutral palette, " +
  "oak veneer, soft diffused daylight. Photorealistic interior photograph, wide angle, eye level.";

/** Today's path: openings described only in words — the current best we can do. */
const TEXT_ONLY_PROMPT =
  `${ROOM_DESCRIPTION}\n\n` +
  "Real openings, respect them exactly: a door on the south wall (connecting to the drawing room); " +
  "a window on the east wall (exterior); a window on the north wall (exterior).";

/** The proposed path: the reference image IS the geometry. */
const CONDITIONED_PROMPT =
  "The attached image is an untextured grey 3D massing render of this exact room, from the exact " +
  "camera position the output must use.\n\n" +
  "Reproduce it as a photorealistic interior photograph. You MUST preserve, without any deviation:\n" +
  "- the camera position, angle and field of view;\n" +
  "- the room's proportions and every wall position;\n" +
  "- the position, width and height of every door and window opening. A dark full-height panel is a " +
  "doorway; a bright panel is a window. Do not move, resize, add or remove a single opening.\n\n" +
  "Change ONLY surfaces, materials, lighting and furnishing.\n\n" +
  ROOM_DESCRIPTION;

export async function POST(request: Request) {
  if (process.env.SPIKE_ENABLED !== "1") {
    return new Response("Not found", { status: 404 });
  }

  let body: { greyboxDataUri?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.greyboxDataUri?.startsWith("data:image/")) {
    return Response.json({ error: "greyboxDataUri (a data:image/... URI) is required" }, { status: 400 });
  }

  const toUri = (i: { bytes: Buffer; contentType: string }) =>
    `data:${i.contentType};base64,${i.bytes.toString("base64")}`;

  try {
    // Sequential, not Promise.all — a shared 429 from firing both at once
    // would be indistinguishable from the approach itself failing.
    const conditioned = await generateImage(CONDITIONED_PROMPT, undefined, {
      referenceImages: [body.greyboxDataUri],
    });
    const textOnly = await generateImage(TEXT_ONLY_PROMPT);
    return Response.json({ conditioned: toUri(conditioned), textOnly: toUri(textOnly) });
  } catch (e) {
    const { status, body: errBody } = toErrorResponse(e, "Greybox spike");
    return Response.json(errBody, { status });
  }
}
