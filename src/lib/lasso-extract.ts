/**
 * Lasso room extraction.
 *
 * The user draws a lasso around one room on the uploaded plan image (pixel
 * space). These helpers isolate what falls inside that loop:
 *   • wall segments → their outer bounding lines give the room's true rectangle
 *   • OCR text tokens → the printed room name + "8'11" x 13'6"" dimension text
 *   • detected doors / windows → counted as inside the room
 * and map the result into plan feet-space so it can become an editable Room.
 */

import type { DetectedGeometry, FloorPlan, Room } from "./types";
import type { OcrResult } from "./pipeline/types";

export interface Pt {
  x: number;
  y: number;
}

export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RectFt {
  x: number;
  y: number;
  width: number;
  height: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Same palette the merge engine uses, so lassoed rooms match detected ones. */
export const ROOM_PALETTE = [
  "#e6a45c", "#6da8e2", "#5cc98a", "#d4972a", "#b98ce2",
  "#e27d9a", "#6dc7e2", "#8ac98a", "#c98a8a", "#8a9ec9",
];

// ---------------------------------------------------------------------------
// Polygon utilities
// ---------------------------------------------------------------------------

export function polygonBounds(poly: Pt[]): RectPx {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Shoelace area (absolute) of a closed polygon. */
export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Dimension-text parsing ("8'11" x 13'6"", "12'-0" X 10'", "3.5m x 4.2m", …)
// ---------------------------------------------------------------------------

const FT_TOKEN = String.raw`\d+(?:\.\d+)?\s*(?:'|ft|m)?\s*-?\s*(?:\d+(?:\.\d+)?\s*(?:"|''|in))?`;
const DIM_RE = new RegExp(`(${FT_TOKEN})\\s*[x×X*]\\s*(${FT_TOKEN})`);

/** One side of a dimension label → feet. Handles 8'11", 8'-11", 12, 3.5m. */
function parseFeetToken(raw: string): number | null {
  const s = raw.trim().replace(/[–—]/g, "-");
  const meters = s.match(/^(\d+(?:\.\d+)?)\s*m$/i);
  if (meters) return Number(meters[1]) * 3.28084;
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''|in))?$/i);
  if (!ftIn) return null;
  const ft = Number(ftIn[1]);
  const inches = ftIn[2] ? Number(ftIn[2]) : 0;
  if (!Number.isFinite(ft) || !Number.isFinite(inches)) return null;
  return ft + inches / 12;
}

/**
 * Finds and parses a "W x H" dimension anywhere in a text token (the token may
 * embed the room name, e.g. `KITCHEN 8'11"x13'6"`). Returns feet or null.
 */
export function parseDimensionText(text: string): { widthFt: number; heightFt: number } | null {
  const m = text.replace(/\s+/g, " ").match(DIM_RE);
  if (!m) return null;
  const w = parseFeetToken(m[1]);
  const h = parseFeetToken(m[2]);
  if (!w || !h || w <= 0.5 || h <= 0.5 || w > 200 || h > 200) return null;
  return { widthFt: r1(w), heightFt: r1(h) };
}

/** Semantic room type guessed from a printed name (fallback when undetected). */
export function guessRoomType(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("bed")) return "bedroom";
  if (n.includes("kitchen")) return "kitchen";
  if (n.includes("living") || n.includes("hall") || n.includes("lounge")) return "living";
  if (n.includes("dining")) return "dining";
  if (n.includes("bath") || n.includes("rest") || n.includes("toilet") || n.includes("wc")) return "bathroom";
  if (n.includes("balcon")) return "balcony";
  if (n.includes("stair")) return "stair";
  if (n.includes("pooja")) return "pooja";
  if (n.includes("study") || n.includes("office")) return "study";
  return undefined;
}

// ---------------------------------------------------------------------------
// Pixel → feet mapping (mirrors the merge engine's building-anchored transform)
// ---------------------------------------------------------------------------

/**
 * Linear map from image pixels to plan feet. Anchored at the detected building
 * footprint when available (the plan origin the merge used), else the full
 * image — the same priority mergePlan applies.
 */
