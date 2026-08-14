/**
 * Section 6. Occlusion is the ONLY mechanism by which furniture threatens
 * opening accuracy — an opening the camera cannot see is an opening the model
 * will invent. Furniture always yields; an opening never moves.
 *
 * Split into two kinds of rule:
 *   - resolvePlacement: hard, applied during drag. Clamps rather than
 *     rejects, so an item slides along an obstacle instead of sticking.
 *   - checkOcclusion / resolveOcclusion: needs a scene and a camera, so it
 *     runs on drag-commit for live warnings and again at save time as the
 *     gate that actually guarantees the section 6.1 threshold.
 */
import * as THREE from "three";
import { catalogueEntry } from "./furniture-catalogue";
import { openingFaceSamples } from "./build-scene";
import { projectOpenings } from "./camera";
import type { GreyboxRoomSpec } from "./types";
import type { PlacedFurniture } from "@/lib/types";

/** Section 6.3. Past ~6 the massing reads as clutter and buries the wall junctions the model needs. */
export const MAX_FURNITURE = 5;
/** Section 3.3/6.2 — corner cameras sit ~0.4ft off the wall; without this, proxies land at the lens. */
const CAMERA_EXCLUSION_FT = 2.6;
/** Section 6.3 — proxies stay off the walls. 50mm. */
const WALL_GAP_FT = 0.164;
/** Section 6.1 — every opening must be at least this visible. */
const MIN_VISIBLE_FRACTION = 0.85;
/** Rugs are floor-level planes; furniture sits on top of them by design. */
const OVERLAP_EXEMPT = new Set(["rug"]);

export interface Aabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * World-feet AABB of a placement. Rotation is folded into the box extents
 * rather than tracked as an oriented rect: section 6.3 asks for AABB overlap,
 * and a rotated-bounds approximation errs toward more clearance, never less.
 */
export function footprintAabb(kind: string, x: number, z: number, rotation: number): Aabb {
  const entry = catalogueEntry(kind);
  const w = entry?.footprintFt.w ?? 1;
  const d = entry?.footprintFt.d ?? 1;
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const ew = (w * c + d * s) / 2;
  const ed = (w * s + d * c) / 2;
  return { minX: x - ew, maxX: x + ew, minZ: z - ed, maxZ: z + ed };
}

function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export interface PlacementInput {
  kind: string;
  rotation: number;
  /** Proposed world-feet position. */
  x: number;
  z: number;
  /** Last known-good world-feet position, returned when no legal move exists. */
  fromX: number;
  fromZ: number;
}

/**
 * The nearest legal position to `proposed`. Tries the full move, then each
 * axis alone, then holds. Axis fallback is what makes dragging along a wall
 * past a sofa feel like sliding rather than sticking.
 *
 * PRECONDITION — read before wiring this into a caller (Task 14/15): the
 * first three candidates below are each re-validated by `legal()` (room
 * bounds, camera exclusion, overlap), but the LAST resort — `{ x: fromX,
 * z: fromZ }` at the bottom — is returned completely unconditionally, with
 * no check of its own. This function therefore requires `input.fromX`/
 * `input.fromZ` to already be a legal position: either a value THIS
 * function previously returned, or a position otherwise confirmed legal
 * before the first call (e.g. Task 15's `firstFreeSlot` for an initial
 * spawn). It has no history and no way to verify that on its own.
 *
 * If a caller ever breaks that invariant — seeds `fromX`/`fromZ` from an
 * unchecked spawn point, or carries forward a position that was legal
 * before the room was resized or the camera moved (an openings edit can
 * move the locked camera) — this function will hand that illegal position
 * straight back with no error, no warning, and nothing in its return value
 * to signal the problem.
 */
export function resolvePlacement(
  input: PlacementInput,
  others: { kind: string; x: number; z: number; rotation: number }[],
  room: { width: number; depth: number },
  cameraPos: { x: number; z: number },
): { x: number; z: number } {
  const blockers = others
    .filter((o) => !OVERLAP_EXEMPT.has(o.kind))
    .map((o) => footprintAabb(o.kind, o.x, o.z, o.rotation));
  const exempt = OVERLAP_EXEMPT.has(input.kind);

  const legal = (x: number, z: number): boolean => {
    const box = footprintAabb(input.kind, x, z, input.rotation);
    if (
      box.minX < -room.width / 2 + WALL_GAP_FT ||
      box.maxX > room.width / 2 - WALL_GAP_FT ||
      box.minZ < -room.depth / 2 + WALL_GAP_FT ||
      box.maxZ > room.depth / 2 - WALL_GAP_FT
    ) {
      return false;
    }
    const reach = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2;
    if (Math.hypot(x - cameraPos.x, z - cameraPos.z) < CAMERA_EXCLUSION_FT + reach) return false;
    if (!exempt && blockers.some((b) => overlaps(box, b))) return false;
    return true;
  };

  if (legal(input.x, input.z)) return { x: input.x, z: input.z };
  if (legal(input.x, input.fromZ)) return { x: input.x, z: input.fromZ };
  if (legal(input.fromX, input.z)) return { x: input.fromX, z: input.z };
  return { x: input.fromX, z: input.fromZ };
}

