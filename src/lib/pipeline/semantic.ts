/**
 * Gemini stage — plan understanding.
 *
 * Primary path (`gemini-vision`): send the actual plan IMAGE to Gemini and have
 * it reconstruct the full layout from the *printed dimensions* — every room's
 * name, type, size in feet, and top-left position, plus the overall building
 * envelope. For dimensioned plans this is dramatically more accurate than
 * measuring pixels, because the plan literally states each dimension. The Merge
 * Engine then builds geometry directly from these real feet values.
 *
 * Fallback path (`gemini-flash` / `fallback`): when no image is available or the
 * vision call fails, reason over the OCR tokens for room names/types only, and
 * geometry comes from OpenCV downstream.
 */

import { generateJson, geminiConfigured, type GeminiPart } from "./gemini-client";
import { downscaleForGemini } from "./image-utils";
import type {
  OcrResult,
  SemanticFurniture,
  SemanticOpening,
  SemanticPlan,
  SemanticRoom,
} from "./types";

const VISION_PROMPT = `Analyze this architectural floor plan, which has its dimensions printed on it.
Reconstruct the layout. Return JSON:
{
  "overallWidthFt": number,   // total building width from the OUTER dimension chain
  "overallHeightFt": number,  // total building height from the OUTER dimension chain
  "buildingBox": [ymin,xmin,ymax,xmax],   // bounding box of the OUTER WALLS only — EXCLUDE the
                                          // dimension lines and number labels around the plan. 0-1000.
  "rooms": [
    { "name": string,
      "type": "bedroom"|"bathroom"|"kitchen"|"living"|"dining"|"hall"|"office"|"utility"|"store"|"balcony"|"pooja"|"other",
      "widthFt": number,    // the room's width from its PRINTED dimension label
      "heightFt": number,   // the room's height from its PRINTED dimension label
      "box": [ymin,xmin,ymax,xmax],   // the room's rectangle's location IN THE IMAGE, 0-1000
      "adjacentTo": [string] }        // names of the rooms this room SHARES A WALL with
  ],
  "doors":   [ { "box":[ymin,xmin,ymax,xmax], "orientation":"h"|"v" } ],  // each door opening, image coords 0-1000
  "windows": [ { "box":[ymin,xmin,ymax,xmax], "orientation":"h"|"v" } ]   // each window opening, image coords 0-1000
}
Rules:
- THIS MAY BE A MULTI-UNIT FLOOR: several apartments / flats arranged around shared
  corridors, a lift and a staircase. Enumerate EVERY labelled room in EVERY unit across the
  WHOLE sheet — a typical floor has 30-60 rooms. List them ALL: never stop early, summarise,
  or collapse repeated room types. Each flat has its OWN Bedroom 01 / 02 / 03, Living/Dining,
  Kitchen, Bath(s) and Balcony — every one is a SEPARATE room object. Also include any labelled
  shared / service spaces: corridor, lobby, lift, staircase, OTS (open-to-sky shaft / cut-out),
  utility, balcony, standing balcony.
- For EVERY room return BOTH its image "box" AND its printed "widthFt"/"heightFt". Both are
  required — the box gives the location, the printed dimensions give the true size and calibrate
  the whole plan's scale.
- Convert feet-inches to decimal feet (5'-7" -> 5.58, 10" -> 0.83). Read dimensions like
  10'-0"X12'-1" as widthFt 10.0, heightFt 12.08.
- "box" is used for PLACEMENT — make it the true location of the room in the image.
- "widthFt"/"heightFt" are used for SIZE — read them from the printed dimensions, not the box.
- "adjacentTo" = every other room whose wall this room directly touches (shares a wall),
  using their exact names. This captures the real adjacency so rooms can be packed flush.
- "doors"/"windows" = every door and window OPENING you can see, with its box in image
  coords; orientation "h" if it runs left-right, "v" if up-down. Windows are the thin
  rectangles / double-line breaks on the OUTER walls (often a different colour) — find ALL of
  them; never return an empty "windows" list if any are drawn. Return [] only when truly none
  exist — never invent openings.
- Use the actual room labels printed on the plan. Skip annotations that aren't rooms.
- Never invent rooms or dimensions that aren't drawn.`;

