/**
 * Furniture verify + repair loop.
 *
 * The reviewed 2D plan says exactly which furniture a room contains; Nano Banana
 * sometimes drops a piece (or invents one) while repainting the 3D massing. This
 * module closes that gap AFTER a render comes back and BEFORE it is stored:
 *
 *   1. CHECK — Gemini vision compares the render against its OWN 3D screenshot
 *      (same camera). The screenshot is the per-view visibility ground truth:
 *      every stand-in box visible in it must have become the real piece at that
 *      spot in the render. Items whose box is out of frame are "offscreen", not
 *      missing — so a front render is never punished for furniture behind the
 *      camera (that would loop forever).
 *   2. REPAIR — each missing piece is added back with a TARGETED edit
 *      (`editImageWithGemini` + a synthetic rect mask at the box's reported
 *      position). The crop-and-composite editor cannot touch pixels outside the
 *      crop, so already-verified items can't be lost by a repair — ticks only
 *      ever accumulate. A full re-render would be whack-a-mole (Nano has no
 *      seed: the re-roll that adds the plant can drop the sofa).
 *   3. RE-CHECK — one final pass grades the repairs.
 *
 * The checker runs on the text/vision model (a separate quota bucket from the
 * image model), at temperature 0, with a constrained response schema, and must
 * give per-item location evidence — which suppresses most yes-bias false ticks.
 *
 * Never blocks a render: on any checker failure the original image is returned
 * with an honest "unchecked" checklist. Kill switch: RENDER_VERIFY=0.
 */

import sharp from "sharp";
import type { DesignStyle, FurnitureCheck, PlacedItem } from "@/lib/types";
import { generateJson, geminiConfigured } from "@/lib/pipeline/gemini-client";
import { editImageWithGemini } from "./gemini-image";

/** Most repair edits per render — each is a Nano image call, so keep it tight. */
const MAX_REPAIRS = 3;
/** Most invented-furniture removals per render (removal is a safe, bounded edit). */
const MAX_EXTRA_REMOVALS = 2;
/** Centre offset (% of frame) beyond which a present item is flagged "misplaced". */
const MISPLACE_PCT = 22;

export interface VerifiedRender {
  bytes: Buffer;
  contentType: string;
  /** one entry per distinct furniture name in the room */
  checklist: FurnitureCheck[];
  /** substantial furniture the checker saw that matches nothing in the plan */
  extras: string[];
  /** true when every in-frame item ended up present (or repaired) */
  verified: boolean;
}

export function renderVerifyEnabled(): boolean {
  return !/^(0|off|false)$/i.test(process.env.RENDER_VERIFY?.trim() ?? "");
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CheckItem {
  name: string;
  boxVisible: boolean;
  present: boolean;
  where?: string;
  /** the stand-in box's area in the 3D screenshot (IMAGE 1), % of frame */
  region?: Region;
  /** the real item's area in the render (IMAGE 2), % of frame — when present */
  renderRegion?: Region;
}

interface CheckExtra {
  description: string;
  /** the invented piece's area in the render (IMAGE 2), % of frame */
  region?: Region;
}

interface CheckResult {
  items: CheckItem[];
  extras?: CheckExtra[];
}

interface Expected {
  name: string;
  count: number;
  widthFt: number;
  depthFt: number;
  heightFt: number;
  color: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const norm = (s: string) => s.trim().toLowerCase();
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Distance between two regions' centres, in % of frame (x/y are 0–100). */
function centreDist(a: Region, b: Region): number {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by);
}

/** Constrained-decoding schema — vision reads without one can loop/degenerate. */
const CHECK_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          boxVisible: { type: "boolean" },
          present: { type: "boolean" },
          where: { type: "string" },
          region: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
          renderRegion: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
        },
        required: ["name", "boxVisible", "present"],
      },
    },
    extras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          region: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
        },
        required: ["description"],
      },
    },
  },
  required: ["items"],
};

/** Dedupe the room's items by name (with a count), keeping real dims + box colour. */
function expectedFurniture(items: PlacedItem[]): Expected[] {
  const byName = new Map<string, Expected>();
  for (const it of items) {
    if (it.ghost) continue;
    const key = norm(it.name);
    const e = byName.get(key);
    if (e) e.count++;
    else
      byName.set(key, {
        name: it.name,
        count: 1,
        widthFt: r1(it.w),
        depthFt: r1(it.d),
        heightFt: r1(it.h),
        color: it.color,
      });
  }
  return [...byName.values()];
}

