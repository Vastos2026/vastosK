/**
 * Google Veo (Gemini API) image-to-video client — raw fetch, no SDK.
 *
 * Powers the room "orbit" video: a single front photo → a smooth camera pan that
 * reveals the room's other walls, from which the UI extracts the Front / Left /
 * Right / Back stills. Because the whole clip is ONE coherent generation, every
 * extracted frame is the SAME room — which is how the multi-angle views finally
 * stay consistent (2D image gen could not guarantee that).
 *
 * Veo is a LONG-RUNNING operation: POST `:predictLongRunning` to start, poll the
 * returned operation until `done`, then download the produced mp4 from the files
 * URI in the response. Returns `null` when unconfigured / unavailable / failed, so
 * the caller can surface a clear error instead of fabricating a result.
 *
 * Verified 2026-06-28 against the live API: `veo-3.0-fast-generate-001`, ~50s,
 * response at `generateVideoResponse.generatedSamples[0].video.uri`.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Candidate models, tried in order until one accepts the request. The QUALITY
// model leads: the fast variant is markedly worse at keeping the room spatially
// consistent through the walkthrough pan (furniture drifting/morphing mid-turn).
// GEMINI_VIDEO_MODEL pins a specific slug ahead of the defaults.
//
// The veo-3.0 slugs were RETIRED and now 404 ("is not found for API version
// v1beta") — that outage was why walkthroughs stopped generating. These are the
// models ListModels actually reports for this key (verified 2026-07-05).
const VEO_MODELS = [
  ...(process.env.GEMINI_VIDEO_MODEL?.trim() ? [process.env.GEMINI_VIDEO_MODEL.trim()] : []),
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-lite-generate-preview",
];

export interface GeneratedVideo {
  bytes: Buffer;
  contentType: string;
  /**
   * True only when a `lastFrameDataUri` was requested AND the API accepted the
   * frames-to-video interpolation (the clip is pinned at BOTH ends). When a last
   * frame was requested but this is false, the clip is grounded at its START only
   * — it will NOT land on the next side, so the orbit seam drifts. The caller uses
   * this to warn/reject instead of silently shipping a drifting walkthrough.
   */
  lastFrameHonored: boolean;
}

export function veoConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

