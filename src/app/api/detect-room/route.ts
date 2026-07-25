/**
 * Per-room detection of doors / windows / furniture.
 *
 * Re-crops the ORIGINAL uploaded plan image down to ONE room and asks Gemini
 * vision what is drawn inside it. Detecting per room (rather than once over the
 * whole sheet) is what makes this reliable: a busy full sheet sends the model
 * into a repetition loop (hundreds of duplicate boxes, MAX_TOKENS, unstable
 * run-to-run counts), whereas a single room is a small, clean image.
 *
 * The mapping is exact and comes from the plan's own meta:
 *   source pixel = plan feet / scaleFtPerPx   (image origin = plan origin)
 * so detected boxes convert straight back into absolute plan feet.
 *
 * Returns ONLY what is actually drawn — a plan with no furniture yields none.
 * Never invents (see the no-dummy-data rule); the client then snaps openings to
 * the room's walls and places furniture, all of it user-editable afterwards.
 */

import sharp from "sharp";
import { generateJson, geminiConfigured, type GeminiPart } from "@/lib/pipeline/gemini-client";
import { getObject } from "@/lib/pipeline/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  storageKey?: string;
  /** the plan's px→ft transform (see PlanMeta): px = ft / ftPerPx + originPx */
  originPxX?: number;
  originPxY?: number;
  ftPerPxX?: number;
  ftPerPxY?: number;
  /**
   * The image size the transform was measured on (PlanMeta.imageWidth/Height —
   * the geometry detector works at a capped resolution). The STORED image can be
   * larger (small uploads are upscaled at ingest), so crop coords are scaled by
   * stored/detector. Omitted on legacy plans → the two are assumed equal.
   */
  imageWidth?: number;
  imageHeight?: number;
  room?: { x: number; y: number; width: number; height: number; name?: string; type?: string };
}

interface RawItem {
  type?: string;
  name?: string;
  box_2d?: number[];
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["door", "window", "furniture"] },
          name: { type: "STRING" },
          box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
        },
        required: ["type", "box_2d"],
        propertyOrdering: ["type", "name", "box_2d"],
      },
    },
    // The room's PRINTED label + size, exactly as written on the plan ("BEDROOM",
    // "12'3\"X9'1\""). Empty strings when not printed/visible in this crop.
    // REQUIRED: optional fields simply get omitted by constrained decoding.
    label_text: { type: "STRING" },
    size_text: { type: "STRING" },
  },
  required: ["items", "label_text", "size_text"],
} as const;

const prompt = (roomName: string) => `This image is a crop of ONE room ("${roomName}") from an
architectural floor plan (top-down). Detect ONLY what is actually DRAWN inside it.

- door: a wall opening, usually a quarter-circle swing arc + a leaf line (often tagged D / D1 / MD).
- window: a wall opening drawn as 2-4 thin parallel lines across the wall.
- furniture: bed, sofa, chair, dining table, wardrobe, kitchen platform, sink, stove,
  WC/toilet, wash basin. NOT text, NOT dimension lines, NOT structural columns, NOT stairs.

CRITICAL: if this room has NO furniture drawn, return NO furniture items. Many
structural plans draw none — never infer a bed just because the room is a bedroom.
Report only symbols you can actually SEE.

Also read the room's PRINTED text, if any is visible inside this crop:
- label_text: the room's printed name exactly as written (e.g. "BEDROOM", "LIVING & DINING"). "" if none.
- size_text: the room's printed size exactly as written (e.g. "12'3\"X9'1\"", "3230 X 2740"). "" if none.
Copy them character-for-character — do not normalise or invent.

Rules:
- At most 25 items. Each real symbol appears exactly ONCE; never repeat a box.
- box_2d = [ymin,xmin,ymax,xmax], integers 0-1000 within THIS image. Never exceed 1000.

Return JSON: {"items":[{"type":"door|window|furniture","name":"<short label>","box_2d":[ymin,xmin,ymax,xmax]}],"label_text":"...","size_text":"..."}`;