/** Downscale an image to <=1024px JPEG for the checker (tokens + latency). */
async function inlineSmall(buf: Buffer): Promise<{ inlineData: { mimeType: string; data: string } }> {
  try {
    const small = await sharp(buf)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { inlineData: { mimeType: "image/jpeg", data: small.toString("base64") } };
  } catch {
    return { inlineData: { mimeType: "image/png", data: buf.toString("base64") } };
  }
}

function dataUriToBuffer(uri: string): Buffer {
  const m = uri.match(/^data:[^;]+;base64,([\s\S]*)$/);
  return Buffer.from(m ? m[1] : uri, "base64");
}

/** One vision pass: render vs its 3D screenshot → per-item verdicts. */
async function checkOnce(
  renderBytes: Buffer,
  screenshotDataUri: string,
  expected: Expected[],
  signal?: AbortSignal,
): Promise<CheckResult | null> {
  const listing = expected
    .map(
      (e) =>
        `- ${e.name}${e.count > 1 ? ` ×${e.count}` : ""} | ~${e.widthFt}×${e.depthFt} ft footprint, ` +
        `${e.heightFt} ft tall | stand-in box colour ${e.color}`,
    )
    .join("\n");

  const prompt = `IMAGE 1 is a rough 3D massing screenshot of a room: plain coloured boxes stand in for the furniture. IMAGE 2 is a photorealistic render generated FROM IMAGE 1 with the SAME camera — each box in IMAGE 1 should have become the real furniture piece at that same spot in IMAGE 2.

Expected furniture (name | real size | box colour in IMAGE 1):
${listing}

For EACH expected item report:
- boxVisible: is its stand-in box visible in IMAGE 1, even partially? (false if it is out of frame or fully hidden)
- present: is the REAL item clearly visible in IMAGE 2 at approximately the same spot as its box? Judge by position and size — the render's colours/materials may legitimately differ from the box colour. Be strict: only true if you can actually see it${expected.some((e) => e.count > 1) ? "; for ×N items, true only if all N instances are visible" : ""}.
- where: one short phrase locating the item in IMAGE 2 (e.g. "left foreground, against the west wall") — or, if missing, where its box sits in IMAGE 1.
- region: the box's bounding area in IMAGE 1 as percentages of the image (x, y = top-left corner, w, h = size; 0–100). Give this whenever boxVisible is true.
- renderRegion: the REAL item's bounding area in IMAGE 2 as percentages (same format). Give this whenever present is true. It should sit at roughly the same place as region — report where it ACTUALLY is, even if that differs.

Also report extras: any SUBSTANTIAL furniture piece visible in IMAGE 2 that matches NO expected item and NO box in IMAGE 1 (a second bed, an extra sofa, an unlisted wardrobe…), each with its bounding region in IMAGE 2 (percentages). Do NOT count built-in design or styling as extra — false ceiling, cove lighting, curtains, an area rug, cushions/throws, wall panelling, lamps that are part of the design, small decor and plants in the background are all fine.

Return JSON only.`;

  const parts = [
    { text: prompt },
    await inlineSmall(dataUriToBuffer(screenshotDataUri)),
    await inlineSmall(renderBytes),
  ];

  const out = await generateJson<CheckResult>(parts, {
    temperature: 0,
    thinkingBudget: 0,
    maxOutputTokens: 2200,
    responseSchema: CHECK_SCHEMA,
    signal,
  });
  return out?.items?.length ? out : null;
}

/**
 * Cross-view consistency: are the room's four walls-photos ONE coherent design?
 * The sides are anchored to the front, but anchoring can still drift (a side gets
 * a different wall colour / sofa fabric / flooring). One Flash vision pass over
 * all four catches that BEFORE the orbit is filmed — a drifting still cemented
 * into four Veo segments is the expensive failure. Text/vision quota, temp 0.
 * Returns `consistent: true` with no issues when the check is unavailable (never
 * blocks the walkthrough on the checker being down).
 */
