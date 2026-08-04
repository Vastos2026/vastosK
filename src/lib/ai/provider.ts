import "server-only";
/**
 * AI provider layer (revamp Workstream 4) — the ONLY module allowed to call a
 * Gemini SDK/endpoint directly for the NEW pipeline (Universal Input →
 * Prompt Builder → this layer). Every other module (API routes, the Prompt
 * Builder, future frontend flow) calls these five functions instead of
 * touching a provider client or REST endpoint itself.
 *
 * Each call: applies the retry policy from ./errors, times itself, normalizes
 * failures to an ErrorCategory, and writes one ai_usage_logs row — all
 * best-effort, so a logging hiccup never breaks a generation.
 *
 * The old 3D-studio render stack (render/gemini-image.ts, render/veo-client.ts,
 * render/flux-client.ts) already existed before this layer and does its own
 * direct Gemini calls — it's deliberately left as-is (the 3D studio is
 * explicitly deprioritized-not-removed, and ripping out its FLUX fallback
 * before Workstream 8 replaces it with the new flow would break the only
 * currently-working generation path). generateImage/editImage/generateVideo
 * wrap it so that stack goes through this layer too; extractFloorPlan below
 * is the new pipeline's single-call extraction entry point (see
 * src/lib/pipeline/extract-plan.ts).
 */

import { generateJson, geminiConfigured, type GeminiPart } from "@/lib/pipeline/gemini-client";
import { downscaleForGemini } from "@/lib/pipeline/image-utils";
import { editImageWithGemini } from "@/lib/render/gemini-image";
import { generateVideoFromImage } from "@/lib/render/veo-client";
import type { DesignStyle } from "@/lib/types";
import { ProviderError, RETRYABLE_CATEGORIES, MAX_RETRIES, backoffMs, sleep } from "./errors";
import { logUsage } from "./usage-log";
import {
  runwareConfigured,
  generateImageWithRunware,
  generateImageWithRunwareGemini,
  editImageWithRunwareGemini,
  generateVideoWithRunware,
} from "@/lib/render/runware-client";
import { getProviderPrimary, type ProviderCapability } from "@/lib/settings/provider-settings";
import { currentModelSlugs } from "@/lib/ai/model-labels";
import { debugLogPrompt } from "@/lib/ai/debug-log";

export interface CallContext {
  userId?: string | null;
  projectId?: string | null;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Gemini 3.1 Flash Image ("Nano Banana 2") — same model Runware's google:4@3
// tier calls. This account's own Google Cloud free-tier quota for it was
// hard 0 as of 2026-07-31 (unfunded billing, not a code issue) — the
// direct-AI-Studio path is only the true last resort anyway (reached when
// every Runware tier is also unreachable), so it stays pinned to this model
// rather than degrading to 2.5 for an account-funding gap that isn't this
// code's problem to work around.
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";

/**
 * Provider selection for image_gen/image_edit: admin-configurable via the
 * console's Analytics page (provider_settings table, src/lib/settings/
 * provider-settings.ts), falling back to the legacy env-var toggle when
 * Supabase isn't configured or has no setting yet. Unsetting RUNWARE_API_KEY
 * still forces Gemini regardless of the stored/env choice, so a
 * half-configured Runware setup never silently breaks generation.
 */
async function resolveProvider(capability: ProviderCapability, envValue: string | undefined): Promise<"gemini" | "runware"> {
  if (!runwareConfigured()) return "gemini";
  const envOverride = envValue?.trim().toLowerCase();
  if (envOverride === "gemini") return "gemini";
  if (envOverride === "runware") return "runware";
  return getProviderPrimary(capability);
}

/**
 * Video provider — env-var only, no admin UI (see provider_settings' header
 * comment: video is deliberately fixed to a single display with no toggle).
 */
function resolveVideoProvider(envValue: string | undefined): "gemini" | "runware" {
  const wanted = (envValue?.trim().toLowerCase() || "runware") as "gemini" | "runware";
  return wanted === "runware" && runwareConfigured() ? "runware" : "gemini";
}

function classify(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(msg)) return new ProviderError("TimeoutError", msg);
  return new ProviderError("AiProviderError", msg);
}