// Dense, dimensioned multi-unit plans have small per-room labels that are
// unreadable at 1280 px — send a larger image so Gemini can read every label and
// dimension (Gemini tiles it internally for detail). Bigger = more rooms found.
const VISION_MAX_DIM = 2560;

type Box = [number, number, number, number]; // [ymin, xmin, ymax, xmax], 0-1000

interface RawOpening {
  box?: number[];
  orientation?: string;
}

// Constrained-decoding schemas for the structured vision reads. JSON mode alone
// can spiral into a degenerate repetition loop (observed: 63,871 chars straight
// to the 32k-token cap, unrecoverable even by the salvage parser); the schema
// pins the decoder to this structure. Room "type" stays a free string — the
// mapper falls back to inferType() for anything off-list, which is safer than
// forcing the model to pick a wrong enum member for e.g. a staircase.
// NOTE: no minItems/maxItems anywhere — array bounds (especially nested ones
// like a 4-number box inside rooms) make Gemini reject the whole schema with
// 400 "constraint has too many states for serving". Structure enforcement alone
// stops the prose/fence drift; repetition loops are contained by the tuned-down
// maxOutputTokens on each call plus the salvage parser.
const BOX_SCHEMA = { type: "ARRAY", items: { type: "NUMBER" } } as const;
const OPENING_SCHEMA = {
  type: "OBJECT",
  properties: { box: BOX_SCHEMA, orientation: { type: "STRING", enum: ["h", "v"] } },
  required: ["box"],
} as const;
const VISION_SCHEMA = {
  type: "OBJECT",
  properties: {
    overallWidthFt: { type: "NUMBER" },
    overallHeightFt: { type: "NUMBER" },
    buildingBox: BOX_SCHEMA,
    rooms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          type: { type: "STRING" },
          widthFt: { type: "NUMBER" },
          heightFt: { type: "NUMBER" },
          box: BOX_SCHEMA,
          adjacentTo: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["name"],
        propertyOrdering: ["name", "type", "widthFt", "heightFt", "box", "adjacentTo"],
      },
    },
    doors: { type: "ARRAY", items: OPENING_SCHEMA },
    windows: { type: "ARRAY", items: OPENING_SCHEMA },
  },
  required: ["rooms"],
  propertyOrdering: [
    "overallWidthFt",
    "overallHeightFt",
    "buildingBox",
    "rooms",
    "doors",
    "windows",
  ],
} as const;

interface RawVision {
  overallWidthFt?: number;
  overallHeightFt?: number;
  buildingBox?: number[];
  rooms?: {
    name?: string;
    type?: string;
    widthFt?: number;
    heightFt?: number;
    box?: number[];
    adjacentTo?: string[];
  }[];
  doors?: RawOpening[];
  windows?: RawOpening[];
}

/**
 * Build a structured plan. Pass the image bytes for the accurate vision
 * reconstruction; without them, falls back to OCR-token reasoning.
 */
export async function understandPlan(
  ocr: OcrResult | (() => Promise<OcrResult>),
  bytes?: Buffer,
  mimeType?: string,
): Promise<SemanticPlan> {
  // Primary: full reconstruction from the image's printed dimensions. This path
  // does NOT use OCR, so when `ocr` is a provider it's never called here — the
  // expensive full-transcription pass is skipped whenever vision succeeds.
  if (bytes && mimeType && geminiConfigured()) {
    const vision = await reconstructFromImage(bytes, mimeType);
    if (vision) return vision;
  }
  // Fallback: reason over OCR tokens for names/types only (resolve lazily).
  const resolved = typeof ocr === "function" ? await ocr() : ocr;
  return understandFromTokens(resolved);
}

