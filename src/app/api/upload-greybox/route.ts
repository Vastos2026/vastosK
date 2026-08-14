/**
 * Stores a client-rendered greybox reference PNG (see
 * src/lib/greybox/build-scene.ts + camera.ts, rendered in the browser via
 * GreyboxPreview) and returns its storage key, which the caller saves onto
 * the room (Room.greyboxKey) and later passes to /api/generate-room-image.
 *
 * Also stores the section 7.1 Pass B mask rendered through the same camera
 * (see render-mask.ts) and derives a `GreyboxLedger` (door/window counts)
 * from it via `countOpenings` — the mask, not `room.placedOpenings`, is
 * ground truth for what the locked camera can actually see. The ledger
 * returned here is for immediate UI display only: /api/generate-room-image
 * (Task 13) re-derives its own ledger from the stored mask rather than
 * trusting this response, so a stale or tampered client value can't leak
 * into the prompt.
 *
 * Optionally also stores a THIRD image, the annotated reference (same
 * conditioning render with numbered furniture badges drawn on — see
 * greybox/render-annotated.ts), when the room had furniture to badge.
 * `annotatedDataUri`/`annotatedKey` are absent, not merely empty, for a
 * furniture-free room or one whose furniture all falls outside the locked
 * camera's frame — render-mask.ts's renderGreyboxBundle produces no
 * annotated image at all in that case rather than a wasted duplicate. Stored
 * under the same key's `-annotated` suffix, alongside `-mask`, so it shares
 * the `renders/<projectId>/greybox/` prefix `isOwnedGreyboxKey`
 * (src/lib/supabase/projects.ts) authorises by.
 *
 * No AI/provider cost here — this is a plain storage PUT — so no `checkUsage`,
 * just auth + a modest rate limit against abuse.
 */

import { randomUUID } from "node:crypto";
import { putObject } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { requireOwnedProject } from "@/lib/supabase/projects";
import { countOpenings } from "@/lib/greybox/count-openings";
import type { ProjectedOpening } from "@/lib/greybox/render-mask";
import type { GreyboxLedger } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

interface Body {
  projectId?: string;
  dataUri?: string;
  maskDataUri?: string;
  /** Optional third reference image — see this route's header comment. */
  annotatedDataUri?: string;
  projected?: ProjectedOpening[];
}

const PNG_RE = /^data:image\/png;base64,(.+)$/;

function decodePng(dataUri: string | undefined, label: string): Buffer | Response {
  const m = PNG_RE.exec(dataUri ?? "");
  if (!m) return Response.json({ error: `${label} must be a base64 image/png data URI` }, { status: 400 });
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_BYTES) return Response.json({ error: `${label} too large` }, { status: 400 });
  return bytes;
}

export async function POST(request: Request) {
  const guard = await assertAllowed(request, { rateLimit: { key: "upload-greybox", limit: 60, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  const owned = await requireOwnedProject(guard.id, body.projectId);
  if (owned instanceof Response) return owned;

  const image = decodePng(body.dataUri, "dataUri");
  if (image instanceof Response) return image;
  const maskBytes = decodePng(body.maskDataUri, "maskDataUri");
  if (maskBytes instanceof Response) return maskBytes;
  // Genuinely optional, unlike the two above — decodePng is only called when
  // the client actually sent one, so a furniture-free room's request (no
  // `annotatedDataUri` key at all) never fails a "must be a data URI" check
  // for a field it was never supposed to send.
  let annotatedBytes: Buffer | undefined;
  if (body.annotatedDataUri) {
    const decoded = decodePng(body.annotatedDataUri, "annotatedDataUri");
    if (decoded instanceof Response) return decoded;
    annotatedBytes = decoded;
  }

  // Decode + count BEFORE either putObject call below. sharp only actually
  // parses the PNG here — base64-valid-but-not-a-real-PNG bytes pass
  // decodePng's regex and size check untouched — so counting first means a
  // corrupt mask is rejected with a clean 400 and nothing gets persisted,
  // instead of surfacing as a generic 500 with two orphaned objects already
  // sitting in storage. Derived here (rather than deferred to the caller)
  // because the server already holds the bytes; /api/generate-room-image
  // re-derives its own ledger from the stored mask rather than trusting this
  // response, so this value is for immediate UI display only.
  let ledger: GreyboxLedger;
  try {
    ledger = await countOpenings(maskBytes, body.projected ?? []);
  } catch {
    return Response.json({ error: "maskDataUri is not a readable PNG" }, { status: 400 });
  }

  const key = `renders/${body.projectId}/greybox/${randomUUID()}.png`;
  const maskKey = `${key}-mask`;
  // Same prefix as `key`/`maskKey` (`renders/<projectId>/greybox/...`),
  // required by `isOwnedGreyboxKey` — a key stored anywhere else is rejected
  // with a 403 the moment /api/generate-room-image tries to read it back.
  const annotatedKey = annotatedBytes ? `${key}-annotated` : undefined;
  await putObject(key, image, "image/png");
  await putObject(maskKey, maskBytes, "image/png");
  if (annotatedBytes) await putObject(annotatedKey!, annotatedBytes, "image/png");

  return Response.json({ key, maskKey, annotatedKey, ledger });
}
