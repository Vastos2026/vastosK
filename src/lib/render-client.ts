/**
 * Client helpers for the FLUX render API (`/api/render`).
 *
 * `generateRender` runs text-to-image from the project's real design;
 * `inpaintRender` edits only a masked region of an existing render. Both throw
 * a descriptive Error on failure so the UI can show what went wrong instead of
 * silently falling back to a fake image.
 */

import type {
  DesignStyle,
  FloorPlan,
  FurnitureCheck,
  PlacedItem,
  PropertyType,
  RenderJob,
} from "./types";

export interface RenderResult {
  /** storage key of the generated image (base for future inpaint edits) */
  key: string;
  /** URL to display the image (served by GET /api/render) */
  imageUrl: string;
  /** the prompt FLUX received */
  prompt: string;
  /**
   * Text description of the HERO render's look, returned by the room's first
   * (hero) view. Pass it back as `lookSpec` on the room's other views so they
   * match the hero's colours/materials/furniture without copying its camera.
   */
  lookSpec?: string;
  /**
   * Furniture verify-loop result: the render was vision-checked against the
   * room's furniture list (via its 3D screenshot) and missing pieces were
   * repaired in place. Store it on the version so the UI can show the ticks.
   */
  checklist?: FurnitureCheck[];
  /** substantial furniture the checker saw that matches nothing in the plan */
  extras?: string[];
  /** true when every in-frame item ended up present (or repaired) */
  verified?: boolean;
}