export function pxToFtTransform(geometry: DetectedGeometry, plan: FloorPlan) {
  const bb = geometry.buildingBox;
  const useBB = !!bb && bb.w > 0 && bb.h > 0;
  const ox = useBB ? bb!.x : 0;
  const oy = useBB ? bb!.y : 0;
  const sx = plan.planWidth / (useBB ? bb!.w : geometry.imageWidth || 1);
  const sy = plan.planHeight / (useBB ? bb!.h : geometry.imageHeight || 1);
  return {
    x: (px: number) => (px - ox) * sx,
    y: (py: number) => (py - oy) * sy,
    sx,
    sy,
    /** origin (image px) the feet space is anchored at — needed to invert this map */
    ox,
    oy,
  };
}

// ---------------------------------------------------------------------------
// Region extraction
// ---------------------------------------------------------------------------

export interface LassoExtraction {
  polygon: Pt[];
  /** raw lasso bounding box, image pixels */
  boundsPx: RectPx;
  /** wall-snapped rectangle (outer bounding lines of walls inside the loop) */
  snappedPx: RectPx;
  /** the snapped rectangle mapped into plan feet-space */
  rectFt: RectFt;
  /** printed room name found inside the loop (OCR / labeled detector) */
  name?: string;
  type?: string;
  /** printed dimensions found inside the loop, if any */
  labelDims?: { widthFt: number; heightFt: number; source: "ocr" | "detector" };
  /** suggested editable dimensions: printed label first, else measured rect */
  widthFt: number;
  heightFt: number;
  counts: { walls: number; doors: number; windows: number };
  /** existing plan room this selection overlaps most (IoU > 0.4) — update it */
  matchedRoomId?: string;
}

