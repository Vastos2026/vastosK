import * as THREE from "three";
import { catalogueEntry } from "./furniture-catalogue";
import type { GreyboxFurniturePlacement, GreyboxRoomSpec } from "./types";

/**
 * Turns each furniture proxy into a short phrase that IDENTIFIES which grey
 * box it is, as seen from the locked camera — "the wide low box at
 * centre-left", "the tall narrow box at far right".
 *
 * This closes a real hole in the prompt. Until now the furniture line was an
 * unordered set of material phrases ("...furniture: a cotton sofa and a teak
 * media console") with NO mapping to any particular box in the reference
 * image. With three boxes in frame the model had to guess which was which,
 * and it guesses by plausibility rather than by the arrangement the user
 * actually built, which is the whole point of the 3D editor.
 *
 * Note what this is and is not. The design rule "zero positional prose about
 * furniture" exists because the render owns PLACEMENT: telling the model
 * where to put a sofa creates a second source of spatial truth that can
 * contradict the image. That rule still holds. These descriptors never
 * instruct placement; they are pointers, the verbal equivalent of indexing
 * into the reference image, and they are derived FROM the render rather than
 * asserted alongside it, so they cannot disagree with it.
 *
 * Deliberately not numbered labels drawn into the render: both FLUX.2 and
 * Gemini render text well, which makes a numeral in a conditioning image
 * likely to survive into the output as a marking on the furniture. See
 * furniture-catalogue.ts's header on why nothing textual is ever drawn.
 */

/** Horizontal thirds of the frame, in NDC x. */
function horizontalBand(ndcX: number): string {
  if (ndcX < -0.33) return "left";
  if (ndcX > 0.33) return "right";
  return "centre";
}

/**
 * Proportion words from the piece's own footprint. Chosen over absolute feet
 * because the model is being asked to pick a box out of an image, and a
 * silhouette ratio is visible in that image while "4.5 feet" is not.
 */
function shapeWord(kind: string): string {
  const entry = catalogueEntry(kind);
  if (!entry) return "box";
  const { w, d } = entry.footprintFt;
  const longest = Math.max(w, d);
  const ratio = longest / Math.max(0.01, Math.min(w, d));
  if (ratio >= 2.2) return longest >= 5 ? "long low box" : "narrow box";
  if (longest >= 5) return "large box";
  if (longest <= 1.8) return "small box";
  return "box";
}

export interface FurnitureDescriptor {
  /** Index into the spec's furniture array, so callers can pair with their own list. */
  index: number;
  kind: string;
  /** e.g. "the long low box at centre-left". Empty when the piece is not in frame. */
  phrase: string;
  /** False when the piece is behind the camera or outside the frame; such a piece is not in the output at all. */
  inFrame: boolean;
}

/**
 * One descriptor per furniture item, in the spec's own order.
 *
 * Pieces NOT in frame get `inFrame: false` and an empty phrase. Callers must
 * drop those from the prompt entirely rather than describing them: a piece
 * the camera cannot see is not in the generated image, and naming it tells
 * the model to invent one. This mirrors why the opening ledger is counted
 * from the Pass B mask rather than from `openings.length`.
 *
 * The in-front dot-product test is not optional. `Vector3.project()` mirrors
 * points BEHIND the camera back into valid NDC range instead of erroring, so
 * projected coordinates alone will happily report a piece behind the camera
 * as sitting in the middle of the frame (the same hazard camera.ts documents
 * on `projectOpenings`).
 */
export function describeFurniture(
  spec: GreyboxRoomSpec,
  camera: THREE.PerspectiveCamera,
): FurnitureDescriptor[] {
  const furniture: GreyboxFurniturePlacement[] = spec.furniture ?? [];
  const forward = camera.getWorldDirection(new THREE.Vector3());

  const raw = furniture.map((f, index) => {
    // Judged at a low height rather than a person's eye height: these are
    // objects on the floor, and where a nightstand appears in frame is not
    // where a standing person's eye would be.
    const point = new THREE.Vector3(f.x, 1.5, f.z);
    const inFront = point.clone().sub(camera.position).dot(forward) > 0;
    const p = point.clone().project(camera);
    const inFrame = inFront && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    return { index, kind: f.kind, ndcX: p.x, inFrame };
  });

  const visible = raw.filter((r) => r.inFrame);

  return raw.map((r) => {
    if (!r.inFrame) return { index: r.index, kind: r.kind, phrase: "", inFrame: false };
    const band = horizontalBand(r.ndcX);
    // Disambiguate only when two visible pieces share a band, and only among
    // those — "the leftmost of the two boxes at left" is worth the words, but
    // qualifying a piece that is already alone in its third is noise, and
    // words are the scarce resource in a FLUX prompt.
    const sameBand = visible.filter((o) => horizontalBand(o.ndcX) === band);
    let position = `at ${band}`;
    if (sameBand.length > 1) {
      const ordered = [...sameBand].sort((a, b) => a.ndcX - b.ndcX);
      const rank = ordered.findIndex((o) => o.index === r.index);
      const ordinal = rank === 0 ? "nearer left" : rank === ordered.length - 1 ? "nearer right" : "in the middle";
      position = `at ${band}, ${ordinal}`;
    }
    return { index: r.index, kind: r.kind, phrase: `the ${shapeWord(r.kind)} ${position}`, inFrame: true };
  });
}