/** Strip a `data:<mime>;base64,` prefix → raw base64 + mime. */
function parseDataUri(uri: string): { data: string; mime: string } {
  const m = uri.match(/^data:([^;]+);base64,([\s\S]*)$/);
  return m ? { mime: m[1], data: m[2] } : { mime: "image/png", data: uri };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate a video that pans around the room shown in `imageDataUri`, grounded by
 * `prompt`. Resolves to the mp4 bytes, or `null` on any failure.
 *
 * `lastFrameDataUri` (Veo 3.1 "frames to video"): the clip INTERPOLATES from
 * `imageDataUri` (first frame) to this image (last frame). This is what makes the
 * segmented 360° walkthrough non-hallucinatory — both endpoints of every segment
 * are real, grounded photos of the SAME room, so Veo only has to fill the turn
 * between them instead of inventing the unseen 270°.
 *
 * The REST field placement for lastFrame differs across API surfaces (instance
 * vs parameters), so the request adapts: instance-level first, then
 * parameters-level, then (with a loud warn) no interpolation at all — a segment
 * that at least STARTS on a grounded frame still beats a freeform pan.
 */
export async function generateVideoFromImage(
  imageDataUri: string,
  prompt: string,
  opts: {
    aspectRatio?: string;
    signal?: AbortSignal;
    maxWaitMs?: number;
    /** last-frame image (data URI) → Veo 3.1 first→last frame interpolation */
    lastFrameDataUri?: string;
    /** clip length in seconds (Veo 3.1: 4 | 6 | 8; omit for the model default) */
    durationSeconds?: number;
    negativePrompt?: string;
  } = {},
): Promise<GeneratedVideo | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const img = parseDataUri(imageDataUri);
  const last = opts.lastFrameDataUri ? parseDataUri(opts.lastFrameDataUri) : null;
  const aspectRatio = opts.aspectRatio ?? "16:9";

  // Request-body variants, most capable first. Each is dropped only when the API
  // explicitly rejects it (400), so an unsupported field degrades gracefully
  // instead of failing the whole segment.
  type Img = { bytesBase64Encoded: string; mimeType: string };
  const imgPart: Img = { bytesBase64Encoded: img.data, mimeType: img.mime };
  const lastPart: Img | null = last ? { bytesBase64Encoded: last.data, mimeType: last.mime } : null;
  const baseParams: Record<string, unknown> = { aspectRatio };
  if (opts.negativePrompt) baseParams.negativePrompt = opts.negativePrompt;
  if (opts.durationSeconds) baseParams.durationSeconds = opts.durationSeconds;
  const variants: { label: string; body: unknown }[] = [];
  if (lastPart) {
    variants.push({
      label: "lastFrame@instance",
      body: {
        instances: [{ prompt, image: imgPart, lastFrame: lastPart }],
        parameters: baseParams,
      },
    });
    variants.push({
      label: "lastFrame@parameters",
      body: {
        instances: [{ prompt, image: imgPart }],
        parameters: { ...baseParams, lastFrame: lastPart },
      },
    });
  }
  variants.push({
    label: "plain",
    body: { instances: [{ prompt, image: imgPart }], parameters: baseParams },
  });
  // If durationSeconds itself is what a model rejects, a final variant without it.
  if (opts.durationSeconds) {
    variants.push({
      label: "plain-no-duration",
      body: { instances: [{ prompt, image: imgPart }], parameters: { aspectRatio } },
    });
  }

  // 1) Start the long-running generation — first (model, body-variant) that
  //    accepts wins. 400 = the body shape is wrong for this model → next variant;
  //    other statuses (404/429/5xx) = the model itself is unavailable → next model.
  let opName: string | null = null;
  let lastFrameHonored = false;
  outer: for (const model of VEO_MODELS) {
    for (const v of variants) {
      try {
        const res = await fetch(`${API_BASE}/models/${model}:predictLongRunning?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: opts.signal,
          body: JSON.stringify(v.body),
        });
        if (!res.ok) {
          console.warn(
            `[veo] ${model} (${v.label}) start → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
          );
          if (res.status === 400) continue; // body shape rejected — try the next variant
          break; // model unavailable / quota — try the next slug
        }
        const j = (await res.json()) as { name?: string };
        if (!j.name) {
          console.warn(`[veo] ${model} (${v.label}) start returned no operation name`);
          continue;
        }
        opName = j.name;
        // Did this winning variant actually pin the last frame? (A "plain"
        // variant means the API rejected every lastFrame body shape.)
        lastFrameHonored = !!lastPart && !v.label.startsWith("plain");
        if (lastPart && !lastFrameHonored) {
          console.warn(
            `[veo] ${model}: lastFrame interpolation NOT accepted — segment is grounded at its start only`,
          );
        }
        console.log(`[veo] generating with ${model} (${v.label})`);
        break outer;
      } catch (e) {
        console.warn(`[veo] ${model} (${v.label}) start failed:`, (e as Error).message);
      }
    }
  }
  if (!opName) return null;

  // 2) Poll the operation until it's done (Veo takes ~1–3 min).
  const maxWait = opts.maxWaitMs ?? 4 * 60_000;
  const started = Date.now();
  let op: VeoOperation | null = null;
  while (Date.now() - started < maxWait) {
    await sleep(8000);
    try {
      const pr = await fetch(`${API_BASE}/${opName}?key=${key}`, { signal: opts.signal });
      op = (await pr.json()) as VeoOperation;
    } catch (e) {
      console.warn("[veo] poll failed (continuing):", (e as Error).message);
      continue;
    }
    if (op.done) break;
  }
  if (!op?.done) {
    console.warn("[veo] timed out waiting for the video");
    return null;
  }
  if (op.error) {
    console.warn("[veo] operation error:", JSON.stringify(op.error).slice(0, 300));
    return null;
  }

  // 3) Download the produced mp4 from the files URI (needs the key appended).
  const uri =
    op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
    op.response?.generatedVideos?.[0]?.video?.uri;
  if (!uri) {
    console.warn("[veo] no video uri in the response");
    return null;
  }
  try {
    const dlUrl = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${key}`;
    const dl = await fetch(dlUrl, { signal: opts.signal });
    if (!dl.ok) {
      console.warn(`[veo] download → ${dl.status}`);
      return null;
    }
    const bytes = Buffer.from(await dl.arrayBuffer());
    return { bytes, contentType: dl.headers.get("content-type") || "video/mp4", lastFrameHonored };
  } catch (e) {
    console.warn("[veo] download failed:", (e as Error).message);
    return null;
  }
}

interface VeoOperation {
  done?: boolean;
  error?: unknown;
  response?: {
    generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] };
    generatedVideos?: { video?: { uri?: string } }[];
  };
}