/** Retry wrapper: retries only AiProviderError/TimeoutError, capped backoff. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: ProviderError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = classify(e);
      lastErr = err;
      if (!RETRYABLE_CATEGORIES.has(err.category) || attempt === MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt + 1));
    }
  }
  throw lastErr ?? new ProviderError("InternalError", "retry loop exited without a result");
}

/**
 * Wraps a provider call: retry, time it, log it, normalize the thrown error.
 * `fn` gets a `setCost` callback so a Runware caller can report the real
 * per-call USD cost (`includeCost: true`'s `cost` field) into the usage log —
 * callers that have no such number (the Gemini path) simply never call it,
 * leaving `estimated_cost` null rather than a fabricated figure. `fn` also
 * gets `setUsed`, for callers that try MULTIPLE backends in a chain
 * (`runChain` below) — it overrides the `model`/`provider` actually logged
 * once the chain settles on whichever tier succeeded, instead of always
 * logging the first-choice tier even when a fallback is what actually ran.
 * Callers with only one backend (planning/video) never call it, so `model`/
 * `provider` passed in here are still what gets logged for them, unchanged.
 */
async function instrumented<T>(
  feature: "planning" | "image" | "edit" | "video",
  model: string,
  ctx: CallContext | undefined,
  fn: (
    setCost: (costUsd: number | null | undefined) => void,
    setUsed: (model: string, provider: "google" | "runware") => void,
  ) => Promise<T>,
  provider?: "google" | "runware",
): Promise<T> {
  const started = Date.now();
  let costUsd: number | null | undefined;
  let usedModel = model;
  let usedProvider = provider;
  const setCost = (c: number | null | undefined) => {
    costUsd = c;
  };
  const setUsed = (m: string, p: "google" | "runware") => {
    usedModel = m;
    usedProvider = p;
  };
  try {
    const result = await withRetry(() => fn(setCost, setUsed));
    void logUsage({
      userId: ctx?.userId,
      projectId: ctx?.projectId,
      feature,
      model: usedModel,
      provider: usedProvider,
      success: true,
      durationMs: Date.now() - started,
      estimatedCost: costUsd,
    });
    return result;
  } catch (e) {
    const err = classify(e);
    void logUsage({
      userId: ctx?.userId,
      projectId: ctx?.projectId,
      feature,
      model: usedModel,
      provider: usedProvider,
      success: false,
      durationMs: Date.now() - started,
      errorCategory: err.category,
      estimatedCost: costUsd,
    });
    throw err;
  }
}

export interface ChainStep<T> {
  model: string;
  provider: "google" | "runware";
  run: () => Promise<T>;
}

/**
 * Tries each step in order, falling through to the next on ANY failure
 * (including an ordinary `ValidationError` — a deterministic failure on
 * Runware's FLUX/Nano-Banana doesn't imply the completely separate Google
 * direct-API path would fail the same way, unlike `withRetry`'s same-provider
 * retry, which correctly stops on `ValidationError`) — EXCEPT a
 * `ProviderError` with `nonRecoverable: true` (e.g. assertGenerationAspect's
 * guard, runware-client.ts), which re-throws immediately instead: that
 * failure is a correctness invariant a different tier can't route around, so
 * falling through would just silently mask it. Returns the first success;
 * throws the LAST step's error if every (fallen-through) step fails. Used for
 * the FLUX → Nano Banana 2 → Google-direct fallback chain (`generateImage`/
 * `editImage` below) — `generateVideo`/`generateStructured` have only one
 * active backend each and don't need this, see `runOnProvider`.
 *
 * Exported so dev-check can exercise both branches (nonRecoverable re-throw,
 * ordinary fallthrough) with stub steps, no network call.
 */