async function reconstructFromImage(
  bytes: Buffer,
  _mimeType: string,
): Promise<SemanticPlan | null> {
  const img = await downscaleForGemini(bytes, VISION_MAX_DIM);
  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: VISION_PROMPT },
  ];

  // thinkingBudget 0 — 2.5-flash vision calls get slow + 503-prone ("model
  // overloaded") with a thinking pass, falling back to the position-less token
  // path (→ 0 placed rooms). Reliability matters more than the few extra rooms a
  // thinking pass finds; the higher resolution + multi-unit prompt already drive
  // enumeration. maxOutputTokens still stops a 50-room JSON being truncated.
  // 16k tokens comfortably fits even a 60-room sheet (~10k tokens of JSON) while
  // halving the decode time wasted if the model ever loops to the cap — the
  // salvage parser recovers the valid prefix either way.
  const raw = await generateJson<RawVision>(parts, {
    temperature: 0,
    thinkingBudget: 0,
    maxOutputTokens: 16384,
    responseSchema: VISION_SCHEMA,
  });
  if (!raw?.rooms?.length) return null;

  // Building bounding box (image space) anchors placement. Gemini's stated
  // buildingBox is sometimes INCONSISTENT with its own room boxes (rooms
  // extending past it) — when that happens the union of the room boxes is the
  // anchor that keeps every placement inside the envelope.
  const roomBoxes = raw.rooms.map((r) => box4(r.box));
  const union = unionBoxes(roomBoxes);
  const gbb = box4(raw.buildingBox);
  let bb = gbb ?? union;
  if (gbb && union) {
    const tol = 25; // 2.5% of the 0-1000 grid
    const contained =
      union[0] >= gbb[0] - tol &&
      union[1] >= gbb[1] - tol &&
      union[2] <= gbb[2] + tol &&
      union[3] <= gbb[3] + tol;
    if (!contained) bb = union;
  }
  if (!bb) return null;
  const [by0, bx0, by1, bx1] = bb;
  const bw = Math.max(1, bx1 - bx0);
  const bh = Math.max(1, by1 - by0);

  // Calibrate feet-per-image-unit PER AXIS from the rooms that carry BOTH a
  // printed size and an image box: feet ÷ image-box-size, MEDIAN per axis
  // (robust to loose boxes and the odd width/height swap).
  //
  // The axes MUST be calibrated separately: Gemini normalises each axis to
  // 0-1000 INDEPENDENTLY, so on a non-square image one x-unit and one y-unit
  // are different physical sizes. The old single mixed-median scale squashed a
  // tall 20×40 ft plan into a ~32×32 square and shifted every room off its
  // true position (the "big gap in alignment" bug). Grounding each axis in the
  // plan's PRINTED dimensions also stays far more reliable than Gemini's
  // outer-dimension-chain guess, which on dense multi-unit plans is often
  // wildly wrong (e.g. 375×257 ft for a normal floor).
  const ratiosX: number[] = [];
  const ratiosY: number[] = [];
  raw.rooms.forEach((r, i) => {
    const b = roomBoxes[i];
    if (!b) return;
    const biw = b[3] - b[1];
    const bih = b[2] - b[0];
    const wFt = posNum(r.widthFt);
    const hFt = posNum(r.heightFt);
    if (wFt && biw > 4) ratiosX.push(wFt / biw);
    if (hFt && bih > 4) ratiosY.push(hFt / bih);
  });
  const calibX = median(ratiosX);
  const calibY = median(ratiosY);
  const geminiW = posNum(raw.overallWidthFt);
  const geminiH = posNum(raw.overallHeightFt);

  // scaleX/scaleY map image-0-1000 coords → feet; one transform for everything
  // (rooms, openings, furniture).
  let scaleX: number;
  let scaleY: number;
  let w: number;
  let h: number;
  if (calibX && calibY && ratiosX.length >= 3 && ratiosY.length >= 3) {
    scaleX = calibX;
    scaleY = calibY;
    w = round1(bw * calibX);
    h = round1(bh * calibY);
  } else if (geminiW && geminiH) {
    scaleX = geminiW / bw;
    scaleY = geminiH / bh;
    w = geminiW;
    h = geminiH;
  } else {
    return null;
  }

  // Placement comes from the room's image bbox (mapped to feet); SIZE comes from
  // the printed dimensions (more accurate than bbox), falling back to the
  // bbox-derived size when a label wasn't read.
  const rooms: SemanticRoom[] = raw.rooms
    .map((r, i) => {
      const b = roomBoxes[i];
      if (!r?.name?.trim() || !b) return null;
      const [ymin, xmin, ymax, xmax] = b;
      const xFt = round1(clamp((xmin - bx0) * scaleX, 0, w));
      const yFt = round1(clamp((ymin - by0) * scaleY, 0, h));
      const boxW = round1((xmax - xmin) * scaleX);
      const boxH = round1((ymax - ymin) * scaleY);
      return {
        name: r.name.trim(),
        type: r.type?.trim() || inferType(r.name),
        widthFt: posNum(r.widthFt) ?? (boxW > 0 ? boxW : undefined),
        heightFt: posNum(r.heightFt) ?? (boxH > 0 ? boxH : undefined),
        xFt,
        yFt,
        adjacentTo: Array.isArray(r.adjacentTo)
          ? r.adjacentTo.filter((n): n is string => typeof n === "string" && !!n.trim()).map((n) => n.trim())
          : undefined,
      } as SemanticRoom;
    })
    .filter((r): r is SemanticRoom => !!r);

  const positioned = rooms.filter(
    (r) => r.widthFt && r.heightFt && r.xFt !== undefined && r.yFt !== undefined,
  );
  if (positioned.length < 2) return null;

  // Map each door/window opening from image space (0-1000) into feet with the
  // same transform as the rooms. Orientation falls back to the box's dominant
  // axis when Gemini omits it.
  const mapOpening = (o: RawOpening): SemanticOpening | null => {
    const ob = box4(o?.box);
    if (!ob) return null;
    const [ymin, xmin, ymax, xmax] = ob;
    const xFt = round1(clamp(((xmin + xmax) / 2 - bx0) * scaleX, 0, w));
    const yFt = round1(clamp(((ymin + ymax) / 2 - by0) * scaleY, 0, h));
    const orientation: "h" | "v" =
      o.orientation === "h" || o.orientation === "v"
        ? o.orientation
        : xmax - xmin >= ymax - ymin
          ? "h"
          : "v";
    const lengthFt =
      orientation === "h" ? round1((xmax - xmin) * scaleX) : round1((ymax - ymin) * scaleY);
    return { xFt, yFt, orientation, lengthFt: lengthFt > 0 ? lengthFt : undefined };
  };
  const openings = (raw: RawOpening[] | undefined): SemanticOpening[] =>
    (raw ?? []).map(mapOpening).filter((o): o is SemanticOpening => !!o);

  // Furniture is read in a SEPARATE, focused call so it never dilutes the
  // geometry read above (mixing the two made Gemini drop windows). Best-effort.
  const furniture = await detectFurnitureFt(img, bx0, by0, scaleX, scaleY, w, h);

  return {
    rooms,
    doors: openings(raw.doors),
    windows: openings(raw.windows),
    furniture,
    overallWidthFt: w,
    overallHeightFt: h,
    longestSideFt: Math.max(w, h),
    source: "gemini-vision",
  };
}

