/**
 * Nano Banana 2 (Gemini 3.1 Flash Image) — instruction-driven image editing for
 * the lasso "selective edit". It's genuinely good at *adding* objects from a
 * sparse instruction ("add an AC there"), which masked FLUX inpainting struggles
 * with.
 *
 * Reliable region editing: rather than hand Gemini a separate binary mask (which
 * image models ground on poorly), we CROP the lasso's bounding box, let Gemini
 * edit that focused region, then composite the result back into the original
 * through the lasso shape (feathered). So the object actually gets added, and
 * every pixel outside the lasso stays byte-identical.
 *
 * Returns `null` when Gemini is unconfigured/unavailable/returns no image, so the
 * caller can fall back to FLUX rather than fabricating a result.
 */

import sharp from "sharp";
import type { DesignStyle } from "@/lib/types";
import { generateJson } from "@/lib/pipeline/gemini-client";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// "Nano Banana 2". Overridable so the slug can be pinned without a code change.
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";

export interface EditedImage {
  bytes: Buffer;
  contentType: string;
}

export function geminiImageConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

/** Strip a `data:<mime>;base64,` prefix → raw base64 + mime. */
export function parseDataUri(uri: string): { data: string; mime: string } {
  const m = uri.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/png", data: uri };
}

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the server's suggested retry delay (seconds) from an error body → ms. */
function retryDelayMs(body: string): number | null {
  const m =
    body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ||
    body.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

type GeminiImagePart = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * POST `parts` to Nano Banana (the image model) WITH retry-on-overload, and
 * return the first image part's bytes.
 *
 * The image model is frequently "overloaded" (503) or rate-limited (429). A
 * single failed POST used to return null immediately, which dropped the whole
 * render to the plain FLUX img2img fallback — bare 3D massing with almost none of
 * the design layer (false ceiling, cove lighting, panelling, materials). That is
 * exactly the "plain / 3D-model-looking" render: it's NOT a worse Nano result,
 * it's the NON-Nano fallback firing because Nano 503'd. Retrying with backoff
 * rides out the transient spike so the magazine-quality Nano render actually
 * comes back instead of the bare shell.
 *
 * Returns null only when unconfigured, on a hard (non-retryable) error, or after
 * exhausting retries — the caller then falls back to FLUX as before.
 */
async function callImageModel(
  parts: GeminiImagePart[],
  label: string,
  signal?: AbortSignal,
  maxAttempts = 4,
): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body,
      });
    } catch (e) {
      console.warn(`[${label}] request failed (attempt ${attempt}/${maxAttempts}):`, (e as Error).message);
      if (attempt < maxAttempts) {
        await sleep(attempt * 1500);
        continue;
      }
      return null;
    }

    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as GeminiImageResponse | null;
      const b64 = payload?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
      if (!b64) {
        console.warn(`[${label}] response had no image part`);
        return null;
      }
      return Buffer.from(b64, "base64");
    }

    const errText = await res.text().catch(() => "");
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      const delayMs = Math.min(retryDelayMs(errText) ?? attempt * 3000, 20000);
      console.warn(
        `[${label}] ${IMAGE_MODEL} → ${res.status}; retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(delayMs);
      continue;
    }
    console.warn(`[${label}] ${IMAGE_MODEL} → ${res.status}: ${errText}`);
    return null;
  }
  return null;
}

export interface CropEditPlan {
  /** The full original image, for compositing the result back into later. */
  baseBuf: Buffer;
  /** The cropped region to hand to whichever image model does the actual edit. */
  cropDataUri: string;
  /** The (downscaled) user-uploaded reference image, if one was given. */
  refDataUri: string | null;
  /** Fully-assembled instruction text, provider-agnostic. */
  prompt: string;
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

/**
 * Provider-agnostic crop-edit planning: finds the lasso's bounding box (with
 * a generous adaptive pad — the lasso is a HINT of where to look, not a hard
 * boundary), crops it, and assembles the edit instruction text. Pulled out of
 * `editImageWithGemini` so `runware-client.ts`'s Nano-Banana-via-Runware path
 * can reuse the exact same math instead of re-deriving it — this part of the
 * pipeline never talks to Google directly, only `sharp`. Returns null when
 * the mask has no selected (white) pixels, or the resulting crop is
 * degenerate — callers should skip the edit call entirely in that case.
 */
export async function planCropEdit(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  /** optional reference image (data URI) the user uploaded to guide the change */
  reference?: string,
): Promise<CropEditPlan | null> {
  const base = parseDataUri(baseDataUri);
  const mask = parseDataUri(maskDataUri);
  const baseBuf = Buffer.from(base.data, "base64");
  const maskBuf = Buffer.from(mask.data, "base64");

  // Reference is only a visual guide — downscale to <=1024px so a big upload
  // doesn't bloat the Nano payload + slow the edit. (The client already shrinks
  // it; this is a safety net for direct API calls.)
  let ref: { mime: string; data: string } | null = null;
  if (reference) {
    const r = parseDataUri(reference);
    try {
      const small = await sharp(Buffer.from(r.data, "base64"))
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      ref = { mime: "image/jpeg", data: small.toString("base64") };
    } catch {
      ref = r;
    }
  }

  const meta = await sharp(baseBuf).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;

  // Mask → greyscale at the base resolution; find the white (selected) bbox.
  const maskRaw = await sharp(maskBuf).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (maskRaw[y * W + x] > 128) {
        any = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!any) return null;

  // VERY generous, adaptive margin around the lasso. The user's intent (stated
  // explicitly): the drawn region is a HINT of WHERE to look, NOT a hard boundary —
  // the edit should take as much surrounding space as it naturally needs (the whole
  // wall, the whole sofa, the whole floor) and understand what they're trying to do.
  // So pad scales generously with the selection and is always >=18% of the image,
  // capped at ~48% so a small lasso still grabs a wide, intent-sized region.
  const selSpan = Math.max(maxX - minX, maxY - minY);
  const pad = Math.round(clamp(selSpan * 0.85, Math.max(W, H) * 0.18, Math.max(W, H) * 0.48));
  const bx = clamp(minX - pad, 0, W - 1);
  const by = clamp(minY - pad, 0, H - 1);
  const bw = clamp(maxX + pad, bx + 1, W) - bx;
  const bh = clamp(maxY + pad, by + 1, H) - by;
  if (bw < 8 || bh < 8) return null;

  const cropBuf = await sharp(baseBuf)
    .extract({ left: bx, top: by, width: bw, height: bh })
    .png()
    .toBuffer();

  // Where the user's lasso sits WITHIN this (generous) crop. Because the crop is
  // padded out to grab whole objects, it often ALSO contains neighbouring objects;
  // without telling the model which one the user pointed at, a "remove this" edit
  // hit the wrong / more prominent object (the "it removed a different object" bug).
  // So pin the target by its position + extent inside the crop.
  const selCx = clamp(((minX + maxX) / 2 - bx) / bw, 0, 1);
  const selCy = clamp(((minY + maxY) / 2 - by) / bh, 0, 1);
  const hPos = selCx < 0.34 ? "left" : selCx > 0.66 ? "right" : "horizontally-centred";
  const vPos = selCy < 0.34 ? "top" : selCy > 0.66 ? "bottom" : "vertically-middle";
  const where =
    `The user's selection is centred at about ${Math.round(selCx * 100)}% from the left and ` +
    `${Math.round(selCy * 100)}% from the top of this image — the ${vPos} ${hPos} area. The ` +
    `TARGET of the edit is the object/surface at THAT spot.`;

  const isRemoval = /\b(remove|delete|erase|get rid of|take out|clear)\b/i.test(instruction);
  const removalClause = isRemoval
    ? `\nThis is a REMOVAL: COMPLETELY ERASE the target object and realistically rebuild the floor, rug, wall and surfaces that were behind it, so that spot looks naturally EMPTY — as if the object had never been there. Leave NO ghost, outline, silhouette or floating shadow of it. (Removing the target IS the requested change — do it confidently; just don't touch the OTHER objects.)`
    : "";
  const refClause = ref
    ? `\nIMAGE 2 is a REFERENCE the user uploaded for this change — use it as the visual guide for the new object / material / finish (its shape, colour, material and design), but adapt it to THIS room's exact camera angle, perspective, scale, lighting and shadows so it sits naturally. Do NOT copy IMAGE 2's background or framing.`
    : "";
  const prompt = `You are editing a region (IMAGE 1) of a photorealistic interior design photograph.
Edit: ${instruction.trim() || "refine this region"}.${refClause}
${where}${removalClause}
Apply the change to the WHOLE of that ONE target object/surface (e.g. the entire sofa, or the entire wall it sits on) — the selection only marks WHERE the target is, not how much of it to change, so don't stop at an arbitrary edge. Do NOT alter, move, recolour or remove any OTHER object in the image — change ONLY the target at the location above and leave the other distinct objects as they are.
If the edit ADDS an object, give it a natural, realistic size and spacing at that location (don't cram it).
Make the change photorealistic and consistent with the surrounding room — match the existing
camera angle, perspective, lighting, scale, shadows and reflections, in a "${style.name}" interior style.
Return the full edited image at the same dimensions.`;

  return {
    baseBuf,
    cropDataUri: `data:image/png;base64,${cropBuf.toString("base64")}`,
    refDataUri: ref ? `data:${ref.mime};base64,${ref.data}` : null,
    prompt,
    bx,
    by,
    bw,
    bh,
  };
}