export async function runChain<T>(
  steps: ChainStep<T>[],
  setUsed: (model: string, provider: "google" | "runware") => void,
): Promise<T> {
  let lastErr: unknown;
  for (const step of steps) {
    try {
      const result = await step.run();
      setUsed(step.model, step.provider);
      return result;
    } catch (e) {
      // A `nonRecoverable` ProviderError (e.g. assertGenerationAspect's guard,
      // runware-client.ts) means this tier's failure is a correctness
      // invariant, not a transient/provider-specific one — falling through to
      // a different tier wouldn't fix the underlying problem (the generation
      // dimensions don't match the reference image's aspect), it would just
      // silently mask it behind a different image model. Re-throw
      // immediately instead of trying the next tier. Every OTHER error type —
      // including an ordinary ValidationError — keeps falling through exactly
      // as before this flag existed; this is a narrow carve-out for one
      // specific failure class, not a broader retry-semantics change.
      if (e instanceof ProviderError && e.nonRecoverable) throw e;
      lastErr = e;
      console.warn(
        `[ai-provider-chain] ${step.provider}:${step.model} failed, trying next tier:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  if (lastErr instanceof ProviderError) throw lastErr;
  throw new ProviderError(
    "AiProviderError",
    lastErr instanceof Error ? lastErr.message : "all providers in the chain failed",
  );
}

/**
 * Runs whichever provider's call is active and normalizes the thrown error —
 * shared by generateImage/editImage/generateVideo so a Runware-side
 * ProviderError (e.g. ValidationError) keeps its real category instead of
 * being flattened to AiProviderError just because it crossed this boundary.
 */
async function runOnProvider<T>(
  provider: "gemini" | "runware",
  runwareFn: () => Promise<T>,
  geminiFn: () => Promise<T>,
): Promise<T> {
  try {
    return provider === "runware" ? await runwareFn() : await geminiFn();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("AiProviderError", (e as Error).message);
  }
}

export interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
}

/** [y_min, x_min, y_max, x_max], each an integer 0-1000 normalised to the full image — Gemini's
 *  standard spatial-grounding box convention, independent of the image's actual pixel size. */
export type RawBox = [number, number, number, number];

export interface RawOpening {
  kind: "door" | "window";
  side: "north" | "south" | "east" | "west";
  /** another room's name, "exterior", or omitted if the model couldn't tell */
  connectsTo?: string;
  /** bounding box of the door/window symbol itself, omitted if the model wasn't confident */
  box?: RawBox;
}

export interface RawExtractedRoom {
  /** verbatim as printed/labeled on the plan — never normalized */
  name: string;
  /** classified type, ideally one of the caller's roomTypeHints */
  type?: string;
  widthFt?: number;
  heightFt?: number;
  openings: RawOpening[];
  /** bounding box of the room's wall outline, omitted if the model wasn't confident */
  box?: RawBox;
}

export interface RawExtraction {
  rooms: RawExtractedRoom[];
  /** 0..1 overall extraction confidence, the model's own self-assessment */
  confidence: number;
  /** false when the model could not make sense of this as a floor plan at all */
  readable: boolean;
}

/**
 * Builds the response schema for one extraction call. When the caller has a
 * fixed room-type list (every project category except Custom), the "type"
 * field is constrained to an ENUM of exactly that list — Gemini's
 * constrained decoding then cannot return a type outside it, which is a
 * stronger hallucination guard than prompt wording alone. Custom projects
 * pass an empty list by design (config/project-types/custom.json), so "type"
 * stays free-text there — there is no fixed list to constrain it to.
 */
function buildExtractionSchema(roomTypeHints: string[]) {
  return {
    type: "OBJECT",
    properties: {
      readable: { type: "BOOLEAN" },
      confidence: { type: "NUMBER" },
      rooms: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            type: roomTypeHints.length
              ? { type: "STRING", enum: roomTypeHints }
              : { type: "STRING" },
            widthFt: { type: "NUMBER" },
            heightFt: { type: "NUMBER" },
            openings: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  kind: { type: "STRING", enum: ["door", "window"] },
                  side: { type: "STRING", enum: ["north", "south", "east", "west"] },
                  connectsTo: { type: "STRING" },
                },
                required: ["kind", "side"],
              },
            },
          },
          required: ["name", "openings"],
        },
      },
    },
    required: ["readable", "confidence", "rooms"],
  } as const;
}

interface RawExtractionResponse {
  readable?: boolean;
  confidence?: number;
  rooms?: {
    name?: string;
    type?: string;
    widthFt?: number;
    heightFt?: number;
    openings?: { kind?: string; side?: string; connectsTo?: string }[];
  }[];
}

/** A well-formed box: exactly 4 finite numbers, each in [0,1000], with a positive area. */
function validBox(box: number[] | undefined): RawBox | undefined {
  if (!box || box.length !== 4 || !box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) {
    return undefined;
  }
  const [ymin, xmin, ymax, xmax] = box;
  return ymax > ymin && xmax > xmin ? [ymin, xmin, ymax, xmax] : undefined;
}

/**
 * Single-call floor-plan extraction — replaces the old OCR + OpenCV geometry +
 * semantic + merge pipeline. Reads room names verbatim, classifies each into a
 * type (preferring roomTypeHints when the project's category has a fixed
 * list), reads printed dimensions where legible, and reports door/window
 * presence per room with a rough side and connection. `readable: false` is
 * the model's own signal that this image doesn't look like a floor plan it
 * can extract from — callers route that to manual entry, never a fabricated
 * result.
 */
export async function extractFloorPlan(
  bytes: Buffer,
  mimeType: string,
  roomTypeHints: string[],
  ctx?: CallContext,
): Promise<RawExtraction> {
  if (!geminiConfigured()) {
    throw new ProviderError("ValidationError", "GEMINI_API_KEY is not configured");
  }
  const img = await downscaleForGemini(bytes);
  const hints = roomTypeHints.length
    ? `"type" MUST be exactly one value from this fixed list, chosen by the room's printed name and its position in the layout: ${roomTypeHints.join(", ")}. Pick the closest match even if imperfect — never a value outside this list.`
    : `"type" is a short room-category label (e.g. "Bedroom", "Kitchen") — this project has no fixed list, infer the best short label from the room's printed name.`;

  const prompt = `You are reading an architectural floor plan image to extract its rooms. Be conservative: if you are not confident about a detail, omit it rather than guess.

Per room:
- "name": EXACTLY as printed on the plan (e.g. "KIDS", "Hall", "M. Bedroom"). Never invent one — if nothing is printed, use a short factual description (e.g. "Unlabeled room").
- ${hints}
- "widthFt"/"heightFt": only if a dimension is actually printed near the room (e.g. "12'3\"X9'1\""), converted to decimal feet. Omit both if nothing is legible.
- "openings": every door/window you can see on this room's walls. "kind" (door|window), "side" (north/south/east/west of this room, plan's up-is-north), "connectsTo" (the room on the other side of a door, or "exterior" for an outer wall or a window). Omit anything not clearly visible.

Also: "confidence" (0-1, your own accuracy estimate) and "readable" (false only if this image isn't a floor plan you can meaningfully read at all).

Report only what you can actually see. Never fabricate a room, dimension, or opening.`;

  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: prompt },
  ];

  debugLogPrompt("1. Upload → floor-plan extraction (extractFloorPlan)", {
    prompt,
    chain: `Gemini ${process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest"} (direct, vision)`,
    referenceImages: [`the uploaded plan image itself (${img.mimeType})`],
  });

  return instrumented("planning", process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest", ctx, async () => {
    const raw = await generateJson<RawExtractionResponse>(parts, {
      temperature: 0.1,
      thinkingBudget: 0,
      // Dense plans (many rooms, each with a full opening list) were hitting
      // MAX_TOKENS and getting truncated/salvaged instead of returning every
      // room. Extraction correctness matters more than output-token cost —
      // this cap exists only to bound a runaway generation, not to save
      // tokens, so it's set high enough that a real plan should never hit it.
      maxOutputTokens: 65536,
      responseSchema: buildExtractionSchema(roomTypeHints),
    });
    if (!raw) throw new ProviderError("AiProviderError", "floor plan extraction failed");

    // Belt and suspenders: the schema's enum already constrains `type` when
    // roomTypeHints is non-empty, but a stray out-of-list value is dropped
    // here too rather than trusted, in case a fallback model ignores the
    // schema.
    const validTypes = roomTypeHints.length ? new Set(roomTypeHints) : null;
    const sides = new Set(["north", "south", "east", "west"]);
    const rooms: RawExtractedRoom[] = (raw.rooms ?? [])
      .filter((r): r is typeof r & { name: string } => !!r.name?.trim())
      .map((r) => ({
        name: r.name.trim(),
        type:
          r.type?.trim() && (!validTypes || validTypes.has(r.type.trim()))
            ? r.type.trim()
            : undefined,
        widthFt: typeof r.widthFt === "number" && r.widthFt > 0 ? r.widthFt : undefined,
        heightFt: typeof r.heightFt === "number" && r.heightFt > 0 ? r.heightFt : undefined,
        openings: (r.openings ?? [])
          .filter((o) => (o.kind === "door" || o.kind === "window") && sides.has(o.side ?? ""))
          .map((o) => ({
            kind: o.kind as "door" | "window",
            side: o.side as "north" | "south" | "east" | "west",
            connectsTo: o.connectsTo?.trim() || undefined,
          })),
      }));

    return {
      rooms,
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      readable: raw.readable !== false && rooms.length > 0,
    };
  });
}

