import * as THREE from "three";
import { openingCentre } from "./build-scene";
import type { GreyboxRoomSpec } from "./types";

/** Eye height, feet. */
const EYE_H = 5;
/** How far a camera sits off the wall/corner it backs onto, as a fraction of the room. */
const INSET = 0.04;
/**
 * Wide, deliberately: at 75 the spike room's door sat ~56 degrees off-axis and
 * fell just outside the frame from every candidate. 85 vertical is roughly a
 * 14-16mm lens on full frame — standard for architectural interiors, and the
 * only way a small room fits enough of itself in one shot.
 */
const FOV = 85;
/** Keep an opening this far inside the frame edge (NDC) before counting it visible. */
const EDGE_MARGIN = 0.92;

/**
 * The automatic camera rule: try every sensible viewpoint and keep the one
 * that actually gets the most openings into frame.
 *
 * Heuristics were tried first and both failed on a live render of the same
 * room: "stand diagonally opposite the main door" put both windows behind the
 * camera, and "back onto the wall with the fewest openings" pushed a door
 * sitting near that wall's end out of frame. Openings are the entire reason
 * this reference image exists, so rather than guess at a rule, this projects
 * each opening through each candidate camera and counts what lands on screen.
 *
 * Candidates are the four wall midpoints plus the four corners, all aimed at
 * the room's centre. Scoring is: most openings visible wins; ties break toward
 * the viewpoint whose openings sit nearest the frame centre, then by candidate
 * order. The order is fixed, so the same room always yields the same camera —
 * a regenerated image must not silently change viewpoint.
 */
export function greyboxCamera(spec: GreyboxRoomSpec, aspect: number): THREE.PerspectiveCamera {
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const ix = spec.width * INSET;
  const iz = spec.depth * INSET;

  const candidates: [number, number][] = [
    // Wall midpoints.
    [0, -hd + iz],
    [0, hd - iz],
    [-hw + ix, 0],
    [hw - ix, 0],
    // Corners — wider coverage, used when no single wall works.
    [-hw + ix, -hd + iz],
    [hw - ix, -hd + iz],
    [-hw + ix, hd - iz],
    [hw - ix, hd - iz],
  ];

  const centres = spec.openings.map((o) => openingCentre(spec, o));

  let best: { camera: THREE.PerspectiveCamera; seen: number; spread: number } | null = null;

  for (const [cx, cz] of candidates) {
    const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.15, 200);
    camera.position.set(cx, EYE_H, cz);
    // Level, not tilted down. At 85 degrees a downward tilt produces severe
    // vertical keystoning — walls converge toward the top of frame — and a
    // tilted ultra-wide is doubly outside the model's training distribution.
    // Architectural photography keeps the sensor plane vertical for exactly
    // this reason. Section 3.3.
    camera.lookAt(0, EYE_H, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    let seen = 0;
    let spread = 0;
    for (const c of centres) {
      const p = c.clone().project(camera);
      // project() mirrors points that are BEHIND the camera back into range,
      // so an explicit in-front test is required — without it, an opening
      // directly behind the camera scores as visible.
      const inFront = c.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) > 0;
      if (inFront && Math.abs(p.x) < EDGE_MARGIN && Math.abs(p.y) < EDGE_MARGIN) {
        seen++;
        spread += Math.hypot(p.x, p.y);
      }
    }

    if (!best || seen > best.seen || (seen === best.seen && seen > 0 && spread < best.spread)) {
      best = { camera, seen, spread };
    }
  }

  // `candidates` is non-empty, so `best` is always set by the loop above.
  return best!.camera;
}
