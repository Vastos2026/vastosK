import * as THREE from "three";
import { catalogueEntry } from "./furniture-catalogue";
import { openingCentre } from "./build-scene";
import type { GreyboxFurniturePlacement, GreyboxOpening, GreyboxRoomSpec } from "./types";

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

/**
 * How close a piece must be to an opening before it may be described in terms
 * of that opening — Extension 1's whole safety story.
 *
 * Measured in WORLD FEET between footprint edges, never in screen space. That
 * choice is load-bearing: "under the window" is a claim about PHYSICAL
 * adjacency, and two things can sit next to each other on screen while being
 * fifteen feet apart in the room (a piece against the near wall lines up with
 * a window on the far one all the time). Anchoring off screen proximity would
 * therefore state a spatial fact the render contradicts — the exact class of
 * error commit de40894 deleted positional prose to avoid. Screen space is
 * still used, but only to decide WHICH pieces and openings are visible.
 *
 * The margin is measured from the piece's EDGE, not its centre, by adding
 * half its smaller footprint dimension to a fixed 2.5ft. A fixed centre-based
 * radius would have been wrong in both directions at once: a bed pushed flat
 * against the window wall has its centre 3.4ft out and would have been
 * rejected, while a nightstand marooned in open floor 3ft from a wall would
 * have been accepted.
 *
 * A piece outside this reach keeps the original frame-band description
 * unchanged. That is the default, not the exception — most furniture in most
 * rooms is not next to an opening, and inventing an anchor for it would be
 * worse than the mild ambiguity of "at centre".
 */
const ANCHOR_MARGIN_FT = 2.5;

/** An in-frame opening, with what the anchor needs: where it is, and where it appears. */
interface AnchorCandidate {
  id: string;
  type: GreyboxOpening["type"];
  /** World position, for the physical-adjacency test. */
  x: number;
  z: number;
  /** NDC x, only for qualifying "the window" when more than one is visible. */
  ndcX: number;
}

/**
 * The in-frame openings, in the same NDC space and through the same camera as
 * the furniture below — see camera.ts's `projectOpenings`, which performs the
 * identical projection for the mask. The in-front dot-product guard is
 * repeated here for the same reason it exists there: `Vector3.project()`
 * mirrors points behind the camera back into valid NDC instead of failing, so
 * an opening on the wall BEHIND the viewer would otherwise report as sitting
 * in the middle of the frame and could anchor a piece to something invisible.
 */
function anchorCandidates(spec: GreyboxRoomSpec, camera: THREE.PerspectiveCamera): AnchorCandidate[] {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const out: AnchorCandidate[] = [];
  for (const o of spec.openings ?? []) {
    const world = openingCentre(spec, o);
    const inFront = world.clone().sub(camera.position).dot(forward) > 0;
    if (!inFront) continue;
    const p = world.clone().project(camera);
    if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
    out.push({ id: o.id, type: o.type, x: world.x, z: world.z, ndcX: p.x });
  }
  return out;
}

/**
 * The preposition. A window sits high on the wall and furniture sits beneath
 * it, so "under" is literally true; a door runs to the floor, so nothing is
 * ever under one and "beside" is the only honest word.
 *
 * Chosen over measuring the piece's actual height on purpose — height is not
 * on the catalogue entry, it would mean building the mesh just to read a
 * bounding box, and the door/window split already gets the right answer for
 * every piece in the catalogue.
 */
function preposition(type: GreyboxOpening["type"]): string {
  return type === "door" ? "beside" : "under";
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

  // Extension 1: anchor a piece to an opening when it is genuinely beside one.
  //
  // The frame-band description alone is weak by construction — the bands are
  // thirds, so an ordinary room puts every piece in "centre" and the ordinal
  // tie-break does all the work. Worse, six catalogue entries share the shape
  // word "long low box", so a living room with a sofa, a TV unit and a
  // wardrobe hands the model three identical descriptions separated only by
  // left/middle/right. An opening is the one landmark both the prompt and the
  // reference image can name, and camera.ts already projects openings through
  // this exact camera, so the anchor is derived from the render rather than
  // asserted alongside it.
  const openings = anchorCandidates(spec, camera);
  // Only when MORE THAN ONE visible opening shares a type does "the window"
  // need qualifying. With a single window in frame, "under the window at
  // left" spends four words to say nothing.
  const ambiguous = new Set(
    openings
      .map((o) => o.type)
      .filter((t, _i, all) => all.filter((x) => x === t).length > 1),
  );

  const anchorOf = new Map<number, string>();
  for (const r of visible) {
    const f = furniture[r.index];
    const entry = catalogueEntry(r.kind);
    if (!entry) continue;
    // Edge-to-centre reach — see ANCHOR_MARGIN_FT.
    const reach = ANCHOR_MARGIN_FT + Math.min(entry.footprintFt.w, entry.footprintFt.d) / 2;
    let best: { o: AnchorCandidate; dist: number } | null = null;
    for (const o of openings) {
      const dist = Math.hypot(o.x - f.x, o.z - f.z);
      if (dist > reach) continue;
      if (!best || dist < best.dist) best = { o, dist };
    }
    // No opening within reach: this piece keeps the frame-band phrasing
    // untouched. The explicit, required fallback.
    if (!best) continue;
    const qualifier = ambiguous.has(best.o.type) ? ` at ${horizontalBand(best.o.ndcX)}` : "";
    anchorOf.set(r.index, `${preposition(best.o.type)} the ${best.o.type}${qualifier}`);
  }

  return raw.map((r) => {
    if (!r.inFrame) return { index: r.index, kind: r.kind, phrase: "", inFrame: false };
    const anchor = anchorOf.get(r.index);
    // Two pieces can legitimately sit under the SAME window. Their anchors
    // would then be identical, which is worse than no anchor — it points the
    // model at one landmark for two boxes. Fall back to the ordinal tie-break
    // among exactly the pieces that collided, reusing the band logic below
    // rather than inventing a second scheme.
    const collides = anchor !== undefined && [...anchorOf.values()].filter((a) => a === anchor).length > 1;
    if (anchor && !collides) {
      return { index: r.index, kind: r.kind, phrase: `the ${shapeWord(r.kind)} ${anchor}`, inFrame: true };
    }
    // Peers to rank against: the colliding anchor group when there is one,
    // otherwise everything sharing this piece's frame band.
    const band = horizontalBand(r.ndcX);
    const peers = collides
      ? visible.filter((o) => anchorOf.get(o.index) === anchor)
      : // Disambiguate only when two visible pieces share a band, and only
        // among those — "the leftmost of the two boxes at left" is worth the
        // words, but qualifying a piece that is already alone in its third is
        // noise, and words are the scarce resource in a FLUX prompt.
        visible.filter((o) => horizontalBand(o.ndcX) === band);
    let position = collides ? (anchor as string) : `at ${band}`;
    if (peers.length > 1) {
      const ordered = [...peers].sort((a, b) => a.ndcX - b.ndcX);
      const rank = ordered.findIndex((o) => o.index === r.index);
      const ordinal = rank === 0 ? "nearer left" : rank === ordered.length - 1 ? "nearer right" : "in the middle";
      position = `${position}, ${ordinal}`;
    }
    return { index: r.index, kind: r.kind, phrase: `the ${shapeWord(r.kind)} ${position}`, inFrame: true };
  });
}