export interface RawGeometry {
  roomBoxes: { roomIndex: number; box: RawBox }[];
  openings: { roomIndex: number; type: "door" | "window"; box: RawBox }[];
}

const GEOMETRY_BOX_SCHEMA = { type: "ARRAY", items: { type: "INTEGER" }, minItems: 4, maxItems: 4 } as const;
const GEOMETRY_SCHEMA = {
  type: "OBJECT",
  properties: {
    roomBoxes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { roomIndex: { type: "INTEGER" }, box_2d: GEOMETRY_BOX_SCHEMA },
        required: ["roomIndex", "box_2d"],
      },
    },
    openings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          roomIndex: { type: "INTEGER" },
          type: { type: "STRING", enum: ["door", "window"] },
          box_2d: GEOMETRY_BOX_SCHEMA,
        },
        required: ["roomIndex", "type", "box_2d"],
      },
    },
  },
  required: ["roomBoxes", "openings"],
} as const;

interface RawGeometryResponse {
  roomBoxes?: { roomIndex?: number; box_2d?: number[] }[];
  openings?: { roomIndex?: number; type?: string; box_2d?: number[] }[];
}

/**
 * A SEPARATE call from extractFloorPlan, deliberately — bundling spatial
 * grounding (box_2d per room + per opening) into the same call as
 * name/type/dimensions/openings was live-tested 2026-08-01 and found
 * unreliable on dense plans: on a 13-16-room plan the bundled call returned
 * box_2d for 0/22 or 1/16 openings across repeated runs, while this same
 * geometry, asked for on its OWN in a focused call, returned it for 13/13
 * rooms and 8-18 openings consistently across 5 runs. Splitting the
 * concerns keeps each call's task simple enough for the model to actually
 * do well, matching the pattern that worked in the original spike.
 *
 * Takes the room names already produced by extractFloorPlan (as an ordered
 * list) so the model can reference them BY INDEX rather than by name —
 * floor plans routinely have multiple rooms sharing a name (e.g. two rooms
 * both called "BEDROOM"), and index reference sidesteps that ambiguity
 * entirely rather than trying to disambiguate identical names.
 *
 * Best-effort: returns an empty result (never throws) on any failure —
 * geometry is a placement ENHANCEMENT, not a requirement. A room this call
 * can't confidently place falls back to the pre-existing manual "Place"
 * flow in the Plan Editor exactly as if this call didn't exist.
 */