/** Why `resolvePlacement` would not accept a raw proposed position as-is. */
export interface BounceReason {
  kind: "bounds" | "exclusion" | "overlap";
  /** id of the furniture item the position would have overlapped — only set when `kind === "overlap"`. */
  blockerId?: string;
}

/**
 * Diagnoses WHY `resolvePlacement` rejected `input`'s raw (x, z) — the
 * furnish editor's live drag/nudge/rotate feedback bounces a piece back to a
 * legal spot correctly, but gave no indication of WHY, which is what
 * furniture-editor-canvas.tsx's onCommit surfaces this for (reported
 * 2026-08-14). Deliberately a separate function rather than a change to
 * `resolvePlacement` itself: that function's contract (four-candidate
 * fallback, unconditional last resort) is exercised by dev-check and other
 * callers and must not change shape just to grow a reason code.
 *
 * Checks in the exact same order `legal()` above does — bounds, then camera
 * exclusion, then overlap — so this can never name a reason `resolvePlacement`
 * itself would not have rejected on first. Returns null when the raw position
 * was actually legal, i.e. there was nothing for resolvePlacement to correct.
 *
 * `others` takes an id per item (`resolvePlacement`'s own `others` doesn't)
 * purely so a caller can name the specific piece a proposal collided with;
 * the geometry check itself is identical to `legal()`'s overlap branch.
 */
export function explainPlacementBounce(
  input: PlacementInput,
  others: { id: string; kind: string; x: number; z: number; rotation: number }[],
  room: { width: number; depth: number },
  cameraPos: { x: number; z: number },
): BounceReason | null {
  const box = footprintAabb(input.kind, input.x, input.z, input.rotation);
  if (
    box.minX < -room.width / 2 + WALL_GAP_FT ||
    box.maxX > room.width / 2 - WALL_GAP_FT ||
    box.minZ < -room.depth / 2 + WALL_GAP_FT ||
    box.maxZ > room.depth / 2 - WALL_GAP_FT
  ) {
    return { kind: "bounds" };
  }
  const reach = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2;
  if (Math.hypot(input.x - cameraPos.x, input.z - cameraPos.z) < CAMERA_EXCLUSION_FT + reach) {
    return { kind: "exclusion" };
  }
  if (!OVERLAP_EXEMPT.has(input.kind)) {
    const blocker = others.find(
      (o) => !OVERLAP_EXEMPT.has(o.kind) && overlaps(box, footprintAabb(o.kind, o.x, o.z, o.rotation)),
    );
    if (blocker) return { kind: "overlap", blockerId: blocker.id };
  }
  return null;
}

export interface OcclusionViolation {
  openingId: string;
  openingType: "door" | "window";
  visibleFraction: number;
  /** id of the furniture item responsible, when one can be identified. */
  blockerId?: string;
  blockerLabel?: string;
}