/**
 * Parse a printed room size ("12'3\"X9'1\"", "12'-3\" x 9'-1\"", "3230 X 2740",
 * "3.2 X 2.7 M") into feet. Deterministic — returns null rather than guessing.
 */
function parsePrintedSize(text: string): { w: number; h: number } | null {
  const t = (text || "").trim();
  if (!t) return null;
  // feet-inches: 12'3" X 9'1"  (inches optional, hyphens/spaces tolerated)
  const fi = t.match(
    /(\d{1,2})\s*'\s*-?\s*(\d{1,2})?\s*(?:"|”|'')?\s*[xX×]\s*(\d{1,2})\s*'\s*-?\s*(\d{1,2})?\s*(?:"|”|'')?/,
  );
  if (fi) {
    const w = Number(fi[1]) + (fi[2] ? Number(fi[2]) / 12 : 0);
    const h = Number(fi[3]) + (fi[4] ? Number(fi[4]) / 12 : 0);
    if (w >= 2 && h >= 2 && w <= 80 && h <= 80) return { w, h };
  }
  // plain numbers: mm when large (3230 X 2740), metres when small with M/decimal
  const nn = t.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(M|MM|MTR)?/i);
  if (nn) {
    let w = Number(nn[1]);
    let h = Number(nn[2]);
    const unit = (nn[3] || "").toUpperCase();
    if (unit === "MM" || (!unit && w > 100)) {
      w /= 304.8;
      h /= 304.8;
    } else if (unit === "M" || unit === "MTR" || (!unit && w < 15 && String(nn[1]).includes("."))) {
      w *= 3.28084;
      h *= 3.28084;
    }
    if (w >= 2 && h >= 2 && w <= 80 && h <= 80) {
      return { w: Math.round(w * 12) / 12, h: Math.round(h * 12) / 12 };
    }
  }
  return null;
}