export async function checkViewConsistency(
  views: { label: string; dataUri: string }[],
  style: DesignStyle,
  signal?: AbortSignal,
): Promise<{ consistent: boolean; issues: string[] }> {
  if (!renderVerifyEnabled() || !geminiConfigured() || views.length < 2) {
    return { consistent: true, issues: [] };
  }
  const schema = {
    type: "object",
    properties: {
      consistent: { type: "boolean" },
      issues: { type: "array", items: { type: "string" } },
    },
    required: ["consistent"],
  };
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    {
      text: `These ${views.length} photographs are meant to be the SAME "${style.name}" interior room from different camera angles (in order: ${views
        .map((v) => v.label)
        .join(", ")}). They should show ONE coherent design. Compare them and report any element that CLEARLY differs between views — wall colour/material, feature-wall or panelling, flooring, ceiling and cove lighting, or the design/colour/upholstery of a shared furniture piece. Ignore differences that are just the different camera angle, framing, or which wall is in shot. Return JSON: { "consistent": boolean, "issues": string[] } — issues lists each concrete inconsistency in a short phrase (empty when they match).`,
    },
  ];
  for (const v of views) parts.push(await inlineSmall(dataUriToBuffer(v.dataUri)));

  const out = await generateJson<{ consistent?: boolean; issues?: string[] }>(parts, {
    temperature: 0,
    thinkingBudget: 0,
    maxOutputTokens: 600,
    responseSchema: schema,
    signal,
  });
  if (!out) return { consistent: true, issues: [] };
  const issues = (out.issues ?? []).map((s) => s?.trim()).filter((s): s is string => !!s);
  return { consistent: out.consistent !== false && issues.length === 0, issues };
}

/** Find the checker's verdict for an expected name (exact, then fuzzy). */
function matchCheck(items: CheckItem[], name: string): CheckItem | undefined {
  const n = norm(name);
  return (
    items.find((c) => norm(c.name) === n) ??
    items.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name)))
  );
}

