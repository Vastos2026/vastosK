"use client";

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { buildGreyboxScene } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import { catalogueEntry } from "@/lib/greybox/furniture-catalogue";
import { toWorldFurniture, worldToLocal } from "@/lib/greybox/furniture-layout";
import { GREYBOX_ASPECT } from "@/lib/greybox/dimensions";
import {
  checkOcclusion,
  explainPlacementBounce,
  footprintAabb,
  resolvePlacement,
  type BounceReason,
  type OcclusionViolation,
} from "@/lib/greybox/validate-furniture";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";
import type { PlacedFurniture } from "@/lib/types";

/** Fallback clamp margin for an item with no catalogue entry (stale/unknown kind). */
const FALLBACK_CLAMP_MARGIN = 0.05;
/** Never let a footprint-derived margin exceed this, so min < max always holds even for an item as big as (or bigger than) the room. */
const MAX_FOOTPRINT_MARGIN = 0.45;

/**
 * Per-item clamp margins (room-local fractions) derived from the item's real
 * footprint (feet), not a flat fraction — so a large piece (e.g. a 7ft sofa
 * in a 10ft-wide room) can't have its edges poke through a wall even when
 * its CENTRE point is "clamped". Rotation is ignored (unrotated w/d), a
 * deliberate simplification, not a claim of exact collision accuracy. Falls
 * back to a flat margin for an unknown/stale kind.
 *
 * Unrelated to this task's drag/keyboard constraints (resolvePlacement below
 * handles those, with real overlap + camera-exclusion checks) — this helper
 * only picks a reasonable DEFAULT spot for a brand-new item before it has
 * ever been placed, which is still page.tsx's job (addFurniture), so it
 * stays exported unchanged.
 */
export function footprintClampMargins(kind: string, width: number, depth: number): { mx: number; mz: number } {
  const entry = catalogueEntry(kind);
  if (!entry || width <= 0 || depth <= 0) {
    return { mx: FALLBACK_CLAMP_MARGIN, mz: FALLBACK_CLAMP_MARGIN };
  }
  return {
    mx: Math.min(MAX_FOOTPRINT_MARGIN, entry.footprintFt.w / 2 / width),
    mz: Math.min(MAX_FOOTPRINT_MARGIN, entry.footprintFt.d / 2 / depth),
  };
}

/**
 * Section 3.3/6.2's dead zone around the locked camera. Duplicated from
 * validate-furniture.ts's own (unexported) `CAMERA_EXCLUSION_FT = 2.6` —
 * this task's scope is this file and the dev-check route only, so rather
 * than reach into that file to export a new constant, this local copy
 * mirrors the brief's literal "radius 2.6 ft" instruction by hand. Keep the
 * two in sync if that value ever changes.
 */
const CAMERA_EXCLUSION_FT = 2.6;
/** Keyboard nudge step, feet — ArrowLeft/Right move x, ArrowUp/Down move z. */
const NUDGE_STEP_FT = 0.25;
/** Keyboard rotate step — `[`/`]`, 15 degrees. */
const ROTATE_STEP_RAD = Math.PI / 12;
/** Amber emissive applied to any furniture item named as an occlusion blocker (checkOcclusion's blockerId). */
const BLOCKER_TINT = 0xffb020;
/**
 * Green emissive on the currently selected item. Green rather than another
 * warm tone specifically so it cannot be confused with the amber blocker
 * warning or the red drag-invalid tint — selection is neutral information,
 * not a problem, and the three states have to be tellable apart at a glance
 * in a scene that is otherwise entirely grey.
 */
const SELECTED_TINT = 0x22c55e;
/** Exclusion-arc ring colour — deliberately distinct from BLOCKER_TINT so "you can't stand here" (a fixed zone) never reads as "this is blocking an opening" (a furniture-specific warning). */
const EXCLUSION_RING_COLOR = 0xff5252;
/**
 * Transient red emissive applied ONLY to the item currently being dragged,
 * only while its live cursor-tracked position is illegal (see onPointerMove's
 * `legal` check). Deliberately a third distinct colour from both BLOCKER_TINT
 * (a settled, post-commit occlusion warning) and EXCLUSION_RING_COLOR (a
 * fixed zone marker painted on the floor) — this one means "if you let go
 * right now, resolvePlacement will snap you back," which is neither of those.
 * Cleared the moment the position is legal again, and unconditionally at drag
 * end (endDrag), where runOcclusionCheck's applyBlockerTint pass takes over.
 */