/**
 * Edit the lasso region of `baseDataUri` per `instruction` using Nano Banana
 * (direct Google API), compositing the change back through `maskDataUri` so
 * only that area changes. Thin wrapper around `planCropEdit` — see that
 * function for the actual crop/pad/prompt logic, which is shared with the
 * Runware Nano-Banana path in `runware-client.ts`.
 */
export async function editImageWithGemini(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  /** optional reference image (data URI) the user uploaded to guide the change */
  reference?: string,
  signal?: AbortSignal,
): Promise<EditedImage | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const plan = await planCropEdit(baseDataUri, maskDataUri, instruction, style, reference);
  if (!plan) return null;
  const crop = parseDataUri(plan.cropDataUri);
  const ref = plan.refDataUri ? parseDataUri(plan.refDataUri) : null;

  const editedBuf = await callImageModel(
    [
      { text: plan.prompt },
      { inlineData: { mimeType: crop.mime, data: crop.data } },
      ...(ref ? [{ inlineData: { mimeType: ref.mime, data: ref.data } }] : []),
    ],
    "nano-banana",
    signal,
  );
  if (!editedBuf) return null;

  // Composite the edited crop back into the base over the WHOLE crop region.
  try {
    return await compositeCrop(plan.baseBuf, editedBuf, plan.bx, plan.by, plan.bw, plan.bh);
  } catch (e) {
    console.warn("[nano-banana] composite failed:", (e as Error).message);
    return null;
  }
}

