/**
 * Dimension-annotated render finish (client-side).
 *
 * Reproduces the deliverable style of the reference design document: the
 * photoreal render with the room name top-left, black double-headed dimension
 * arrows with RED millimetre figures drawn on the photo itself, and a compact
 * furniture size card. Values come straight from the reviewed plan (feet →
 * mm), so every number is the verified one — nothing is asked of the image
 * model, so nothing can be hallucinated.
 *
 * The annotation is composited onto a canvas at the image's natural size and
 * returned as a data URL. The STORED render stays clean — Veo receives the
 * unannotated image, and edits keep operating on the raw version.
 */

import type { RenderView } from "./flux-client";

export interface AnnotateInput {
  roomName?: string;
  widthFt: number;
  /** room depth (plan "height"), ft */
  depthFt: number;
  ceilingFt: number;
  view: RenderView;
  furniture: { name: string; w: number; d: number; h: number }[];
}

const RED = "#e11d1d";
const INK = "#141414";

const ftToMm = (ft: number) => Math.round((ft * 304.8) / 10) * 10;
const ftLabel = (ft: number) => {
  const whole = Math.floor(ft);
  const inches = Math.round((ft - whole) * 12);
  return inches > 0 ? `${whole}'${inches}"` : `${whole}'`;
};

/** The wall span the camera actually faces in this view, in feet. */
function facingWallFt(i: AnnotateInput): number {
  return i.view === "left" || i.view === "right" ? i.depthFt : i.widthFt;
}

/** Views where the pictured wall's span/height can be honestly arrowed. */
const WALL_VIEWS = new Set<RenderView>(["front", "left", "right", "back"]);

export async function annotateRenderImage(src: string, input: AnnotateInput): Promise<string> {
  const img = await loadImage(src);
  const W = img.naturalWidth || 1280;
  const H = img.naturalHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  ctx.drawImage(img, 0, 0, W, H);

  const s = W / 1400; // all sizes in reference-design units, scaled to the image
  const font = (px: number, weight = 700) => `${weight} ${Math.round(px * s)}px Arial, sans-serif`;

  // ---- room name, top-left (like the document's page titles, on-photo) ----
  if (input.roomName) {
    const label = input.roomName.toUpperCase();
    ctx.font = font(30);
    const tw = ctx.measureText(label).width;
    const px = 24 * s;
    const py = 22 * s;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, px, py, tw + 28 * s, 46 * s, 8 * s);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(label, px + 14 * s, py + 24 * s);
  }

  if (WALL_VIEWS.has(input.view)) {
    const wallFt = facingWallFt(input);

    // ---- wall width: double-headed arrow along the bottom ----
    const y = H - 56 * s;
    const x0 = W * 0.1;
    const x1 = W * 0.9;
    drawArrow(ctx, s, x0, y, x1, y);
    drawDim(ctx, s, (x0 + x1) / 2, y - 16 * s, `${ftToMm(wallFt)} mm`, `(${ftLabel(wallFt)})`, "center");

    // ---- ceiling height: vertical arrow on the left ----
    const x = 56 * s;
    const y0 = H * 0.14;
    const y1 = H * 0.82;
    drawArrow(ctx, s, x, y0, x, y1);
    ctx.save();
    ctx.translate(x + 16 * s, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    drawDim(ctx, s, 0, 0, `${ftToMm(input.ceilingFt)} mm`, `(${ftLabel(input.ceilingFt)} ceiling)`, "center");
    ctx.restore();
  }

  // ---- furniture sizes, bottom-right card (verified numbers, mm) ----
  const rows = dedupe(input.furniture).slice(0, 8);
  if (rows.length) {
    ctx.font = font(19, 600);
    const lines = rows.map(
      (f) => [`${f.name}`, `${ftToMm(f.w)} × ${ftToMm(f.d)} mm · H ${ftToMm(f.h)}`] as const,
    );
    const nameW = Math.max(...lines.map((l) => ctx.measureText(l[0]).width));
    const dimW = Math.max(...lines.map((l) => ctx.measureText(l[1]).width));
    const pad = 14 * s;
    const lineH = 27 * s;
    const cw = nameW + dimW + pad * 3;
    const ch = lines.length * lineH + pad * 2;
    const cx = W - cw - 24 * s;
    const cy = H - ch - 92 * s;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    roundRect(ctx, cx, cy, cw, ch, 10 * s);
    ctx.fill();
    ctx.textBaseline = "middle";
    lines.forEach(([name, dim], i) => {
      const ly = cy + pad + lineH * i + lineH / 2;
      ctx.textAlign = "left";
      ctx.fillStyle = INK;
      ctx.fillText(name, cx + pad, ly);
      ctx.textAlign = "right";
      ctx.fillStyle = RED;
      ctx.fillText(dim, cx + cw - pad, ly);
    });
  }

  return canvas.toDataURL("image/png");
}

/** Red figure with a soft white halo so it reads on any photo, like the doc. */
function drawDim(
  ctx: CanvasRenderingContext2D,
  s: number,
  x: number,
  y: number,
  main: string,
  sub: string,
  align: CanvasTextAlign,
) {
  ctx.textAlign = align;
  ctx.textBaseline = "bottom";
  ctx.font = `700 ${Math.round(30 * s)}px Arial, sans-serif`;
  ctx.lineWidth = 6 * s;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(main, x, y);
  ctx.fillStyle = RED;
  ctx.fillText(main, x, y);
  ctx.font = `600 ${Math.round(18 * s)}px Arial, sans-serif`;
  ctx.textBaseline = "top";
  ctx.strokeText(sub, x, y + 4 * s);
  ctx.fillStyle = INK;
  ctx.fillText(sub, x, y + 4 * s);
}

/** Black double-headed dimension arrow with a white halo underlay. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  s: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const head = 14 * s;
  const ang = Math.atan2(y1 - y0, x1 - x0);
  for (const [color, width] of [
    ["rgba(255,255,255,0.85)", 7 * s],
    [INK, 3 * s],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    for (const [hx, hy, a] of [
      [x0, y0, ang],
      [x1, y1, ang + Math.PI],
    ] as const) {
      ctx.moveTo(hx + head * Math.cos(a - 0.42), hy + head * Math.sin(a - 0.42));
      ctx.lineTo(hx, hy);
      ctx.lineTo(hx + head * Math.cos(a + 0.42), hy + head * Math.sin(a + 0.42));
    }
    ctx.stroke();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function dedupe<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = it.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load the render image"));
    img.src = src;
  });
}