const DRAG_INVALID_TINT = 0xff3838;

/**
 * Disposes every geometry/material found under `root` — covers wall/floor/
 * ceiling panels, furniture proxies, and the camera exclusion-arc ring
 * (added as a sibling of the room group directly onto the scene, see
 * rebuildScene below), all of which are plain Meshes.
 */
function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    anyObj.geometry?.dispose();
    if (anyObj.material) {
      if (Array.isArray(anyObj.material)) anyObj.material.forEach((m) => m.dispose());
      else anyObj.material.dispose();
    }
  });
}

/**
 * Confines a drag target to the room, accounting for the item's ROTATED
 * footprint so a piece turned 45 degrees stops at the point its corner would
 * touch the wall, not its centre.
 *
 * This is deliberately a clamp and not a resolvePlacement call. A clamp is
 * continuous and monotonic: pushing the cursor further past a wall keeps
 * returning the same edge position, so the mesh sits still against the wall
 * instead of flickering. That is what makes hard confinement safe to apply on
 * every pointermove, where feeding resolvePlacement's four-candidate fallback
 * straight into the mesh was not (see onPointerMove's own comment — near a
 * boundary the winning candidate flips frame to frame, which is the original
 * "glitchy drag" bug and must not come back).
 *
 * So the two constraints are split by how they behave under motion. Room
 * bounds are enforced live, because clamping them is smooth. Overlap and the
 * camera exclusion disk stay advisory during the gesture (the red tint) and
 * are resolved once on release, because those cannot be clamped without
 * oscillating.
 */
function clampToRoom(
  kind: string,
  rotation: number,
  x: number,
  z: number,
  spec: { width: number; depth: number },
): { x: number; z: number } {
  // Half-extents of the rotated footprint, read off an AABB built at the
  // origin so the box's own centre offset does not enter the arithmetic.
  const box = footprintAabb(kind, 0, 0, rotation);
  const hx = (box.maxX - box.minX) / 2;
  const hz = (box.maxZ - box.minZ) / 2;
  const limX = Math.max(0, spec.width / 2 - hx);
  const limZ = Math.max(0, spec.depth / 2 - hz);
  return {
    x: Math.min(limX, Math.max(-limX, x)),
    z: Math.min(limZ, Math.max(-limZ, z)),
  };
}

/**
 * Sets (or clears, with 0x000000) emissive colour on every MeshStandardMaterial
 * found under `group`. Shared by applyBlockerTint (settled, post-commit
 * occlusion warnings) and the drag handlers in the mount-once effect below
 * (transient "this spot is illegal" feedback while dragging) — one traversal,
 * two callers, instead of duplicating the walk.
 */
function setGroupEmissive(group: THREE.Object3D, hex: number) {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.material instanceof THREE.MeshStandardMaterial) {
      obj.material.emissive.setHex(hex);
    }
  });
}

/**
 * What the canvas reports on every commit (drag release, arrow-key nudge,
 * `[`/`]` rotate): a partial room-local update — {x,z} for a move, {rotation}
 * (plus {x,z} when resolvePlacement had to nudge the item to dodge a new
 * overlap the rotation created) for a turn — or `null`, which the page
 * interprets as "remove this item" (Delete/Backspace).
 */
export type FurnitureCommitPatch = Partial<Pick<PlacedFurniture, "x" | "z" | "rotation">> | null;

/**
 * Builds `explainPlacementBounce`'s `others` list for one item: the same
 * furniture set `resolvePlacement` itself is given, but with each entry's id
 * carried along so a bounce reason can name the specific piece it collided
 * with. `resolvePlacement`'s own `others` param deliberately drops ids (it
 * has no need to name anything), so this is assembled fresh at each call site
 * rather than reused.
 */
function othersWithId(
  all: PlacedFurniture[],
  excludeId: string,
  width: number,
  depth: number,
): { id: string; kind: string; x: number; z: number; rotation: number }[] {
  return all
    .filter((item) => item.id !== excludeId && !!catalogueEntry(item.kind))
    .map((item) => {
      const world = toWorldFurniture([item], width, depth)[0]!;
      return { id: item.id, kind: item.kind, x: world.x, z: world.z, rotation: world.rotation };
    });
}