export async function POST(request: Request) {
  if (!geminiConfigured()) {
    return Response.json(
      { error: "Gemini isn't configured. Set GEMINI_API_KEY to enable detection." },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { storageKey, originPxX, originPxY, ftPerPxX, ftPerPxY, room } = body;
  if (!storageKey || !ftPerPxX || !ftPerPxY || originPxX === undefined || originPxY === undefined || !room) {
    return Response.json(
      {
        error:
          "This plan was imported before per-room detection existed, so it has no link back to its source image. Re-import the plan to enable it.",
      },
      { status: 400 },
    );
  }
  if (!storageKey.startsWith("plans/")) {
    return Response.json({ error: "Invalid storage key" }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = await getObject(storageKey);
  } catch {
    return Response.json({ error: "The original plan image is no longer in storage." }, { status: 404 });
  }

  // room (feet) -> source pixels by INVERTING the plan's transform, with ~1ft of
  // context so wall openings on the room's own boundary are inside the crop.
  const img = sharp(bytes);
  const meta = await img.metadata();
  const iw = meta.width ?? 0;
  const ih = meta.height ?? 0;
  if (!iw || !ih) {
    return Response.json({ error: "Couldn't read the plan image." }, { status: 502 });
  }
  // The transform lives in DETECTOR space; the stored image may be larger
  // (ingest upscaling). kx/ky bridge the two — without this, crops on an
  // upscaled plan land on the wrong quadrant of the image.
  const kx = body.imageWidth ? iw / body.imageWidth : 1;
  const ky = body.imageHeight ? ih / body.imageHeight : 1;
  const toPxX = (ft: number) => (ft / ftPerPxX + originPxX) * kx;
  const toPxY = (ft: number) => (ft / ftPerPxY + originPxY) * ky;
  const mx = kx / ftPerPxX; // ~1ft of context, in stored-image px
  const my = ky / ftPerPxY;
  const cx0 = Math.max(0, Math.round(toPxX(room.x) - mx));
  const cy0 = Math.max(0, Math.round(toPxY(room.y) - my));
  const cx1 = Math.min(iw, Math.round(toPxX(room.x + room.width) + mx));
  const cy1 = Math.min(ih, Math.round(toPxY(room.y + room.height) + my));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw < 8 || ch < 8) {
    return Response.json({ error: "This room maps to too small an area of the plan image." }, { status: 400 });
  }

  // upscale small crops so thin door/window lines stay legible to the model
  const target = 1400;
  const zoom = Math.min(4, Math.max(1, target / Math.max(cw, ch)));
  const jpeg = await sharp(bytes)
    .extract({ left: cx0, top: cy0, width: cw, height: ch })
    .resize({ width: Math.round(cw * zoom), height: Math.round(ch * zoom), fit: "fill" })
    .jpeg({ quality: 92 })
    .toBuffer();

  const parts: GeminiPart[] = [
    { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
    { text: prompt(room.name || "room") },
  ];
  const raw = await generateJson<{ items?: RawItem[]; label_text?: string; size_text?: string }>(
    parts,
    {
      temperature: 0,
      thinkingBudget: 0,
      maxOutputTokens: 4096,
      responseSchema: SCHEMA,
    },
  );
  if (!raw) {
    return Response.json(
      { error: "Gemini didn't return a detection for this room — retry in a moment." },
      { status: 502 },
    );
  }

  // boxes (0-1000 of the crop) -> absolute plan feet, PLUS fractions of the room
  // box itself. The fractions matter when the caller corrects the room's size to
  // the printed dimensions: mapping by fraction lands each piece at its true spot
  // in the CORRECTED room, instead of inheriting the eroded pixel-box error.
  const out: {
    type: string;
    name: string;
    x: number;
    y: number;
    w: number;
    d: number;
    fx: number;
    fy: number;
    fw: number;
    fd: number;
  }[] = [];
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  for (const it of raw.items ?? []) {
    const b = it.box_2d;
    if (!b || b.length !== 4) continue;
    if (b.some((v) => typeof v !== "number" || v < 0 || v > 1000)) continue;
    const [ymin, xmin, ymax, xmax] = b;
    if (ymax - ymin < 2 || xmax - xmin < 2) continue;
    const type = it.type === "door" || it.type === "window" ? it.type : "furniture";
    // crop-relative 0-1000 -> stored px -> detector px (÷k) -> plan feet
    const px0 = cx0 + (xmin / 1000) * cw;
    const px1 = cx0 + (xmax / 1000) * cw;
    const py0 = cy0 + (ymin / 1000) * ch;
    const py1 = cy0 + (ymax / 1000) * ch;
    const toFtX = (px: number) => (px / kx - originPxX) * ftPerPxX;
    const toFtY = (py: number) => (py / ky - originPxY) * ftPerPxY;
    const wFt = ((px1 - px0) / kx) * ftPerPxX;
    const dFt = ((py1 - py0) / ky) * ftPerPxY;
    // fractions of the ROOM's feet box (not the crop — the crop has margin)
    const fx = (toFtX(px0) - room.x) / room.width;
    const fy = (toFtY(py0) - room.y) / room.height;
    out.push({
      type,
      name: (it.name || type).slice(0, 40),
      x: r1(toFtX(px0)),
      y: r1(toFtY(py0)),
      w: r1(wFt),
      d: r1(dFt),
      fx: r3(fx),
      fy: r3(fy),
      fw: r3(wFt / room.width),
      fd: r3(dFt / room.height),
    });
  }

  // The room's printed truth, when legible: its name and its REAL size. The
  // printed size is the architect's own number — far more accurate than the
  // eroded pixel box (which ran ~1-1.5 ft short on real uploads).
  const printed = parsePrintedSize(raw.size_text ?? "");
  const label = {
    name: (raw.label_text ?? "").trim().slice(0, 40) || undefined,
    sizeText: (raw.size_text ?? "").trim().slice(0, 40) || undefined,
    printedWidthFt: printed ? r1(printed.w) : undefined,
    printedHeightFt: printed ? r1(printed.h) : undefined,
  };

  return Response.json({ items: out, label });
}
