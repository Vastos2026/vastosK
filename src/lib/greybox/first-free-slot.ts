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
import { furnitureForRoomType } from "./furniture-catalogue";
import { uid } from "@/lib/utils";
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
  return freeSlots(kind, furniture, spec, camera)[0] ?? null;
}

/**
 * Every grid slot that is in frame, legal and free — `firstFreeSlot`'s full
 * candidate list rather than just its head, in the same fixed scan order, so
 * `freeSlots(...)[0]` is by construction identical to what `firstFreeSlot`
 * always returned.
 *
 * Exists because seeding a room's DEFAULT arrangement needs to spread several
 * items apart from each other, which the first-match-wins search cannot do:
 * calling it repeatedly clusters every piece into the same corner of the
 * scan order. `defaultArrangementFor` picks from this list instead.
 */
export function freeSlots(
  kind: string,
  furniture: PlacedFurniture[],
  spec: GreyboxRoomSpec,
  camera: THREE.PerspectiveCamera,
): { x: number; z: number }[] {
  const { width, depth } = spec;
  const others = toWorldFurniture(furniture, width, depth);
  const cameraPos = { x: camera.position.x, z: camera.position.z };
  const out: { x: number; z: number }[] = [];

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
      if (r.x === wx && r.z === wz && isInFrame(wx, wz, camera)) out.push({ x: lx, z: lz });
    }
  }
  return out;
}

/** How many pieces a room is seeded with when the editor first opens. */
const DEFAULT_PIECES = 3;

/**
 * A starting arrangement for a room with no furniture yet, so the 3D editor
 * never opens to an empty room — the same "seed something to adjust, not a
 * blank canvas" principle Phase A applied to openings (seedPlacedOpenings).
 *
 * Replaces the previous `defaultFurnitureFor` in furniture-layout.ts, which
 * spread items along the back wall at a hardcoded `z: 0.18` with NO camera
 * check and NO overlap check. That was a real bug on both counts, and both
 * were reported: with Task 14's locked camera the back wall is frequently
 * outside the frustum (or behind the camera entirely, depending on which of
 * the eight candidate viewpoints a given room's openings select), so the
 * seeded pieces were often invisible in the reference render that actually
 * conditions generation — and since nothing consulted the AABB solver, two
 * pieces in a small room simply interpenetrated.
 *
 * Every piece here goes through the same `resolvePlacement` + `isInFrame`
 * gate the editor's own Add button uses, so a seeded arrangement is legal and
 * visible by construction, not by luck. A piece with no legal in-frame slot
 * left is SKIPPED rather than forced somewhere illegal: fewer pieces the user
 * can see and drag beats a piece stuck outside the frame that they cannot.
 *
 * Deterministic — `freeSlots` scans in fixed order and both selection rules
 * below break ties by that order, so the same room always seeds identically.
 * That matters for the same reason camera determinism does: a regenerated
 * greybox must not silently rearrange itself.
 */
export function defaultArrangementFor(
  roomType: string | undefined,
  spec: GreyboxRoomSpec,
  camera: THREE.PerspectiveCamera,
): PlacedFurniture[] {
  const entries = furnitureForRoomType(roomType).slice(0, DEFAULT_PIECES);
  const placed: PlacedFurniture[] = [];

  for (const entry of entries) {
    const slots = freeSlots(entry.kind, placed, spec, camera);
    if (slots.length === 0) continue;
    const slot = placed.length === 0 ? mostCentral(slots) : farthestFrom(slots, placed, spec);
    placed.push({ id: uid("furn"), kind: entry.kind, x: slot.x, z: slot.z, rotation: 0 });
  }

  return placed;
}

/**
 * The slot nearest the room's centre, for the first piece. Central slots are
 * the safest bet for staying in frame across all eight candidate cameras, and
 * the largest piece of a room type's catalogue slice is listed first.
 */
function mostCentral(slots: { x: number; z: number }[]): { x: number; z: number } {
  let best = slots[0];
  let bestD = Infinity;
  for (const s of slots) {
    const d = (s.x - 0.5) ** 2 + (s.z - 0.5) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * The slot whose nearest already-placed neighbour is furthest away — a plain
 * greedy max-min spread, so seeded pieces read as an arrangement rather than
 * a pile. Distances are in feet, not room fractions: a 0.1 gap means very
 * different things in a 6ft bathroom and a 24ft hall.
 */
function farthestFrom(
  slots: { x: number; z: number }[],
  placed: PlacedFurniture[],
  spec: GreyboxRoomSpec,
): { x: number; z: number } {
  let best = slots[0];
  let bestD = -Infinity;
  for (const s of slots) {
    let nearest = Infinity;
    for (const p of placed) {
      const dx = (s.x - p.x) * spec.width;
      const dz = (s.z - p.z) * spec.depth;
      nearest = Math.min(nearest, dx * dx + dz * dz);
    }
    if (nearest > bestD) {
      bestD = nearest;
      best = s;
    }
  }
  return best;
}