interface FurnitureEditorState {
  spec: GreyboxRoomSpec;
  furniture: PlacedFurniture[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (id: string, patch: FurnitureCommitPatch, bounce?: BounceReason) => void;
  onOcclusionChange: (violations: OcclusionViolation[]) => void;
}

interface DragState {
  id: string;
  /** The live furniture Group being dragged — mutated directly every pointermove. */
  group: THREE.Group;
  /**
   * Last known-good world-feet position. PRECONDITION (validate-furniture.ts):
   * resolvePlacement's final fallback returns this unchecked, so it must
   * always be a position resolvePlacement itself previously returned — set
   * here from the live group's CURRENT position (itself always the product
   * of a prior resolvePlacement call, or the initial prop-supplied spot), and
   * reassigned in onPointerMove ONLY when the raw cursor target itself was
   * already legal (see the `legal` check there) — never from a fallback
   * candidate, which is what keeps this a valid resolvePlacement anchor.
   */
  from: { x: number; z: number };
  /**
   * Raw, UNRESOLVED cursor-tracked world-feet position — grab-offset applied,
   * but not run through resolvePlacement. This is what the mesh actually
   * renders at every pointermove (see the comment there for why), and it's
   * also the "proposed" position resolvePlacement is finally given, once, in
   * endDrag, to compute the guaranteed-legal committed spot.
   */
  target: { x: number; z: number };
  /**
   * World-feet delta between the item's centre and the floor-plane point
   * under the pointer AT GRAB TIME, fixed for the whole gesture. Without
   * this, the first pointermove after a click would snap the item's centre
   * straight to wherever the floor-raycast lands (usually not directly under
   * the cursor, since real clicks land on off-centre points of the item's
   * visible faces) — i.e. exactly the "item teleports on grab" bug. Adding it
   * back in on every move keeps the same relative grab point for the whole
   * drag, like picking up a box by one corner rather than its centre.
   */
  offset: { x: number; z: number };
  /** Whether `target` is CURRENTLY illegal — tracked only to avoid re-tinting the mesh every single pointermove when its legality hasn't changed. */
  invalid: boolean;
}

export interface FurnitureEditorCanvasProps {
  /**
   * Room shell only. Any `furniture` field present on this object is
   * ignored — the `furniture` prop below (room-local PlacedFurniture, the
   * same shape Room.furniture uses) is the sole source of truth for
   * placement; this component derives world-feet furniture from it itself
   * via toWorldFurniture wherever build-scene.ts or checkOcclusion need it.
   */
  spec: GreyboxRoomSpec;
  furniture: PlacedFurniture[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (id: string, patch: FurnitureCommitPatch, bounce?: BounceReason) => void;
  onOcclusionChange: (violations: OcclusionViolation[]) => void;
}

/**
 * Fixed-camera furniture editor (greybox opening placement, section 0/6).
 *
 * No orbit, no user camera control, no free-look — the viewport IS the
 * locked `greyboxCamera` export view, so whatever the user arranges here is
 * exactly what FLUX receives. Furniture is dragged/nudged/rotated with every
 * move constrained by `resolvePlacement` (room bounds, the camera's own 2.6ft
 * exclusion disk, and other furniture's footprints), and every commit is
 * checked against `checkOcclusion` so an item blocking a door/window is
 * flagged — amber in the viewport, and reported to the caller — before it
 * ever reaches a save.
 */
export function FurnitureEditorCanvas({
  spec,
  furniture,
  selectedId,
  onSelect,
  onCommit,
  onOcclusionChange,
}: FurnitureEditorCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest-value box so the mount-once effect's pointer/keyboard handlers
  // and render loop always see current props without tearing down the
  // renderer on every furniture edit or callback identity change.
  const stateRef = useRef<FurnitureEditorState>({ spec, furniture, selectedId, onSelect, onCommit, onOcclusionChange });
  useEffect(() => {
    stateRef.current = { spec, furniture, selectedId, onSelect, onCommit, onOcclusionChange };
  });

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  // The locked export camera. Rebuilt only when the room SHAPE changes (see
  // the dedicated effect below) — never on a furniture-only edit, which is
  // the entire guarantee this component exists to provide.
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  // The room's top-level group (build-scene.ts's `group`): every wall/floor/
  // ceiling/reveal panel is a plain Mesh added directly to it, and every
  // furniture proxy is a Group one level below it, tagged with
  // userData.furnitureId by rebuildScene. The camera exclusion-arc ring
  // (below) is deliberately NOT inside this group — see rebuildScene.
  const roomGroupRef = useRef<THREE.Group | null>(null);
  // Ids most recently named as an occlusion blockerId — survives scene
  // rebuilds (a ref, not scene state) so freshly-built furniture meshes
  // still get re-tinted correctly by applyBlockerTint below.
  const blockerIdsRef = useRef<Set<string>>(new Set());

  /**
   * Repaints every furniture group's emissive from scratch. Selection wins
   * over the blocker warning when a piece is both, because the user is
   * actively working on that item and needs to see which one it is; the
   * blocking itself is still reported in the warnings panel, so nothing is
   * lost by yielding the tint for as long as it stays selected.
   *
   * Selection had NO viewport treatment at all before this: `selectedId` was
   * threaded through the component and used only by the keyboard handler, so
   * the sidebar list highlighted the selection but the 3D view gave no
   * indication whatever of which piece the arrow keys were about to move.
   */
  const applyBlockerTint = useCallback(() => {
    const roomGroup = roomGroupRef.current;
    if (!roomGroup) return;
    const blockers = blockerIdsRef.current;
    const { selectedId: sel } = stateRef.current;
    for (const child of roomGroup.children) {
      if (!(child instanceof THREE.Group) || !child.userData.furnitureId) continue;
      const id = child.userData.furnitureId as string;
      const hex = id === sel ? SELECTED_TINT : blockers.has(id) ? BLOCKER_TINT : 0x000000;
      setGroupEmissive(child, hex);
    }
  }, []);

  // Repaint when the selection changes. rebuildScene does not run on a
  // selection-only change (it is keyed on geometry and the furniture list),
  // so without this the tint would only catch up on the next unrelated edit.
  useEffect(() => {
    applyBlockerTint();
  }, [selectedId, applyBlockerTint]);

  const runOcclusionCheck = useCallback(() => {
    const camera = cameraRef.current;
    const roomGroup = roomGroupRef.current;
    if (!camera || !roomGroup) return;
    const { spec: s, furniture: f, onOcclusionChange: report } = stateRef.current;
    // checkOcclusion raycasts against the LIVE scene graph (roomGroup),
    // whose furniture meshes already carry whatever position/rotation this
    // gesture just mutated them to — it never reads spec.furniture itself
    // (only width/depth/openings, for the opening-face samples), so this is
    // accurate even before React's own `furniture` prop has caught up.
    const specWithFurniture: GreyboxRoomSpec = {
      width: s.width,
      depth: s.depth,
      openings: s.openings,
      furniture: toWorldFurniture(f, s.width, s.depth),
    };
    const violations = checkOcclusion(roomGroup, camera, specWithFurniture);
    blockerIdsRef.current = new Set(violations.map((v) => v.blockerId).filter((id): id is string => !!id));
    applyBlockerTint();
    report(violations);
  }, [applyBlockerTint]);

  const rebuildScene = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const { spec: s, furniture: f } = stateRef.current;
    const { width: w, depth: d, openings: op } = s;
    if (w <= 0 || d <= 0) return;

    if (sceneRef.current) disposeObject3D(sceneRef.current);

    const scene = buildGreyboxScene({ width: w, depth: d, openings: op, furniture: toWorldFurniture(f, w, d) });

    const roomGroup = scene.children.find((c): c is THREE.Group => c instanceof THREE.Group) ?? null;
    // toWorldFurniture drops any item whose kind is unknown, in the same
    // filtered order build-scene.ts then loops over to add furniture Groups
    // — so this filtered list's Nth entry is the Nth furniture Group child.
    const knownFurniture = f.filter((item) => !!catalogueEntry(item.kind));
    if (roomGroup) {
      let idx = 0;
      for (const child of roomGroup.children) {
        if (child instanceof THREE.Group) {
          const placed = knownFurniture[idx];
          if (placed) child.userData.furnitureId = placed.id;
          idx++;
        }
      }
    }

    // Camera exclusion-arc: added as a SIBLING of roomGroup (scene.add, not
    // roomGroup.add) — structural isolation, not a filter. Both the pick
    // raycast (intersectObjects on roomGroup.children) and checkOcclusion
    // (called with roomGroupRef.current, never the whole scene — see
    // runOcclusionCheck above) only ever see roomGroup's own descendants, so
    // a helper living one level up is excluded from both by construction,
    // with no exclusion list to keep in sync. Still tagged userData.helper
    // for clarity even though nothing currently filters on it.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0, CAMERA_EXCLUSION_FT, 48),
      new THREE.MeshBasicMaterial({
        color: EXCLUSION_RING_COLOR,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2; // lie flat, matching the floor plane
    ring.position.set(camera.position.x, 0.02, camera.position.z);
    ring.userData.helper = true;
    scene.add(ring);

    sceneRef.current = scene;
    roomGroupRef.current = roomGroup;

    // Also covers the case where furniture/spec changed from OUTSIDE this
    // canvas's own gestures (e.g. a sidebar Add/Delete button) — occlusion
    // state and blocker tinting stay correct regardless of how the change
    // arrived, not just after this component's own drag/keyboard commits.
    runOcclusionCheck();
  }, [runOcclusionCheck]);

  // Mount-once: renderer, pointer + keyboard handlers, render loop. Never
  // re-runs on prop changes — see stateRef above. `runOcclusionCheck` is a
  // stable useCallback ([applyBlockerTint] -> []), so listing it as a
  // dependency satisfies exhaustive-deps without ever causing a re-run.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const rect0 = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, rect0.width), Math.max(1, rect0.height), false);
    rendererRef.current = renderer;

    const raycaster = new THREE.Raycaster();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pointerNDC = new THREE.Vector2();
    let drag: DragState | null = null;

    function ndcFromEvent(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    /** Raycasts against roomGroup only (the exclusion ring is a sibling, never a candidate) and walks up to the ancestor Group carrying a furnitureId tag. */
    function pickFurniture(e: PointerEvent): THREE.Group | null {
      const roomGroup = roomGroupRef.current;
      const camera = cameraRef.current;
      if (!roomGroup || !camera) return null;
      ndcFromEvent(e);
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(roomGroup.children, true);
      for (const hit of hits) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj && !(obj instanceof THREE.Group && obj.userData.furnitureId)) obj = obj.parent;
        if (obj) return obj as THREE.Group;
      }
      return null;
    }