export async function extractOpeningGeometry(
  bytes: Buffer,
  mimeType: string,
  roomNames: string[],
  ctx?: CallContext,
): Promise<RawGeometry> {
  const empty: RawGeometry = { roomBoxes: [], openings: [] };
  if (!geminiConfigured() || roomNames.length === 0) return empty;

  try {
    const img = await downscaleForGemini(bytes);
    const list = roomNames.map((n, i) => `${i}: "${n}"`).join("\n");
    const prompt = `This architectural floor plan has already been read; here are its rooms, indexed in no particular order:
${list}

For EACH room index above, return its bounding box: [y_min,x_min,y_max,x_max], integers 0-1000 normalised to the full image, tightly around that room's actual wall outline (not its label text).

Also find every door/window on each room's walls and return its bounding box the same way (swing arc included for a door). Reference the room by its index above, not its name.

Be conservative — omit an entry rather than guess if you're not confident.`;

    const parts: GeminiPart[] = [
      { inlineData: { mimeType: img.mimeType, data: img.data } },
      { text: prompt },
    ];

    debugLogPrompt("2. Upload → opening/geometry extraction (extractOpeningGeometry)", {
      prompt,
      chain: `Gemini ${process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest"} (direct, vision)`,
      referenceImages: [`the uploaded plan image itself (${img.mimeType})`],
    });

    return await instrumented("planning", process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest", ctx, async () => {
      const raw = await generateJson<RawGeometryResponse>(parts, {
        temperature: 0.1,
        maxOutputTokens: 65536,
        responseSchema: GEOMETRY_SCHEMA,
      });
      if (!raw) return empty;

      const n = roomNames.length;
      const roomBoxes = (raw.roomBoxes ?? [])
        .filter((r) => typeof r.roomIndex === "number" && r.roomIndex >= 0 && r.roomIndex < n)
        .map((r) => ({ roomIndex: r.roomIndex as number, box: validBox(r.box_2d) }))
        .filter((r): r is { roomIndex: number; box: RawBox } => !!r.box);
      const openings = (raw.openings ?? [])
        .filter(
          (o) =>
            typeof o.roomIndex === "number" &&
            o.roomIndex >= 0 &&
            o.roomIndex < n &&
            (o.type === "door" || o.type === "window"),
        )
        .map((o) => ({ roomIndex: o.roomIndex as number, type: o.type as "door" | "window", box: validBox(o.box_2d) }))
        .filter((o): o is { roomIndex: number; type: "door" | "window"; box: RawBox } => !!o.box);

      return { roomBoxes, openings };
    });
  } catch (e) {
    console.warn("[extractOpeningGeometry] failed, continuing without positions:", (e as Error).message);
    return empty;
  }
}