/**
 * Paint the edited crop back over the base at (bx,by) through a FEATHERED
 * RECTANGLE covering the whole crop — NOT the strict lasso shape. The lasso only
 * LOCATES the edit; the crop (its bbox + generous padding) is what changes. This
 * is what fixes the "selection too small → broken / half-edited object" bug: a
 * partial lasso of a cupboard still re-skins the WHOLE cupboard, because Nano
 * left every non-target pixel in the crop untouched, so writing the whole region
 * back is a no-op everywhere except the actual edit. Far background outside the
 * crop stays byte-identical; the feathered border hides the seam.
 */
export async function compositeCrop(
  baseBuf: Buffer,
  editedBuf: Buffer,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): Promise<EditedImage> {
  const editedRGB = await sharp(editedBuf)
    .resize(bw, bh, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Feathered-rectangle alpha: opaque interior, soft fade at the crop edges so the
  // re-skinned region blends into the untouched surroundings.
  const feather = clamp(Math.round(Math.min(bw, bh) * 0.12), 4, 48);
  const innerW = Math.max(1, bw - 2 * feather);
  const innerH = Math.max(1, bh - 2 * feather);
  const alphaSvg = `<svg width="${bw}" height="${bh}"><rect width="${bw}" height="${bh}" fill="#000"/><rect x="${feather}" y="${feather}" width="${innerW}" height="${innerH}" fill="#fff"/></svg>`;
  const alpha = await sharp(Buffer.from(alphaSvg))
    .flatten({ background: "#000" })
    .greyscale()
    .blur(Math.max(1, feather * 0.7))
    .raw()
    .toBuffer();

  const rgba = Buffer.alloc(bw * bh * 4);
  for (let i = 0; i < bw * bh; i++) {
    rgba[i * 4] = editedRGB[i * 3];
    rgba[i * 4 + 1] = editedRGB[i * 3 + 1];
    rgba[i * 4 + 2] = editedRGB[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const editLayer = await sharp(rgba, { raw: { width: bw, height: bh, channels: 4 } })
    .png()
    .toBuffer();

  const out = await sharp(baseBuf)
    .composite([{ input: editLayer, left: bx, top: by, blend: "over" }])
    .png()
    .toBuffer();

  return { bytes: out, contentType: "image/png" };
}

/**
 * Read back a rendered HERO photo and describe its EXACT look as text, so the
 * room's other camera angles can be rendered to MATCH it without being handed the
 * hero image. Handing a view the finished hero photo makes the model copy the
 * hero's whole composition, collapsing every angle into the same shot; a textual
 * look-spec transfers the colours/materials/furniture design while each view's own
 * 3D screenshot keeps the camera distinct. Uses the text/vision model (a separate
 * quota bucket from the image model). Returns null on failure → caller renders
 * with the base prompt only (distinct angle, looser look match).
 */
export async function describeRoomLook(
  heroDataUri: string,
  style: DesignStyle,
  signal?: AbortSignal,
): Promise<string | null> {
  const hero = parseDataUri(heroDataUri);
  const out = await generateJson<{ look?: string }>(
    [
      {
        text: `This is a finished "${style.name}" interior photograph. Describe its EXACT visual identity in ONE dense paragraph so the SAME room can be re-rendered from a different camera angle and look identical. Be specific about concrete colours and materials, covering: the wall colour and finish; the feature/accent wall material, colour and panelling; the flooring; the ceiling and its cove/recessed lighting; EACH furniture piece's colour, material and design (e.g. the bed and headboard colour + upholstery, the bed-linen colours, the wardrobe wood tone and finish, side tables); the curtains' colour and fabric; metal/brass accents; the rug; and the overall lighting mood and colour temperature. ALSO state the furniture LAYOUT — which wall or side of the room each major piece sits against and how the pieces are arranged relative to each other (e.g. "L-shaped sofa along the left and rear walls, TV unit on the feature wall opposite the sofa, coffee table centred on the rug") so the SAME furniture arrangement is reproduced from every angle. That layout describes the room's FIXED arrangement, not the viewpoint — do NOT mention the camera angle, viewpoint or composition. Return JSON: { "look": string }.`,
      },
      { inlineData: { mimeType: hero.mime, data: hero.data } },
    ],
    { temperature: 0.2, thinkingBudget: 0, maxOutputTokens: 700, signal },
  );
  const look = out?.look?.trim();
  return look && look.length > 30 ? look : null;
}

/**
 * Anchor-conditioned view render. Splits authority between the two inputs so the
 * result is the SAME room from a GENUINELY different angle (not three different
 * rooms, and not three copies of the anchor):
 *
 *   `structureDataUri` — the 3D-scene screenshot for THIS angle → owns the CAMERA,
 *                        composition and what's in shot.
 *   `anchorDataUri`    — the finished hero render → owns ONLY the look (materials,
 *                        furniture design, colours, lighting), never the camera.
 *
 * Leading with the anchor / over-stressing "identical" makes the model just
 * reproduce the anchor (every angle looks the same), so the screenshot leads and
 * the prompt forbids copying the anchor's framing.
 *
 * Returns null on any failure so the caller can fall back to FLUX img2img.
 */
export async function renderViewFromAnchor(
  anchorDataUri: string,
  structureDataUri: string,
  view: string,
  style: DesignStyle,
  notes?: string,
  /** Distinct camera framing for this view (so it doesn't converge to the hero). */
  cameraDesc?: string,
  /**
   * The room's deterministic design identity (furniture list + palette + materials
   * + focal point), the SAME text the hero was grounded in. Spells out the look in
   * WORDS as well as pixels, so a view stays the same room even if the model
   * under-weights the anchor image on a given roll.
   */
  identityBrief?: string,
  signal?: AbortSignal,
): Promise<EditedImage | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const anchor = parseDataUri(anchorDataUri);
  const structure = parseDataUri(structureDataUri);

  const camera = cameraDesc?.trim() || `the ${view} camera`;
  const brief = notes?.trim() ? `\nHonour this design brief: ${notes.trim()}.` : "";
  const identity = identityBrief?.trim()
    ? `\nThis exact room contains (never substitute, recolour, add or remove any of it; render each piece only where IMAGE 1's camera shows it):\n${identityBrief.trim()}`
    : "";
  // Framed as "re-skin IMAGE 1", NOT "match IMAGE 2": telling the model to make
  // the result look like the anchor made it copy the anchor's whole frame (the
  // documented "all views identical" failure). The rough screenshot is the SOLE
  // camera/geometry authority; the anchor is demoted to a colour/material swatch;
  // the identity text pins the look in words too. Kept deliberately tight — piling
  // on redundant "same room" clauses pushes the model back toward the IMAGE 2
  // pixel prior (the very collapse to avoid).
  const prompt = `IMAGE 1 is a rough 3D massing screenshot of this room from ${camera} (the ${view} view). IMAGE 1 is the ONLY authority for the camera, framing, perspective, and which walls, windows, doors and furniture are in shot and where they sit. Reproduce IMAGE 1's geometry and layout faithfully.
IMAGE 2 is a finished photo of the SAME room from a DIFFERENT camera. Use it ONLY as a colour-and-material swatch: wood tone, stone/marble, metal/brass finish, wall colour, flooring, ceiling and cove-lighting treatment, fabric colours, and the design of each furniture piece. Take ZERO camera, geometry or composition from IMAGE 2.${identity}
TASK: re-skin IMAGE 1 into a photorealistic interior photograph — keep IMAGE 1's geometry and the placement of every wall, window, door and furniture piece, and dress every surface in the materials and colours above and in IMAGE 2. Any wall or furniture that IMAGE 1 shows but IMAGE 2 does not must be rendered in those SAME materials and colours — never invent a new palette for newly revealed surfaces. Exactly ONE of each piece; add no extra furniture, plants, lamps, art or props. Do NOT copy, mirror or re-derive IMAGE 2's framing or its set of visible walls/furniture — that is a failure.
Style: "${style.name}".${brief}
Photorealistic, interior-design magazine quality, realistic materials, lighting, shadows and reflections; no people, no text or watermarks. Return only the rendered image.`;

  const outBuf = await callImageModel(
    [
      { text: prompt },
      // IMAGE 1 = the 3D screenshot (camera authority).
      { inlineData: { mimeType: structure.mime, data: structure.data } },
      // IMAGE 2 = the hero render (look authority).
      { inlineData: { mimeType: anchor.mime, data: anchor.data } },
    ],
    "nano-banana view",
    signal,
  );
  if (!outBuf) return null;

  // Match the anchor's dimensions so a room's views stay a consistent size
  // (keeps the gallery tidy and the 360° merge well-aligned).
  try {
    const meta = await sharp(Buffer.from(anchor.data, "base64")).metadata();
    if (meta.width && meta.height) {
      const out = await sharp(outBuf).resize(meta.width, meta.height, { fit: "fill" }).png().toBuffer();
      return { bytes: out, contentType: "image/png" };
    }
  } catch {
    /* fall through to the raw bytes */
  }
  return { bytes: outBuf, contentType: "image/png" };
}

/**
 * Hero render. Turns a single rough 3D screenshot of a room into a photorealistic
 * photograph, grounded by `description` (the deterministic furniture/style brief).
 * This is the FIRST view rendered for a room; the other angles are then anchored
 * to it via {@link renderViewFromAnchor}. Nano Banana produces far richer, fully
 * furnished interiors here than strength-0.93 FLUX img2img (which tended to wash
 * the room back to an empty shell), so it's the primary hero engine; the caller
 * falls back to FLUX when this returns null.
 */
export async function renderPhotorealFromScreenshot(
  structureDataUri: string,
  description: string,
  view: string,
  style: DesignStyle,
  /** Per-furniture reference images: render the named piece to match its look. */
  references?: { label: string; image: string }[],
  /** Whole-room reference image: match the overall style/materials/mood. */
  styleRef?: string,
  signal?: AbortSignal,
): Promise<EditedImage | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  const structure = parseDataUri(structureDataUri);

  // Whole-room style reference (matched for overall look, not a specific piece).
  let styleInline: { mime: string; data: string } | null = null;
  if (styleRef) {
    const p = parseDataUri(styleRef);
    try {
      const small = await sharp(Buffer.from(p.data, "base64"))
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      styleInline = { mime: "image/jpeg", data: small.toString("base64") };
    } catch {
      styleInline = p;
    }
  }

  // Downscale + inline any furniture reference images (visual guides only — a
  // big reference just slows the call). Each maps to a named piece in the prompt.
  const refInlines: { mime: string; data: string }[] = [];
  const refLabels: string[] = [];
  for (const r of references ?? []) {
    if (!r?.image || !r?.label?.trim()) continue;
    const p = parseDataUri(r.image);
    try {
      const small = await sharp(Buffer.from(p.data, "base64"))
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      refInlines.push({ mime: "image/jpeg", data: small.toString("base64") });
    } catch {
      refInlines.push(p);
    }
    refLabels.push(r.label.trim());
  }
  const styleClause = styleInline
    ? `\nThe image immediately AFTER the screenshot is a WHOLE-ROOM STYLE REFERENCE — match its overall colours, materials, finishes, furniture style and lighting mood, while keeping THIS room's exact layout, proportions and camera. Take only the look from it, not its specific layout or framing.`
    : "";
  const refClause = refLabels.length
    ? `\nThe ${styleInline ? "remaining images" : "images"} after the screenshot are FURNITURE REFERENCES, in this order: ${refLabels
        .map((l, i) => `(${i + 1}) the ${l}`)
        .join(", ")}. Render each of those pieces to MATCH its reference's shape, colour, material and design, but adapt it to THIS room's camera angle, scale, lighting and shadows. Take ONLY the furniture's appearance from the references — ignore their backgrounds and framing.`
    : "";

  const prompt = `IMAGE 1 is a rough 3D massing screenshot of an interior room (the ${view} view): plain
coloured boxes stand in for the furniture and the room shell.
Turn it into a photorealistic interior photograph. Keep the EXACT same room layout, the same furniture
in the same positions, the same proportions and dimensions, the same wall / window / door positions,
and the SAME camera angle, framing and perspective as the screenshot — do not move, add or remove anything.
CRITICAL: match the screenshot's exact viewpoint. If it is an angled / corner view, keep it angled (two
walls receding to a corner); do NOT straighten it into a flat, head-on, frontal shot.
CRITICAL — SCALE: render the room at the EXACT real dimensions and the furniture at the EXACT sizes stated below; the space must read at the SAME size and spaciousness here as in every other view of this room (do not make it look more spacious or more cramped than its stated square footage).
CRITICAL — STAND-INS: every plain coloured box is ONLY a placeholder for the real furniture at that spot — replace EACH box with the actual photorealistic item it represents (matching the furniture list below) and NEVER leave a plain box, cube or slab in the final image. In particular, a GREEN box/cube is a POTTED PLANT: render a real plant with natural green foliage in a planter — NEVER a green block, cube or pedestal.
${description}${styleClause}${refClause}
Photorealistic, interior-design magazine quality, realistic materials, lighting, shadows and
reflections, no people. Return only the rendered image.`;

  const outBuf = await callImageModel(
    [
      { text: prompt },
      { inlineData: { mimeType: structure.mime, data: structure.data } },
      ...(styleInline ? [{ inlineData: { mimeType: styleInline.mime, data: styleInline.data } }] : []),
      ...refInlines.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data } })),
    ],
    "nano-banana hero",
    signal,
  );
  if (!outBuf) return null;

  // Keep the hero at the screenshot's dimensions so every view (anchored to it)
  // stays a consistent size.
  try {
    const meta = await sharp(Buffer.from(structure.data, "base64")).metadata();
    if (meta.width && meta.height) {
      const out = await sharp(outBuf).resize(meta.width, meta.height, { fit: "fill" }).png().toBuffer();
      return { bytes: out, contentType: "image/png" };
    }
  } catch {
    /* fall through to the raw bytes */
  }
  return { bytes: outBuf, contentType: "image/png" };
}