/**
 * Section 6.1's raycast gate. Samples a 5x5 grid across each opening's face
 * and counts how many rays are blocked by FURNITURE rather than reaching the
 * opening cleanly.
 *
 * Two things this deliberately does NOT flag, both explained on the file's
 * top comment ("furniture always yields; an opening never moves; furniture
 * is the ONLY mechanism by which... accuracy" — nothing else can yield):
 *
 * 1. An opening the camera cannot see at all. `Room.cameraView` lets the
 *    user stand the camera against a wall, and that wall's own openings are
 *    then behind the camera by construction (GreyboxCameraView's doc
 *    comment) — a corner/off-axis pick can also push an opening off to the
 *    side, outside the frame. Neither is furniture's fault and moving
 *    furniture cannot fix either one; it is a camera-coverage fact, already
 *    surfaced to the user through `cameraCoverage()`'s angle picker. Openings
 *    that fail this test are excluded from the raycast pass entirely — see
 *    `inView` below, which reuses `projectOpenings`'s own in-front-of-camera
 *    + on-screen (NDC) test rather than re-deriving it, so this function and
 *    the picker's "sees N of M openings" count can never disagree about
 *    which openings are in view. (Skipping the in-front check would be a
 *    real bug: `Vector3.project()` mirrors points BEHIND the camera back
 *    into valid NDC range instead of erroring, so an opening directly behind
 *    the camera would otherwise register as "on screen" — the exact trap
 *    `projectOpenings`'s own comment warns about.)
 * 2. A ray blocked by the room's OWN geometry — a reveal jamb, a corner
 *    post, another opening's filler at a grazing angle — rather than by
 *    furniture. Nothing about that is a placement problem the user can act
 *    on, so only a hit that resolves to a `furnitureId` counts against an
 *    opening's visible fraction.
 *
 * Together these guarantee the invariant `resolveOcclusion`/the editor rely
 * on: a violation this function returns always has furniture to blame, so
 * `blockerId` is always set below (`blocked` only increments alongside a
 * `blockers` entry, and `blocked > 0` is required to drop `fraction` under
 * the threshold) — never something to paper over with a "Something" label.
 *
 * `scene` must be the SAME scene graph being rendered, and `camera` the
 * locked export camera — a visibility answer from a different viewpoint is
 * worthless.
 */
export function checkOcclusion(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  spec: GreyboxRoomSpec,
): OcclusionViolation[] {
  const raycaster = new THREE.Raycaster();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const out: OcclusionViolation[] = [];

  const inView = new Set(
    projectOpenings(spec, camera)
      .filter((p) => p.px !== -1)
      .map((p) => p.id),
  );

  for (const opening of spec.openings) {
    if (!inView.has(opening.id)) continue; // camera-coverage fact, not an occlusion violation

    const samples = openingFaceSamples(spec, opening);
    let blocked = 0;
    const blockers = new Map<string, number>();

    for (const p of samples) {
      const dir = p.clone().sub(origin).normalize();
      raycaster.set(origin, dir);
      const hit = raycaster.intersectObject(scene, true)[0];
      if (!hit) continue;
      if (hit.object.userData.openingId === opening.id) continue; // reached the opening cleanly

      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.furnitureId) o = o.parent;
      if (!o?.userData.furnitureId) continue; // blocked by static room geometry, not furniture — not this function's concern
      const id = o.userData.furnitureId as string;
      blockers.set(id, (blockers.get(id) ?? 0) + 1);
      blocked++;
    }

    const fraction = 1 - blocked / samples.length;
    if (fraction < MIN_VISIBLE_FRACTION) {
      let worst: string | undefined;
      let worstN = 0;
      for (const [id, n] of blockers) if (n > worstN) [worst, worstN] = [id, n];
      out.push({
        openingId: opening.id,
        openingType: opening.type,
        visibleFraction: fraction,
        blockerId: worst,
      });
    }
  }

  return out;
}

/**
 * Section 6.1's fallback order, run at save time for anything the live
 * warnings did not get the user to fix: shift the blocker along its wall,
 * then shrink it, then drop it. Never moves an opening.
 *
 * This implements only the terminal (drop) rung of that ladder — shift and
 * shrink both need to re-raycast against a REBUILT scene (the candidate
 * shifted/shrunk position has to be re-checked for new occlusions of its
 * own), which is a THREE.Scene + camera concern this pure function has no
 * access to. Reaching this function at all should be rare in practice:
 * resolvePlacement's hard constraints and the editor's live warnings are
 * meant to keep a user from ever painting themselves into a shift/shrink
 * corner. See the brief's note on this narrowing.
 *
 * Returns the adjusted furniture list plus a human-readable log, because
 * silently rearranging a user's layout is not acceptable — the caller shows
 * the log.
 */
export function resolveOcclusion(
  furniture: PlacedFurniture[],
  violations: OcclusionViolation[],
): { furniture: PlacedFurniture[]; changes: string[] } {
  if (!violations.length) return { furniture, changes: [] };
  const changes: string[] = [];
  const dropped = new Set<string>();

  for (const v of violations) {
    if (!v.blockerId || dropped.has(v.blockerId)) continue;
    const item = furniture.find((f) => f.id === v.blockerId);
    if (!item) continue;
    const label = catalogueEntry(item.kind)?.label ?? item.kind;
    dropped.add(v.blockerId);
    changes.push(`Removed the ${label.toLowerCase()}. It was blocking a ${v.openingType} the camera needs to see.`);
  }

  return { furniture: furniture.filter((f) => !dropped.has(f.id)), changes };
}