/**
 * Plain text-to-image generation for the new flow's room images — the Prompt
 * Builder hands this a fully-assembled natural-language prompt; this layer
 * never sees or constructs prompt structure itself.
 */
/**
 * The original Gemini text-to-image call — kept as its own function so the
 * Runware branch can sit next to it without touching this logic. `imageConfig.
 * aspectRatio` is a real, documented Gemini image-gen parameter (verified
 * against Google's docs, 2026-07-28, against the then-current gemini-2.5-flash-image:
 * `generationConfig.imageConfig.aspectRatio` accepts one of "1:1", "2:3",
 * "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9" — it otherwise
 * defaults to 1:1), so this is set to "16:9" to match the Runware path rather
 * than left at the model's square default. Not re-verified against
 * gemini-3.1-flash-image specifically since bumping IMAGE_MODEL (2026-07-31) —
 * same request shape, flag if aspect ratio ever looks wrong after this bump.
 */
async function generateImageWithGemini(
  prompt: string,
  referenceImages?: string[],
): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("AiProviderError", "GEMINI_API_KEY is not configured");

  // Image parts before the text part, matching the ordering extractFloorPlan
  // already uses for its vision call.
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
  for (const uri of referenceImages ?? []) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(uri);
    if (!m) throw new ProviderError("ValidationError", "reference image must be a base64 data URI");
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  parts.push({ text: prompt });

  const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        // A reference image carries its own aspect ratio, and the whole point
        // of passing one is that the output matches it — pinning 16:9 on top
        // would fight the reference. Only set it for text-only calls.
        generationConfig: referenceImages?.length
          ? { responseModalities: ["IMAGE"] }
          : { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      }),
    });
  } catch (e) {
    throw new ProviderError("AiProviderError", `request failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError("AiProviderError", `${IMAGE_MODEL} ${res.status}: ${body}`);
  }
  const payload = (await res.json().catch(() => null)) as GeminiImageResponse | null;
  const b64 = payload?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new ProviderError("AiProviderError", `${IMAGE_MODEL} returned no image part`);
  return { bytes: Buffer.from(b64, "base64"), contentType: "image/png" };
}

/**
 * Plain text-to-image generation for the new flow's room images — the Prompt
 * Builder hands this a fully-assembled natural-language prompt; this layer
 * never sees or constructs prompt structure itself.
 *
 * Fallback chain (2026-07-31, per explicit user request; FLUX tier bumped to
 * [pro] 2026-08-02, also per explicit user request — see runware-client.ts's
 * header comment): the admin's "primary provider" choice (console's
 * Analytics page) picks which model starts the chain — FLUX.2 [pro] for
 * "runware", or Runware's own Gemini-hosted image model (Nano Banana 2) for
 * "gemini" — but EITHER way, as long as Runware is actually configured, both
 * Runware tiers run before ever reaching Google. FLUX now runs even when a
 * greybox reference image is attached (previously skipped — see the "runware"
 * step below), which is the common case, not the exception, for real room
 * generations in this app. Direct Google Gemini API is now a true last
 * resort, only reached when Runware itself is unreachable (unconfigured, or
 * every Runware tier failed) — previously, choosing "gemini" skipped Runware
 * entirely and went straight to the direct Google API even though Runware
 * hosts the same Gemini model. Each tier only runs if the previous one
 * throws — see `runChain`.
 */
export async function generateImage(
  prompt: string,
  ctx?: CallContext,
  opts?: {
    referenceImages?: string[];
    referenceImageUrls?: string[];
    /**
     * Task 13: explicit output dimensions, overriding the FLUX call's own
     * resolution-tier default. The caller (generate-room-image/route.ts)
     * passes the greybox render's own W/H whenever a greybox reference is
     * attached, so the generation aspect exactly matches the camera the
     * reference was rendered from — only generateImageWithRunware reads
     * these; the Nano Banana/direct-Google fallback tiers already match a
     * reference's aspect on their own (see runware-client.ts's
     * generateImageWithRunwareGemini doc comment) and take no width/height.
     */
    width?: number;
    height?: number;
  },
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const primary = await resolveProvider("image_gen", process.env.IMAGE_PROVIDER);
  const runwareAvailable = runwareConfigured();
  const slugs = currentModelSlugs();
  const fallbackModel = process.env.RUNWARE_FALLBACK_IMAGE_MODEL?.trim() || "google:4@3";
  const defaultModel =
    primary === "runware" ? slugs.imageGen.runware : runwareAvailable ? fallbackModel : IMAGE_MODEL;

  debugLogPrompt("3/4. Room image generation (generateImage — first generation, Generate More, or Furnish's Generate all call this)", {
    prompt,
    chain:
      primary === "runware"
        ? `Runware ${slugs.imageGen.runware} → Runware ${fallbackModel} → Gemini ${IMAGE_MODEL} (direct)`
        : runwareAvailable
          ? `Runware ${fallbackModel} → Gemini ${IMAGE_MODEL} (direct)`
          : `Gemini ${IMAGE_MODEL} (direct)`,
    referenceImages: opts?.referenceImages,
    referenceImageUrls: opts?.referenceImageUrls,
  });

  return instrumented(
    "image",
    defaultModel,
    ctx,
    async (setCost, setUsed) => {
      const refs = opts?.referenceImages;
      const steps: ChainStep<GeneratedImage>[] = [];
      const runwareGeminiStep: ChainStep<GeneratedImage> = {
        model: fallbackModel,
        provider: "runware",
        run: async () => {
          const out = await generateImageWithRunwareGemini(prompt, refs);
          setCost(out.costUsd);
          return out;
        },
      };
      // FLUX.2 [pro] (the current RUNWARE_IMAGE_MODEL default, bfl:5@1) DOES
      // support reference images (`inputs.referenceImages`, confirmed against
      // Runware's docs 2026-08-02 — see runware-client.ts's header comment),
      // unlike the old FLUX.2 [dev] default this chain used to assume. Most
      // real room generations in this app carry a greybox reference, so
      // skipping FLUX whenever one was present effectively meant FLUX never
      // ran at all — this used to fall straight through to Nano Banana
      // instead, which is what a direct user report ("switch off Nano Banana
      // 2, use FLUX.2 Pro instead") was actually describing. If a caller ever
      // points RUNWARE_IMAGE_MODEL back at a `runware:*` tier without
      // reference-image support, that tier's own 400 just falls through to
      // the next step in this chain like any other failure — no special
      // casing needed here.
      if (primary === "runware") {
        steps.push({
          model: slugs.imageGen.runware,
          provider: "runware",
          run: async () => {
            const out = await generateImageWithRunware(prompt, refs, opts?.width, opts?.height);
            setCost(out.costUsd);
            return out;
          },
        });
        steps.push(runwareGeminiStep);
      } else if (runwareAvailable) {
        // Admin picked "Gemini" — use Runware's own Gemini-hosted model
        // first, not the direct Google API (that's the last-resort step below).
        steps.push(runwareGeminiStep);
      }
      steps.push({
        model: IMAGE_MODEL,
        provider: "google",
        run: () => generateImageWithGemini(prompt, refs),
      });
      return runChain(steps, setUsed);
    },
    primary === "runware" || runwareAvailable ? "runware" : "google",
  );
}

/**
 * Lasso-region edit. Fallback chain (2026-07-31, updated per explicit user
 * request — see `generateImage`'s header comment for the full reasoning):
 * Runware Nano Banana Pro (when "runware" is primary) → Runware Nano Banana 2
 * → direct Google Gemini API, as a true last resort only reached when
 * Runware is unconfigured or every Runware tier failed. Choosing "gemini" as
 * primary now starts at Runware's own Gemini-hosted edit model (Nano Banana
 * 2) instead of skipping Runware straight to the direct Google API. All
 * tiers use the SAME crop + generous-pad + composite-back approach
 * (`gemini-image.ts`'s `planCropEdit`/`compositeCrop`, reused by
 * `runware-client.ts`'s `editImageWithRunwareGemini`) since none of these
 * models has a native mask parameter.
 */
export async function editImage(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!instruction.trim()) throw new ProviderError("ValidationError", "instruction is empty");
  const primary = await resolveProvider("image_edit", process.env.IMAGE_PROVIDER);
  const runwareAvailable = runwareConfigured();
  const slugs = currentModelSlugs();
  const fallbackModel = process.env.RUNWARE_FALLBACK_IMAGE_MODEL?.trim() || "google:4@3";
  const defaultModel =
    primary === "runware" ? slugs.imageEdit.runware : runwareAvailable ? fallbackModel : IMAGE_MODEL;

  debugLogPrompt("5. View & Edit lasso region edit (editImage)", {
    prompt: `[instruction as typed] ${instruction}\n\n(the actual model prompt is assembled per-region inside planCropEdit, gemini-image.ts — this logs the raw instruction this layer received, not that assembled text)`,
    chain:
      primary === "runware"
        ? `Runware ${slugs.imageEdit.runware} → Runware ${fallbackModel} → Gemini ${IMAGE_MODEL} (direct)`
        : runwareAvailable
          ? `Runware ${fallbackModel} → Gemini ${IMAGE_MODEL} (direct)`
          : `Gemini ${IMAGE_MODEL} (direct)`,
    referenceImages: ["the cropped+padded region of the current room image (base + mask)"],
  });

  return instrumented(
    "edit",
    defaultModel,
    ctx,
    async (setCost, setUsed) => {
      const steps: ChainStep<GeneratedImage>[] = [];
      const runwareFallbackStep: ChainStep<GeneratedImage> = {
        model: fallbackModel,
        provider: "runware",
        run: async () => {
          const out = await editImageWithRunwareGemini(baseDataUri, maskDataUri, instruction, style, "fallback");
          setCost(out.costUsd);
          return out;
        },
      };
      if (primary === "runware") {
        steps.push({
          model: slugs.imageEdit.runware,
          provider: "runware",
          run: async () => {
            const out = await editImageWithRunwareGemini(baseDataUri, maskDataUri, instruction, style, "primary");
            setCost(out.costUsd);
            return out;
          },
        });
        steps.push(runwareFallbackStep);
      } else if (runwareAvailable) {
        // Admin picked "Gemini" — use Runware's own Gemini-hosted edit model
        // first, not the direct Google API (that's the last-resort step below).
        steps.push(runwareFallbackStep);
      }
      steps.push({
        model: IMAGE_MODEL,
        provider: "google",
        run: async () => {
          const out = await editImageWithGemini(baseDataUri, maskDataUri, instruction, style);
          if (!out) throw new ProviderError("AiProviderError", "edit produced no image");
          return out;
        },
      });
      return runChain(steps, setUsed);
    },
    primary === "runware" || runwareAvailable ? "runware" : "google",
  );
}

export interface GeneratedVideo {
  bytes: Buffer;
  contentType: string;
}

/**
 * Image-to-video (walkthrough clips). Routes per `VIDEO_PROVIDER` —
 * Gemini/Veo (delegates to render/veo-client.ts) or Runware/Wan 2.7
 * (render/runware-client.ts).
 */
export async function generateVideo(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; aspectRatio?: string } = {},
  ctx?: CallContext,
): Promise<GeneratedVideo> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const provider = resolveVideoProvider(process.env.VIDEO_PROVIDER);
  const model = provider === "runware" ? currentModelSlugs().video.runware : "veo";

  return instrumented(
    "video",
    model,
    ctx,
    async (setCost) => {
      return runOnProvider(
        provider,
        async () => {
          const out = await generateVideoWithRunware(imageDataUri, prompt, { durationSeconds: opts.durationSeconds });
          setCost(out.costUsd);
          return out;
        },
        async () => {
          const out = await generateVideoFromImage(imageDataUri, prompt, opts);
          if (!out) throw new ProviderError("AiProviderError", "video generation failed");
          return { bytes: out.bytes, contentType: out.contentType };
        },
      );
    },
    provider === "runware" ? "runware" : "google",
  );
}

/**
 * One structured Gemini call, constrained to `schema` — the Design Planning
 * Layer (Workstream 5) uses this to turn a Universal Input into a Design
 * Specification JSON. Generic (not tied to that shape) so any future
 * structured-JSON planning call goes through this layer too, instead of a
 * caller reaching for pipeline/gemini-client.ts directly.
 */
export async function generateStructured<T>(
  prompt: string,
  schema: object,
  ctx?: CallContext,
): Promise<T> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  debugLogPrompt("2b. Design → Design Planning (generateStructured, runs runDesignPlanning's prompt)", {
    prompt,
    chain: `Gemini ${model} (direct, structured JSON)`,
    referenceImages: null,
  });
  return instrumented("planning", model, ctx, async () => {
    const parts: GeminiPart[] = [{ text: prompt }];
    const out = await generateJson<T>(parts, {
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 8192,
      responseSchema: schema,
    });
    if (out === null) throw new ProviderError("AiProviderError", "structured generation failed");
    return out;
  });
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
  }[];
}