/**
 * Combine several photos of the SAME room (front / side / corner) into one
 * seamless equirectangular 360° panorama, so the 360 view matches the rendered
 * views instead of being an unrelated room. Normalised to 2:1 for the sphere
 * viewer. Returns null on failure (caller can fall back to a text-to-image pano).
 */
export async function makePanoramaFromViews(
  images: string[],
  style: DesignStyle,
  signal?: AbortSignal,
): Promise<EditedImage | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || images.length === 0) return null;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text: `The attached photograph(s) are of ONE SINGLE "${style.name}" interior room${
        images.length > 1 ? ", shot from several angles of the SAME room (the SAME furniture and finishes seen from different sides)" : ""
      }. The FIRST photo is the definitive look of the room.
Produce ONE seamless equirectangular 360° panorama of THIS EXACT room — 2:1 aspect ratio, full 360° horizontal wraparound, photorealistic — keeping the same design, furniture, materials, colours and lighting.
CRITICAL: this is a SINGLE room with exactly ONE of each furniture piece (e.g. ONE bed). Do NOT duplicate any furniture, do NOT add a second bed, and do NOT invent a different design — the panorama must be the same room wrapped around, not two rooms stitched together. Return only the panorama image.`,
    },
  ];
  for (const img of images) {
    const p = parseDataUri(img);
    parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
  }

  const panoBuf = await callImageModel(parts, "nano-banana pano", signal);
  if (!panoBuf) return null;

  // Normalise to 2:1 so the equirectangular sphere viewer maps it correctly.
  try {
    const out = await sharp(panoBuf).resize(1408, 704, { fit: "fill" }).png().toBuffer();
    return { bytes: out, contentType: "image/png" };
  } catch {
    return { bytes: panoBuf, contentType: "image/png" };
  }
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
  }[];
}