const FURNITURE_PROMPT = `Look at the furniture and fixtures drawn inside this architectural floor plan.
Return JSON: { "furniture": [ { "type": string, "box": [ymin,xmin,ymax,xmax] } ] }
- "type" is one of: sofa, chair, bed, table, dining_table, toilet, sink, wardrobe, tv, stove, plant, other.
- One entry per furniture/fixture SYMBOL actually drawn — beds, sofas, chairs, dining sets,
  toilets/WC, wash basins/sinks, wardrobes, kitchen platforms/stoves, TVs, indoor plants.
- "box" is the symbol's bounding box in image coordinates, 0-1000.
- Return { "furniture": [] } if none are drawn. NEVER invent furniture that isn't on the plan.`;

/**
 * Focused furniture pass — a SECOND Gemini call so reading furniture can't steal
 * attention from the geometry reconstruction (rooms/doors/windows). Maps each
 * drawn symbol into feet with the building-box transform from the geometry pass.
 * Best-effort: returns [] on any failure.
 */
async function detectFurnitureFt(
  img: { data: string; mimeType: string },
  bx0: number,
  by0: number,
  scaleX: number,
  scaleY: number,
  w: number,
  h: number,
): Promise<SemanticFurniture[]> {
  // Opt-out so the extra vision call can be skipped when Gemini quota is tight.
  if (process.env.DETECT_FURNITURE === "0") return [];
  try {
    const raw = await generateJson<{ furniture?: { type?: string; box?: number[] }[] }>(
      [{ inlineData: { mimeType: img.mimeType, data: img.data } }, { text: FURNITURE_PROMPT }],
      {
        temperature: 0,
        thinkingBudget: 0,
        maxOutputTokens: 8192,
        responseSchema: {
          type: "OBJECT",
          properties: {
            furniture: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { type: { type: "STRING" }, box: BOX_SCHEMA },
                required: ["type", "box"],
                propertyOrdering: ["type", "box"],
              },
            },
          },
          required: ["furniture"],
        },
      },
    );
    // `null` = the call ITSELF failed (Gemini overloaded / out of daily quota /
    // bad JSON), which is different from a successful read that genuinely found no
    // furniture. They used to be indistinguishable — both produced an empty plan,
    // so a starved furniture pass looked exactly like "this plan has no furniture".
    // The geometry pass (rooms/doors/windows) can succeed while THIS second call
    // gets starved, which is precisely how you end up with all the rooms but no
    // sofa/dining table. Log it so it's diagnosable; re-running picks them up.
    if (raw === null) {
      console.warn(
        "[semantic] furniture pass returned nothing — Gemini was unavailable or " +
          "out of quota for the SECOND (furniture) vision call. Rooms were still " +
          "detected from the first call; re-run the parse to pick up furniture.",
      );
      return [];
    }
    return (raw.furniture ?? [])
      .map((f): SemanticFurniture | null => {
        const fb = box4(f?.box);
        if (!fb) return null;
        const [ymin, xmin, ymax, xmax] = fb;
        const xFt = round1(clamp((xmin - bx0) * scaleX, 0, w));
        const yFt = round1(clamp((ymin - by0) * scaleY, 0, h));
        const widthFt = round1((xmax - xmin) * scaleX);
        const heightFt = round1((ymax - ymin) * scaleY);
        if (widthFt <= 0 || heightFt <= 0) return null;
        return { type: f?.type?.trim() || "other", xFt, yFt, widthFt, heightFt };
      })
      .filter((f): f is SemanticFurniture => !!f);
  } catch {
    return [];
  }
}