    function raycastFloor(e: PointerEvent): THREE.Vector3 | null {
      const camera = cameraRef.current;
      if (!camera) return null;
      ndcFromEvent(e);
      raycaster.setFromCamera(pointerNDC, camera);
      const hitPoint = new THREE.Vector3();
      return raycaster.ray.intersectPlane(floorPlane, hitPoint) ? hitPoint : null;
    }

    /** The live furniture Group for a given id, found via the userData tag rebuildScene stamps. */
    function findFurnitureGroup(id: string): THREE.Group | null {
      const roomGroup = roomGroupRef.current;
      if (!roomGroup) return null;
      for (const child of roomGroup.children) {
        if (child instanceof THREE.Group && child.userData.furnitureId === id) return child;
      }
      return null;
    }

    // Single-gesture select-and-drag: no separate click-then-drag step (that
    // two-step only ever existed to keep dragging from fighting orbit, which
    // no longer exists). A pointerdown that hits furniture selects it AND
    // immediately starts the drag in the same gesture.
    function onPointerDown(e: PointerEvent) {
      // Explicit focus (not just relying on default click-to-focus) so
      // keyboard nudge/rotate/delete work right after this same click, even
      // on browsers that don't focus non-form elements on pointerdown by
      // default (historically Safari).
      canvas!.focus();
      const hit = pickFurniture(e);
      stateRef.current.onSelect(hit ? (hit.userData.furnitureId as string) : null);
      if (!hit) return;
      // Grab offset (see DragState.offset) — computed from the SAME event
      // that picked the item, so the floor point under this exact click is
      // what gets subtracted out. If the floor raycast somehow misses (e.g. a
      // near-parallel camera ray, not expected with the locked greybox
      // camera but cheap to guard), fall back to a zero offset rather than
      // failing the grab outright.
      const grabFloorPoint = raycastFloor(e);
      const offset = grabFloorPoint
        ? { x: hit.position.x - grabFloorPoint.x, z: hit.position.z - grabFloorPoint.z }
        : { x: 0, z: 0 };
      drag = {
        id: hit.userData.furnitureId as string,
        group: hit,
        from: { x: hit.position.x, z: hit.position.z },
        target: { x: hit.position.x, z: hit.position.z },
        offset,
        invalid: false,
      };
      canvas!.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!drag) return;
      const p = raycastFloor(e);
      if (!p) return;
      const { spec: s, furniture: f } = stateRef.current;
      const item = f.find((x) => x.id === drag!.id);
      const camera = cameraRef.current;
      if (!item || !camera) return;