async function postRender<T = RenderResult>(payload: unknown): Promise<T> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `Render failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function generateRender(input: {
  projectId: string;
  view: RenderJob["view"];
  style: DesignStyle;
  propertyType: PropertyType;
  plan?: FloorPlan;
  items: PlacedItem[];
  /** PNG/JPEG data URI of the captured 3D scene → enables image-to-image. */
  image?: string;
  /** Fixed seed so all of a room's views render the same, consistent design. */
  seed?: number;
  /** Optional free-text design brief from the user. */
  notes?: string;
  /**
   * The hero view's look description (from the hero render's `lookSpec`). When set,
   * this view renders from its OWN screenshot but is told to match that exact look,
   * so the room stays ONE design without the views copying the hero's camera.
   */
  lookSpec?: string;
  /** Render this view as the FLUX hero (image-to-image from its 3D screenshot). */
  heroFlux?: boolean;
  /**
   * Storage key of the rendered hero. When set, Nano Banana anchors this view to
   * the hero IMAGE (identical materials/furniture/theme), its own screenshot the camera.
   */
  anchorKey?: string;
  /** Per-furniture reference images (label + data URI) to match in the render. */
  references?: { label: string; image: string }[];
  /** Whole-room reference image (data URI) — match the overall style/mood to it. */
  styleRef?: string;
  /**
   * Storage key of the room's HERO render, used as a SOFT style reference so this
   * follow-up view matches the hero's design while keeping its own camera — the
   * "render the hero once, derive the rest from it" consistency. Resolved server-side.
   */
  styleRefKey?: string;
  /**
   * When true, do NOT fall back to FLUX image-to-image if Nano Banana is
   * busy/returns nothing — fail with a clear "retry" error instead. Room views set
   * this so a rate-limited render surfaces a retry rather than a rough, blocky FLUX
   * image (which looks like an unfinished 3D model).
   */
  noFluxFallback?: boolean;
  /**
   * When true (with `anchorKey`), a failed anchored render surfaces a retry error
   * rather than silently producing an UNANCHORED side still. The walkthrough sides
   * set this so all four share the edited front photo's design.
   */
  requireAnchor?: boolean;
}): Promise<RenderResult> {
  return postRender({ mode: "generate", ...input });
}

export function inpaintRender(input: {
  projectId: string;
  /** storage key of the base render to edit */
  baseKey: string;
  /** PNG mask data URL — white = repaint, black = keep */
  mask: string;
  instruction: string;
  style: DesignStyle;
  /** optional reference image (data URI) uploaded to guide the edit */
  reference?: string;
  /**
   * When true, don't fall back to FLUX-Fill if Nano Banana is busy/returns nothing
   * — fail with a clear "retry" error instead. The lasso edit sets this: FLUX-Fill
   * is confined to the strict lasso outline, whereas Nano expands to the whole
   * object/area the user means; a constrained FLUX edit reads as "it didn't work".
   */
  noFluxFallback?: boolean;
}): Promise<RenderResult> {
  return postRender({ mode: "inpaint", ...input });
}

/**
 * Generate the room's orbit VIDEO (Google Veo) from the front render. The video
 * pans around the room; the caller extracts the Front/Left/Right/Back stills from
 * it. One coherent clip → every extracted frame is the SAME room (consistency).
 */
export interface VideoFrame {
  view: string;
  label: string;
  key: string;
  imageUrl: string;
}

export function generateVideo(input: {
  projectId: string;
  /** the front render as a data URI — the single source of truth for the clip */
  image: string;
  /** camera-motion prompt for the orbit / pan (legacy single-clip path) */
  prompt: string;
  /**
   * Photoreal stills of all four sides (data URIs), clockwise from the front.
   * With `segmentPrompts`, the server films the GROUNDED orbit: four Veo clips
   * each interpolating first→last frame between consecutive stills, stitched
   * into one seamless 360° — all four walls guaranteed, equal time, no invention.
   */
  sides?: { front: string; right: string; back: string; left: string };
  /** one Veo prompt per orbit segment, clockwise: F→R, R→B, B→L, L→F */
  segmentPrompts?: string[];
  /** already-stored gallery stills to echo into the durable job result (reconcile) */
  frames?: VideoFrame[];
  /**
   * Id of the local walkthrough render record. The server persists the job's
   * outcome under this id, so a reload mid-generation can reclaim the clip via
   * fetchVideoJob instead of losing the paid Veo output.
   */
  jobId?: string;
}): Promise<{ key: string; videoUrl: string; frames: VideoFrame[]; warning?: string }> {
  return postRender<{ key: string; videoUrl: string; frames: VideoFrame[]; warning?: string }>({
    mode: "video",
    ...input,
  });
}

export interface VideoJobStatus {
  status: "processing" | "done" | "failed";
  /** progress line for a processing job ("Filming the orbit — 2/4…") */
  stage?: string | null;
  result: { key: string; videoUrl: string; frames: VideoFrame[]; warning?: string } | null;
  error: string | null;
}

/**
 * Look up a walkthrough job in the server's durable registry. Resolves to
 * undefined when the job is unknown there (404) or the request fails — callers
 * must treat that as "no information", not as failure.
 */
export async function fetchVideoJob(jobId: string): Promise<VideoJobStatus | undefined> {
  try {
    const res = await fetch(`/api/render?videoJob=${encodeURIComponent(jobId)}`);
    if (!res.ok) return undefined;
    return (await res.json()) as VideoJobStatus;
  } catch {
    return undefined;
  }
}

/** Stitch stored stills (by key) into a hard-cut slideshow video, 2s per frame. */
export function makeSlideshow(input: {
  projectId: string;
  imageKeys: string[];
  secondsEach?: number;
}): Promise<{ key: string; videoUrl: string }> {
  return postRender<{ key: string; videoUrl: string }>({ mode: "slideshow", ...input });
}

/** Persist a frame the client extracted from the orbit video, and get its URL. */
export function storeFrame(input: {
  projectId: string;
  /** the extracted frame as a data URI (PNG/JPEG) */
  image: string;
}): Promise<{ key: string; imageUrl: string }> {
  return postRender<{ key: string; imageUrl: string }>({ mode: "store-frame", ...input });
}

/**
 * Check whether a room's view photos show ONE coherent design (same materials,
 * flooring, furniture). Run before filming the walkthrough so a drifting side is
 * caught and can be retried, not cemented into the orbit. Best-effort: resolves
 * `consistent: true` when the check is unavailable.
 */
export function checkConsistency(input: {
  projectId: string;
  style: DesignStyle;
  views: { label: string; image: string }[];
}): Promise<{ consistent: boolean; issues: string[] }> {
  return postRender<{ consistent: boolean; issues: string[] }>({ mode: "consistency", ...input });
}

/** Merge a room's rendered views (by storage key) into one 360° panorama. */
export function makePanorama(input: {
  projectId: string;
  imageKeys: string[];
  style: DesignStyle;
  propertyType: PropertyType;
  /** Optional free-text design brief from the user. */
  notes?: string;
}): Promise<RenderResult> {
  return postRender({ mode: "pano", ...input });
}