/** Median of a numeric list (robust centre); undefined when empty. */
function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Validate a 4-number [ymin,xmin,ymax,xmax] box; returns null if malformed. */
function box4(b: number[] | undefined): Box | null {
  if (!Array.isArray(b) || b.length < 4) return null;
  const [a, c, d, e] = b;
  if (![a, c, d, e].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)];
}

function unionBoxes(boxes: (Box | null)[]): Box | null {
  const valid = boxes.filter((b): b is Box => !!b);
  if (!valid.length) return null;
  return [
    Math.min(...valid.map((b) => b[0])),
    Math.min(...valid.map((b) => b[1])),
    Math.max(...valid.map((b) => b[2])),
    Math.max(...valid.map((b) => b[3])),
  ];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** OCR-token fallback: room names/types only (geometry comes from OpenCV). */
async function understandFromTokens(ocr: OcrResult): Promise<SemanticPlan> {
  if (ocr.tokens.length === 0) return heuristic(ocr);

  const parts: GeminiPart[] = [
    {
      text:
        `You read architectural floor-plan annotations. Given OCR tokens from ONE floor plan, ` +
        `group them into the distinct ROOMS. For each room give "name", "type" (one of bedroom, ` +
        `bathroom, kitchen, living, dining, hall, office, balcony, pooja, study, utility, store, ` +
        `garage, other), and "widthFt"/"heightFt" only if a dimension label clearly belongs to it. ` +
        `Also "longestSideFt" if a dimension reveals the plan's longest overall side. Never invent ` +
        `rooms. Return JSON: { "rooms":[{"name","type","widthFt?","heightFt?"}], "longestSideFt?":number }` +
        "\n\nOCR tokens (JSON):\n" +
        JSON.stringify(ocr.tokens.map((t) => ({ text: t.text, category: t.category }))),
    },
  ];

  const raw = await generateJson<{
    rooms?: { name?: string; type?: string; widthFt?: number; heightFt?: number }[];
    longestSideFt?: number;
  }>(parts, {
    temperature: 0.2,
    thinkingBudget: 0,
    maxOutputTokens: 16384,
    responseSchema: {
      type: "OBJECT",
      properties: {
        rooms: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              type: { type: "STRING" },
              widthFt: { type: "NUMBER" },
              heightFt: { type: "NUMBER" },
            },
            required: ["name"],
            propertyOrdering: ["name", "type", "widthFt", "heightFt"],
          },
        },
        longestSideFt: { type: "NUMBER" },
      },
      required: ["rooms"],
    },
  });
  if (!raw?.rooms?.length) return heuristic(ocr);

  const rooms: SemanticRoom[] = raw.rooms
    .filter((r) => r?.name?.trim())
    .map((r) => ({
      name: r.name!.trim(),
      type: r.type?.trim() || inferType(r.name!),
      widthFt: posNum(r.widthFt),
      heightFt: posNum(r.heightFt),
    }));

  return { rooms, longestSideFt: posNum(raw.longestSideFt), source: "gemini-flash" };
}