      // Cursor-tracked target (grab-offset applied) — this is what the mesh
      // renders at, every frame, full stop. This replaces the OLD behaviour
      // of rendering resolvePlacement's RESOLVED position on every
      // pointermove, which is what actually caused the reported "glitchy"
      // drag: near any wall/overlap/camera-exclusion boundary, resolvePlacement
      // tries the full move, then an x-only slide, then a z-only slide, then
      // holds — and tiny cursor deltas near a boundary can flip which of
      // those four candidates passes from one pointermove to the next. Since
      // the OLD code fed that flapping result straight into the mesh's
      // position, the item visibly fought the cursor (jitter/snap-back)
      // instead of sliding smoothly. Rendering the raw target here instead
      // makes the drag itself perfectly smooth; legality becomes a visual
      // hint only (the tint below), and gets enforced for real exactly once,
      // on release, in endDrag — where a single corrective snap (if the
      // cursor was released over an illegal spot) reads as "it stopped me,"
      // not as jitter.
      const target = clampToRoom(item.kind, item.rotation, p.x + drag.offset.x, p.z + drag.offset.z, s);
      drag.target = target;

      const others = toWorldFurniture(f.filter((x) => x.id !== drag!.id), s.width, s.depth);
      const resolved = resolvePlacement(
        { kind: item.kind, rotation: item.rotation, x: target.x, z: target.z, fromX: drag.from.x, fromZ: drag.from.z },
        others,
        { width: s.width, depth: s.depth },
        { x: camera.position.x, z: camera.position.z },
      );
      // resolvePlacement's first branch returns `input.x`/`input.z` back
      // completely unchanged (the same numbers, not just equal in value) the
      // instant the raw proposal is legal — see its implementation — so an
      // exact `===` compare is a safe, cheap way to ask "was `target` itself
      // legal?" without re-implementing its bounds/overlap/exclusion checks
      // here.
      const legal = resolved.x === target.x && resolved.z === target.z;
      if (legal) drag.from = target; // advance the fallback anchor only across legal ground — see DragState.from's precondition note