/** White-rect-on-black mask (full render size) locating a repair region. */
async function rectMaskUri(renderBytes: Buffer, region: Region): Promise<string | null> {
  try {
    const meta = await sharp(renderBytes).metadata();
    const W = meta.width ?? 1280;
    const H = meta.height ?? 720;
    // Small margin around the reported box; the editor pads generously anyway.
    const x0 = clamp((region.x - 4) / 100, 0, 0.95) * W;
    const y0 = clamp((region.y - 4) / 100, 0, 0.95) * H;
    const x1 = clamp((region.x + region.w + 4) / 100, 0.05, 1) * W;
    const y1 = clamp((region.y + region.h + 4) / 100, 0.05, 1) * H;
    const w = Math.max(Math.round(x1 - x0), Math.round(W * 0.02));
    const h = Math.max(Math.round(y1 - y0), Math.round(H * 0.02));
    const svg = `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/><rect x="${Math.round(x0)}" y="${Math.round(y0)}" width="${w}" height="${h}" fill="#fff"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Verify a fresh Nano render against its 3D screenshot and repair missing
 * furniture in place. Always returns an image — the repaired one when possible,
 * the original otherwise — plus the checklist for the UI.
 */
export async function verifyAndRepairRender(opts: {
  bytes: Buffer;
  contentType: string;
  /** the SAME 3D screenshot the render was generated from (camera truth) */
  screenshotDataUri: string;
  items: PlacedItem[];
  style: DesignStyle;
  /** cap on repair edits (each is a Nano image call); 0 = check only */
  maxRepairs?: number;
  signal?: AbortSignal;
}): Promise<VerifiedRender> {
  let bytes = opts.bytes;
  let contentType = opts.contentType;
  const expected = expectedFurniture(opts.items);

  // Nothing to verify (no furniture) → trivially verified; disabled/offline →
  // pass the render through untouched with no claim either way.
  if (!expected.length) return { bytes, contentType, checklist: [], extras: [], verified: true };
  if (!renderVerifyEnabled() || !geminiConfigured()) {
    return { bytes, contentType, checklist: [], extras: [], verified: false };
  }

  let check = await checkOnce(bytes, opts.screenshotDataUri, expected, opts.signal);
  if (!check) {
    return {
      bytes,
      contentType,
      checklist: expected.map((e) => ({ name: e.name, status: "unchecked" as const })),
      extras: [],
      verified: false,
    };
  }

  // ---- Repair pass: add missing pieces back, biggest footprint first (the
  // most room-defining piece matters most under the repair cap).
  const areaOf = (name: string) => {
    const e = expected.find((x) => norm(x.name) === norm(name));
    return e ? e.widthFt * e.depthFt : 0;
  };
  const missing = check.items
    .filter((c) => c.boxVisible && !c.present && c.region)
    // A bogus near-full-frame region would turn the "targeted" repair into a
    // whole-image re-edit (drift risk) — skip those, just report missing.
    .filter((c) => (c.region!.w * c.region!.h) / (100 * 100) <= 0.6)
    .sort((a, b) => areaOf(b.name) - areaOf(a.name))
    .slice(0, opts.maxRepairs ?? MAX_REPAIRS);

  const attempted = new Set<string>();
  for (const m of missing) {
    const e = expected.find((x) => norm(x.name) === norm(m.name));
    const size = e ? `, about ${e.widthFt} ft wide × ${e.depthFt} ft deep and ${e.heightFt} ft tall` : "";
    const instruction =
      `Add a ${e?.name ?? m.name}${size} at this exact spot — it is missing from the render. ` +
      `Place it naturally on the floor with the same perspective, scale, lighting, shadows and ` +
      `design style as the rest of the room.`;
    const maskUri = await rectMaskUri(bytes, m.region!);
    if (!maskUri) continue;
    const baseUri = `data:${contentType};base64,${bytes.toString("base64")}`;
    try {
      const edited = await editImageWithGemini(baseUri, maskUri, instruction, opts.style, undefined, opts.signal);
      if (edited) {
        bytes = edited.bytes;
        contentType = edited.contentType;
        attempted.add(norm(m.name));
      }
    } catch {
      /* a failed repair leaves the item reported as missing */
    }
  }

  // ---- Remove invented furniture (extras the plan never had). Removal is the
  // best-behaved edit (Nano rebuilds the surfaces behind the object); cap it so a
  // mis-flagged "extra" can't cascade into many edits. A near-full-frame region is
  // skipped — that's not a discrete object, and masking it would re-edit the whole
  // image.
  let removedAny = false;
  const extrasToRemove = (check.extras ?? [])
    .filter((x) => x.region && (x.region.w * x.region.h) / (100 * 100) <= 0.5)
    .slice(0, MAX_EXTRA_REMOVALS);
  for (const x of extrasToRemove) {
    const maskUri = await rectMaskUri(bytes, x.region!);
    if (!maskUri) continue;
    const baseUri = `data:${contentType};base64,${bytes.toString("base64")}`;
    try {
      const edited = await editImageWithGemini(
        baseUri,
        maskUri,
        `Remove the ${x.description} — it is NOT part of this room and should not be here. Completely ` +
          `erase it and rebuild the floor, wall and surfaces behind it so the spot looks naturally empty.`,
        opts.style,
        undefined,
        opts.signal,
      );
      if (edited) {
        bytes = edited.bytes;
        contentType = edited.contentType;
        removedAny = true;
      }
    } catch {
      /* a failed removal just leaves the extra reported */
    }
  }

  // ---- Re-check if anything changed (a repair added a piece, or a removal took
  // one out) — grades the edits and refreshes the extras list.
  if (attempted.size || removedAny) {
    const recheck = await checkOnce(bytes, opts.screenshotDataUri, expected, opts.signal);
    if (recheck) check = recheck;
  }

  const checklist: FurnitureCheck[] = expected.map((e) => {
    const c = matchCheck(check!.items, e.name);
    if (!c) return { name: e.name, status: "unchecked" };
    if (!c.boxVisible) return { name: e.name, status: "offscreen" };
    if (c.present) {
      if (attempted.has(norm(e.name))) return { name: e.name, status: "repaired", where: c.where };
      // Present but well away from where its box sits in the screenshot → the
      // model drew it in the wrong place. Reported (not auto-moved: an inpaint
      // "move" tends to duplicate the piece; the layout lock is the real fix).
      const moved = c.region && c.renderRegion && centreDist(c.region, c.renderRegion) > MISPLACE_PCT;
      return { name: e.name, status: moved ? "misplaced" : "present", where: c.where };
    }
    return { name: e.name, status: "missing", where: c.where };
  });
  const extras = (check.extras ?? []).map((x) => x.description?.trim()).filter((s): s is string => !!s);
  const verified = checklist.every(
    (c) => c.status === "present" || c.status === "repaired" || c.status === "offscreen",
  );
  return { bytes, contentType, checklist, extras, verified };
}
