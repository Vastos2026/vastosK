import "server-only";
import sharp from "sharp";
import type { GreyboxLedger } from "@/lib/types";
import type { ProjectedOpening } from "./render-mask";

/** Components smaller than this are antialiasing crumbs, not openings. */
const MIN_COMPONENT_PX = 64;
/** How far from a projected centre to search for its component, in pixels. */
const SEARCH_RADIUS = 12;

/**
 * Ground-truth opening counts from the section 7.1 Pass B mask.
 *
 * Why not just count room.placedOpenings: an opening clipped at the frame
 * edge, behind the camera, or occluded by furniture is not visible in the
 * output, and claiming it in the prompt tells the model to invent one. The
 * mask only contains what the locked camera actually sees.
 *
 * Type comes from `projected`, not from pixels — the mask is pure white per
 * section 7.1. Each opening's projected centre is looked up in the label
 * image; the component containing it inherits that opening's type. Two
 * openings that merge into one visual component count once, which is correct:
 * the model will see one aperture.
 */
export async function countOpenings(maskPng: Buffer, projected: ProjectedOpening[]): Promise<GreyboxLedger> {
  const { data, info } = await sharp(maskPng).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const labels = new Int32Array(w * h);
  const areas: number[] = [0]; // index 0 is "unlabelled"
  let next = 1;
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (data[start] < 128 || labels[start] !== 0) continue;
    const id = next++;
    let area = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) push(p - 1, id);
      if (x < w - 1) push(p + 1, id);
      if (y > 0) push(p - w, id);
      if (y < h - 1) push(p + w, id);
    }
    areas[id] = area;
  }

  // Takes `id` explicitly rather than re-deriving it from `next - 1`: `next`
  // advances to the NEXT component's id as soon as one starts, so reading it
  // back inside the loop only ever worked because `push` was never called
  // between `const id = next++` and the while-loop that uses it — an
  // invisible coupling that breaks the moment this gets reordered. Passing
  // `id` in removes the coupling; behaviour is otherwise identical.
  function push(n: number, id: number) {
    if (labels[n] === 0 && data[n] >= 128) {
      labels[n] = id;
      stack.push(n);
    }
  }

  const typeByLabel = new Map<number, "door" | "window">();
  for (const o of projected) {
    if (o.px < 0 || o.py < 0) continue;
    const found = labelNear(o.px, o.py);
    if (found > 0 && areas[found] >= MIN_COMPONENT_PX) typeByLabel.set(found, o.type);
  }

  function labelNear(px: number, py: number): number {
    for (let r = 0; r <= SEARCH_RADIUS; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const l = labels[y * w + x];
          if (l > 0) return l;
        }
      }
    }
    return 0;
  }

  // Two openings whose projected centres land in the same component (e.g. a
  // pair of French doors modelled as two openings but rendered as one
  // aperture) collapse to a single map entry keyed by that component's label
  // — counting once, not a bug: the model sees one aperture, so the ledger
  // should say one.
  let doors = 0;
  let windows = 0;
  for (const t of typeByLabel.values()) {
    if (t === "door") doors++;
    else windows++;
  }
  return { doors, windows };
}