      const nowInvalid = !legal;
      if (nowInvalid !== drag.invalid) {
        drag.invalid = nowInvalid;
        setGroupEmissive(drag.group, nowInvalid ? DRAG_INVALID_TINT : 0x000000);
      }

      // Mutate the live Group during the gesture; React state (and hence a
      // full scene rebuild) only commits once, on release below — one
      // rebuild per drag, not one per pointermove frame.
      drag.group.position.set(target.x, 0, target.z);
    }

    function endDrag(e: PointerEvent) {
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (canvas!.hasPointerCapture(e.pointerId)) canvas!.releasePointerCapture(e.pointerId);
      const { spec: s, furniture: f, onCommit: commit } = stateRef.current;

      // The one and only resolvePlacement call that actually decides where
      // the item ends up: resolve the last cursor target against `from`
      // (which onPointerMove only ever advances across legal ground, so it
      // always satisfies resolvePlacement's fromX/fromZ precondition) to land
      // on a guaranteed-legal final spot, even if the pointer was released
      // mid-violation.
      const item = f.find((x) => x.id === finished.id);
      const camera = cameraRef.current;
      let finalPos = finished.from;
      // Set only when finalPos ends up somewhere other than where the user
      // actually released the pointer — i.e. resolvePlacement's fallback
      // ladder had to intervene. `explainPlacementBounce` re-derives WHY from
      // the same raw target, without changing what resolvePlacement itself
      // returned above (see that function's own doc comment on why this is a
      // separate call rather than resolvePlacement growing a reason code).
      let bounce: BounceReason | null = null;
      if (item && camera) {
        const cameraPos = { x: camera.position.x, z: camera.position.z };
        finalPos = resolvePlacement(
          {
            kind: item.kind,
            rotation: item.rotation,
            x: finished.target.x,
            z: finished.target.z,
            fromX: finished.from.x,
            fromZ: finished.from.z,
          },
          toWorldFurniture(f.filter((x) => x.id !== finished.id), s.width, s.depth),
          { width: s.width, depth: s.depth },
          cameraPos,
        );
        if (finalPos.x !== finished.target.x || finalPos.z !== finished.target.z) {
          bounce = explainPlacementBounce(
            {
              kind: item.kind,
              rotation: item.rotation,
              x: finished.target.x,
              z: finished.target.z,
              fromX: finished.from.x,
              fromZ: finished.from.z,
            },
            othersWithId(f, finished.id, s.width, s.depth),
            { width: s.width, depth: s.depth },
            cameraPos,
          );
        }
      }
      finished.group.position.set(finalPos.x, 0, finalPos.z);
      // Clear the transient drag-invalid tint unconditionally — runOcclusionCheck
      // below (via applyBlockerTint) is about to repaint every item's tint
      // from scratch based on the fresh occlusion pass, so this only matters
      // for the instant before that pass lands.
      if (finished.invalid) setGroupEmissive(finished.group, 0x000000);

      commit(finished.id, worldToLocal(finalPos.x, finalPos.z, s.width, s.depth), bounce ?? undefined);
      runOcclusionCheck();
    }