export function extractLassoRegion(args: {
  polygon: Pt[];
  geometry: DetectedGeometry;
  plan: FloorPlan;
  ocr?: OcrResult;
}): LassoExtraction {
  const { polygon, geometry: g, plan, ocr } = args;
  const boundsPx = polygonBounds(polygon);

  // 1) Walls inside the loop → their outer bounding lines are the room's real
  // rectangle (tighter + truer than the hand-drawn lasso). Endpoints are
  // clipped to the lasso bounds so a long wall passing through can't inflate it.
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
  let wallCount = 0;
  for (const w of g.walls) {
    const mid = { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
    const inside =
      pointInPolygon(mid, polygon) ||
      pointInPolygon({ x: w.x1, y: w.y1 }, polygon) ||
      pointInPolygon({ x: w.x2, y: w.y2 }, polygon);
    if (!inside) continue;
    wallCount++;
    for (const p of [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]) {
      const cx = clamp(p.x, boundsPx.x, boundsPx.x + boundsPx.w);
      const cy = clamp(p.y, boundsPx.y, boundsPx.y + boundsPx.h);
      if (cx < wx0) wx0 = cx;
      if (cy < wy0) wy0 = cy;
      if (cx > wx1) wx1 = cx;
      if (cy > wy1) wy1 = cy;
    }
  }
  let snappedPx: RectPx = boundsPx;
  if (wallCount > 0 && wx1 > wx0 && wy1 > wy0) {
    const cand: RectPx = { x: wx0, y: wy0, w: wx1 - wx0, h: wy1 - wy0 };
    // Only trust the snap when the walls actually describe the region (a lone
    // stub shouldn't collapse the selection to a sliver).
    if (cand.w * cand.h >= 0.2 * boundsPx.w * boundsPx.h) snappedPx = cand;
  }

  // 2) Text inside the loop: room-name tokens and dimension tokens. OCR boxes
  // are normalized [0..1] — scale to pixels before testing.
  let name: string | undefined;
  let ocrDims: { widthFt: number; heightFt: number } | undefined;
  let bestNameD = Infinity;
  const centroid = {
    x: boundsPx.x + boundsPx.w / 2,
    y: boundsPx.y + boundsPx.h / 2,
  };
  for (const t of ocr?.tokens ?? []) {
    if (!t.bbox) continue;
    const c = {
      x: (t.bbox.x + t.bbox.w / 2) * g.imageWidth,
      y: (t.bbox.y + t.bbox.h / 2) * g.imageHeight,
    };
    if (!pointInPolygon(c, polygon)) continue;
    if (t.category === "room_name") {
      const d = Math.hypot(c.x - centroid.x, c.y - centroid.y);
      if (d < bestNameD) {
        bestNameD = d;
        name = tidyName(t.text);
      }
    }
    if (!ocrDims && (t.category === "dimension" || t.category === "room_name")) {
      ocrDims = parseDimensionText(t.text) ?? undefined;
    }
  }

  // 3) Fall back to the labeled detector's own read (name + printed dims live
  // on the detected room boxes) for whatever OCR didn't yield.
  let detName: string | undefined;
  let detType: string | undefined;
  let detDims: { widthFt: number; heightFt: number } | undefined;
  for (const r of g.rooms) {
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (!pointInPolygon(c, polygon)) continue;
    if (r.name && !detName) {
      detName = tidyName(r.name);
      detType = r.type;
    }
    if (r.widthFt && r.heightFt && !detDims) {
      detDims = { widthFt: r1(r.widthFt), heightFt: r1(r.heightFt) };
    }
  }
  name = name ?? detName;

  // 4) Map the snapped rectangle to plan feet.
  const T = pxToFtTransform(g, plan);
  const fx = clamp(r1(T.x(snappedPx.x)), 0, plan.planWidth);
  const fy = clamp(r1(T.y(snappedPx.y)), 0, plan.planHeight);
  const fw = clamp(r1(snappedPx.w * T.sx), 2, plan.planWidth - fx);
  const fh = clamp(r1(snappedPx.h * T.sy), 2, plan.planHeight - fy);
  const rectFt: RectFt = { x: fx, y: fy, width: fw, height: fh };

  // 5) Final dims: printed label first (it's ground truth), measured rect else.
  // Keep the label's orientation consistent with the drawn region — a "22 x 6"
  // read the wrong way round would turn a wide balcony into a tall strip.
  let labelDims: LassoExtraction["labelDims"];
  if (ocrDims) labelDims = { ...ocrDims, source: "ocr" };
  else if (detDims) labelDims = { ...detDims, source: "detector" };
  let widthFt = labelDims?.widthFt ?? fw;
  let heightFt = labelDims?.heightFt ?? fh;
  if (labelDims && fw > 0 && fh > 0) {
    const orientDiffers = (fw >= fh) !== (widthFt >= heightFt);
    const elong = Math.max(widthFt, heightFt) / Math.max(0.1, Math.min(widthFt, heightFt));
    if (orientDiffers && elong >= 1.25) [widthFt, heightFt] = [heightFt, widthFt];
  }

  // 6) Door/window symbols (pixel space) inside the loop.
  const doors = g.doors.filter((d) => pointInPolygon(d, polygon)).length;
  const windows = g.windows.filter((w) => pointInPolygon(w, polygon)).length;

  // 7) Does this selection re-trace a room the pipeline already produced?
  // If so the confirm step should UPDATE that room, not duplicate it.
  let matchedRoomId: string | undefined;
  let bestIoU = 0.4;
  for (const r of plan.rooms) {
    const iou = rectIoU(rectFt, r);
    if (iou > bestIoU) {
      bestIoU = iou;
      matchedRoomId = r.id;
    }
  }

  return {
    polygon,
    boundsPx,
    snappedPx,
    rectFt,
    name,
    type: detType ?? (name ? guessRoomType(name) : undefined),
    labelDims,
    widthFt: r1(widthFt),
    heightFt: r1(heightFt),
    counts: { walls: wallCount, doors, windows },
    matchedRoomId,
  };
}

/** Strips the dimension part off a label and title-cases it (KITCHEN 8'x10' → Kitchen). */
function tidyName(raw: string): string {
  const stripped = raw.replace(DIM_RE, "").replace(/[\d'"×x-]+\s*$/i, "").trim();
  const base = stripped || raw.trim();
  return base
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase()))
    .join(" ");
}

function rectIoU(a: RectFt, b: Room): number {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  const inter = ox * oy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