/** Last resort: take room-name-looking tokens straight from the OCR. */
function heuristic(ocr: OcrResult): SemanticPlan {
  const rooms: SemanticRoom[] = ocr.tokens
    .filter((t) => t.category === "room_name")
    .map((t) => ({ name: t.text, type: inferType(t.text) }));
  return { rooms, source: "fallback" };
}

const TYPE_KEYWORDS: [RegExp, string][] = [
  [/bed|master/i, "bedroom"],
  [/bath|toilet|\bwc\b|wash/i, "bathroom"],
  [/kitchen|pantry/i, "kitchen"],
  [/living|lounge|drawing/i, "living"],
  [/dining/i, "dining"],
  [/hall|foyer|lobby|entry|front office/i, "hall"],
  [/balcon|veranda|terrace/i, "balcony"],
  [/pooja|puja|temple|mandir/i, "pooja"],
  [/study|office|cubical|teller|cabin/i, "office"],
  [/utility|laundry|ups|server/i, "utility"],
  [/store|storage|safe|vault/i, "store"],
  [/garage|parking/i, "garage"],
];

function inferType(name: string): string {
  for (const [re, type] of TYPE_KEYWORDS) if (re.test(name)) return type;
  return "other";
}

function posNum(n: number | undefined): number | undefined {
  return typeof n === "number" && n > 0 && Number.isFinite(n) ? n : undefined;
}