    function onKeyDown(e: KeyboardEvent) {
      const handledKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "[", "]", "Delete", "Backspace"];
      if (!handledKeys.includes(e.key)) return;
      // Prevent default for every handled key regardless of whether an item
      // is currently selected, so arrow keys never scroll the page while
      // this canvas has focus.
      e.preventDefault();

      const { spec: s, furniture: f, selectedId: sel, onCommit: commit } = stateRef.current;
      if (!sel) return;
      const item = f.find((x) => x.id === sel);
      const camera = cameraRef.current;
      if (!item || !camera) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        const group = findFurnitureGroup(sel);
        if (group && roomGroupRef.current) {
          roomGroupRef.current.remove(group);
          disposeObject3D(group);
        }
        commit(sel, null);
        runOcclusionCheck();
        return;
      }

      const others = toWorldFurniture(f.filter((x) => x.id !== sel), s.width, s.depth);
      const world = toWorldFurniture([item], s.width, s.depth)[0];
      if (!world) return; // unknown/stale kind — toWorldFurniture drops it, nothing to move
      const cameraPos = { x: camera.position.x, z: camera.position.z };

      if (e.key === "[" || e.key === "]") {
        const rotation = item.rotation + (e.key === "[" ? -ROTATE_STEP_RAD : ROTATE_STEP_RAD);
        // Re-run resolvePlacement at the CURRENT position (fromX/fromZ ===
        // x/z proposed) — a rotation alone can create an overlap the
        // position by itself did not have, and this is what catches it.
        //
        // No bounce reason is derived here: input.x/z === fromX/fromZ, so
        // every one of resolvePlacement's four candidates evaluates the exact
        // same point, and the position it returns is therefore always
        // (world.x, world.z) whether or not the new rotation is actually
        // legal there. There is never a "the position moved" case to explain
        // for a pure in-place rotation.
        const { x, z } = resolvePlacement(
          { kind: item.kind, rotation, x: world.x, z: world.z, fromX: world.x, fromZ: world.z },
          others,
          { width: s.width, depth: s.depth },
          cameraPos,
        );
        const group = findFurnitureGroup(sel);
        if (group) {
          group.position.set(x, 0, z);
          group.rotation.y = rotation;
        }
        const local = worldToLocal(x, z, s.width, s.depth);
        commit(sel, { x: local.x, z: local.z, rotation });
        runOcclusionCheck();
        return;
      }

      let dx = 0;
      let dz = 0;
      if (e.key === "ArrowLeft") dx = -NUDGE_STEP_FT;
      if (e.key === "ArrowRight") dx = NUDGE_STEP_FT;
      if (e.key === "ArrowUp") dz = -NUDGE_STEP_FT;
      if (e.key === "ArrowDown") dz = NUDGE_STEP_FT;
      const targetX = world.x + dx;
      const targetZ = world.z + dz;
      const { x, z } = resolvePlacement(
        { kind: item.kind, rotation: item.rotation, x: targetX, z: targetZ, fromX: world.x, fromZ: world.z },
        others,
        { width: s.width, depth: s.depth },
        cameraPos,
      );
      let bounce: BounceReason | null = null;
      if (x !== targetX || z !== targetZ) {
        bounce = explainPlacementBounce(
          { kind: item.kind, rotation: item.rotation, x: targetX, z: targetZ, fromX: world.x, fromZ: world.z },
          othersWithId(f, sel, s.width, s.depth),
          { width: s.width, depth: s.depth },
          cameraPos,
        );
      }
      const group = findFurnitureGroup(sel);
      if (group) group.position.set(x, 0, z);
      commit(sel, worldToLocal(x, z, s.width, s.depth), bounce ?? undefined);
      runOcclusionCheck();
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("keydown", onKeyDown);

    // Observes the CANVAS itself (not the wrapper): its CSS aspect-ratio
    // (set in the JSX below, from GREYBOX_ASPECT) already constrains its
    // rendered box to letterbox/pillarbox inside whatever the wrapper gives
    // it, so reading the canvas's own rect and feeding it straight into
    // renderer.setSize keeps the drawing buffer's aspect matching the locked
    // camera's aspect at every size — never the wrapper's raw shape.
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      renderer.setSize(r.width, r.height, false);
    });
    ro.observe(canvas);

    let raf = 0;
    function loop() {
      const cam = cameraRef.current;
      if (sceneRef.current && cam) renderer.render(sceneRef.current, cam);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("keydown", onKeyDown);
      if (sceneRef.current) disposeObject3D(sceneRef.current);
      sceneRef.current = null;
      roomGroupRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      cameraRef.current = null;
    };
  }, [runOcclusionCheck]);

  // Rebuild the locked camera only when the room SHAPE or the user's chosen
  // viewpoint changes — never on a furniture-only edit (that guarantee is the
  // entire point of this task). greyboxCamera is deterministic: the same
  // width/depth/openings/view always yields the same camera, so a regenerated
  // image never silently changes framing. Declared before the scene-rebuild
  // effect below so, on every render where both fire, cameraRef.current is
  // already current by the time rebuildScene reads it (effects for one
  // component fire in declaration order).
  //
  // cameraView MUST be forwarded here, not dropped. This preview and the
  // greybox that actually conditions generation have to agree on the
  // viewpoint; rebuilding from width/depth/openings alone would leave the
  // editor showing one angle while the render used another.
  useEffect(() => {
    cameraRef.current = greyboxCamera(
      { width: spec.width, depth: spec.depth, openings: spec.openings, cameraView: spec.cameraView },
      GREYBOX_ASPECT,
    );
  }, [spec.width, spec.depth, spec.openings, spec.cameraView]);

  // Rebuilds the scene geometry whenever the room shell or furniture list
  // changes — runs after the two effects above on the very first render
  // too, so this is also what performs the initial build.
  useEffect(() => {
    rebuildScene();
  }, [spec.width, spec.depth, spec.openings, spec.cameraView, furniture, rebuildScene]);

  return (
    <div ref={wrapRef} className="flex h-full w-full items-center justify-center overflow-hidden">
      {/*
        Locked to GREYBOX_ASPECT via CSS aspect-ratio, never the wrapper's
        own shape — the reference image FLUX receives is rendered at exactly
        this aspect (dimensions.ts), so the viewport must match it letter-
        for-letter or the editor shows a different framing than the model
        gets. max-h-full/max-w-full let the wrapper letterbox/pillarbox
        around this box; the canvas itself never stretches to fill it.
      */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        // h-full/w-full is load-bearing, not decorative: a bare <canvas> with
        // no explicit sizing falls back to the HTML spec's default replaced-
        // element intrinsic size (300x150 CSS px) — max-h-full/max-w-full
        // only CAP that, they don't grow it, and aspect-ratio alone doesn't
        // stretch a replaced element either. The result was a tiny fixed-size
        // canvas centred (by the wrapper's items-center/justify-center) inside
        // a much bigger dark box, with the parent's aspect-locked sizing (see
        // furnish/[roomId]/page.tsx's wrapping div) doing nothing for the
        // canvas itself (reported bug). The parent box already has this exact
        // aspect ratio via inline style, so filling it with h-full/w-full is
        // always correct here, not just a fallback — max-h-full/max-w-full
        // stay as a defensive cap in case that ever stops being true.
        className="h-full w-full max-h-full min-h-0 max-w-full min-w-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        style={{ aspectRatio: GREYBOX_ASPECT }}
      />
    </div>
  );
}
