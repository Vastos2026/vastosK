/**
 * Deterministic "first free spot" search for a brand-new furniture item —
 * the Furnish editor's (Task 15) sidebar Add buttons. Extracted into its own
 * neutral module (no "use client") rather than left inline in the page, for
 * two reasons: it is real, load-bearing logic — with Task 14's locked camera,
 * an item placed outside the frustum or inside the camera's exclusion arc
 * cannot be dragged back into view, so "somewhere reasonable" is not an
 * adequate default — and it needs dev-check coverage, which a "use client"
 * page file cannot get (dev-check runs server-side). Matches this repo's
 * established pattern of pulling pure placement/validation logic out of
 * page.tsx and into src/lib/greybox/ (validate-furniture.ts,
 * validate-openings.ts did the same for their own concerns).
 */
import * as THREE from "three";
import { resolvePlacement } from "./validate-furniture";
import { toWorldFurniture } from "./furniture-layout";
import type { GreyboxRoomSpec } from "./types";
import type { PlacedFurniture } from "@/lib/types";

/** Furniture must stay this far inside the frame edge (NDC) to be offered a slot. */
const EDGE_MARGIN = 0.9;
/** Eye height a piece of furniture is judged at — camera.ts's own EYE_H (5ft) is a person's eye, not a nightstand's. */
const FURNITURE_EYE_H = 1.5;

/**
 * Replicates camera.ts's own in-front + edge-of-frame test (the `seen`/
 * `spread` scoring loop inside `greyboxCamera`), at furniture height rather
 * than camera.ts's own EYE_H, so a piece near the floor is judged by where
 * IT appears in frame, not where a person's eye would.
 *
 * The 0.9 threshold is deliberately tighter than camera.ts's own EDGE_MARGIN
 * (0.92) for openings — furniture shouldn't be offered a spot right at the
 * frame edge, where a later openings edit (which moves the locked camera)
 * could push it out of frame entirely with no way for the user to notice.
 */
export function isInFrame(wx: number, wz: number, camera: THREE.PerspectiveCamera): boolean {
  const point = new THREE.Vector3(wx, FURNITURE_EYE_H, wz);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  // project() mirrors points BEHIND the camera back into valid NDC range
  // instead of erroring (see camera.ts's own comment on this exact hazard) —
  // the explicit in-front dot-product test is what actually catches that,
  // never the projected coordinates alone.
  const inFront = point.clone().sub(camera.position).dot(forward) > 0;
  if (!inFront) return false;
  const p = point.clone().project(camera);
  return Math.abs(p.x) < EDGE_MARGIN && Math.abs(p.y) < EDGE_MARGIN;
}

/**
 * First position that is in frame, legal (room bounds, the camera's own
 * exclusion disk, no overlap with existing furniture — resolvePlacement's
 * own rules), and non-overlapping. Scans a coarse 6x6 grid in a FIXED order
 * (z outer, x inner, both 1..6 of 7) so adding the same kind of item to the
 * same room always lands in the same spot — a regenerated layout must not
 * silently reshuffle where a freshly-added item appears.
 *
 * `furniture` is passed straight through to resolvePlacement as "others" —
 * the item being added doesn't exist yet, so every existing item is a
 * candidate blocker — converted to world-feet via toWorldFurniture, the same
 * conversion the live canvas and ensureGreybox both use.
 *
 * Each grid point is tested by asking resolvePlacement to place a brand-new
 * item there with `fromX`/`fromZ` set to NaN. resolvePlacement's own
 * precondition comment (validate-furniture.ts) says its unconditional
 * last-resort fallback requires a pre-validated fromX/fromZ, which NaN
 * deliberately is not — but that fallback can only be REACHED when the
 * direct `legal(input.x, input.z)` check on the actual proposed point has
 * already failed, and NaN can never equal the proposed (wx, wz) exactly, so
 * the `r.x === wx && r.z === wz` guard below only ever accepts a point
 * `legal()` verified directly against the real proposal — never a
 * NaN-tainted fallback silently passing as "legal".
 *
 * Returns local [0,1] room-fraction coordinates (matching PlacedFurniture's
 * own x/z convention), or `null` when no grid cell is in frame, legal, and
 * free — the caller's cue to say so rather than adding an item nobody can
 * see or reach.
 */
export function firstFreeSlot(
  kind: string,
  furniture: PlacedFurniture[],
  spec: GreyboxRoomSpec,
  camera: THREE.PerspectiveCamera,
): { x: number; z: number } | null {
  const { width, depth } = spec;
  const others = toWorldFurniture(furniture, width, depth);
  const cameraPos = { x: camera.position.x, z: camera.position.z };

  for (let iz = 1; iz <= 6; iz++) {
    for (let ix = 1; ix <= 6; ix++) {
      const lx = ix / 7;
      const lz = iz / 7;
      const wx = (lx - 0.5) * width;
      const wz = (lz - 0.5) * depth;
      const r = resolvePlacement(
        { kind, rotation: 0, x: wx, z: wz, fromX: NaN, fromZ: NaN },
        others,
        { width, depth },
        cameraPos,
      );
      if (r.x === wx && r.z === wz && isInFrame(wx, wz, camera)) return { x: lx, z: lz };
    }
  }
  return null;
}
