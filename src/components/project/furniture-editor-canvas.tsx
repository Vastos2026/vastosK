"use client";

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { buildGreyboxScene } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import { catalogueEntry } from "@/lib/greybox/furniture-catalogue";
import { toWorldFurniture, worldToLocal } from "@/lib/greybox/furniture-layout";
import { GREYBOX_ASPECT } from "@/lib/greybox/dimensions";
import { checkOcclusion, resolvePlacement, type OcclusionViolation } from "@/lib/greybox/validate-furniture";
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
/** Exclusion-arc ring colour — deliberately distinct from BLOCKER_TINT so "you can't stand here" (a fixed zone) never reads as "this is blocking an opening" (a furniture-specific warning). */
const EXCLUSION_RING_COLOR = 0xff5252;

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
 * What the canvas reports on every commit (drag release, arrow-key nudge,
 * `[`/`]` rotate): a partial room-local update — {x,z} for a move, {rotation}
 * (plus {x,z} when resolvePlacement had to nudge the item to dodge a new
 * overlap the rotation created) for a turn — or `null`, which the page
 * interprets as "remove this item" (Delete/Backspace).
 */
export type FurnitureCommitPatch = Partial<Pick<PlacedFurniture, "x" | "z" | "rotation">> | null;

interface FurnitureEditorState {
  spec: GreyboxRoomSpec;
  furniture: PlacedFurniture[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (id: string, patch: FurnitureCommitPatch) => void;
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
   * of a prior resolvePlacement call, or the initial prop-supplied spot),
   * and reassigned after every resolved move below.
   */
  from: { x: number; z: number };
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
  onCommit: (id: string, patch: FurnitureCommitPatch) => void;
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

  const applyBlockerTint = useCallback(() => {
    const roomGroup = roomGroupRef.current;
    if (!roomGroup) return;
    const blockers = blockerIdsRef.current;
    for (const child of roomGroup.children) {
      if (!(child instanceof THREE.Group) || !child.userData.furnitureId) continue;
      const tint = blockers.has(child.userData.furnitureId as string);
      child.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.material instanceof THREE.MeshStandardMaterial) {
          obj.material.emissive.setHex(tint ? BLOCKER_TINT : 0x000000);
        }
      });
    }
  }, []);

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
      drag = { id: hit.userData.furnitureId as string, group: hit, from: { x: hit.position.x, z: hit.position.z } };
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
      const others = toWorldFurniture(f.filter((x) => x.id !== drag!.id), s.width, s.depth);
      const { x, z } = resolvePlacement(
        { kind: item.kind, rotation: item.rotation, x: p.x, z: p.z, fromX: drag.from.x, fromZ: drag.from.z },
        others,
        { width: s.width, depth: s.depth },
        { x: camera.position.x, z: camera.position.z },
      );
      // Mutate the live Group during the gesture; React state (and hence a
      // full scene rebuild) only commits once, on release below — one
      // rebuild per drag, not one per pointermove frame.
      drag.group.position.set(x, 0, z);
      drag.from = { x, z };
    }

    function endDrag(e: PointerEvent) {
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (canvas!.hasPointerCapture(e.pointerId)) canvas!.releasePointerCapture(e.pointerId);
      const { spec: s, onCommit: commit } = stateRef.current;
      commit(finished.id, worldToLocal(finished.from.x, finished.from.z, s.width, s.depth));
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
      const { x, z } = resolvePlacement(
        { kind: item.kind, rotation: item.rotation, x: world.x + dx, z: world.z + dz, fromX: world.x, fromZ: world.z },
        others,
        { width: s.width, depth: s.depth },
        cameraPos,
      );
      const group = findFurnitureGroup(sel);
      if (group) group.position.set(x, 0, z);
      commit(sel, worldToLocal(x, z, s.width, s.depth));
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

  // Rebuild the locked camera only when the room SHAPE changes — never on a
  // furniture-only edit (that guarantee is the entire point of this task).
  // greyboxCamera is deterministic: the same width/depth/openings always
  // yields the same viewpoint, so a regenerated image never silently
  // changes framing. Declared before the scene-rebuild effect below so, on
  // every render where both fire, cameraRef.current is already current by
  // the time rebuildScene reads it (effects for one component fire in
  // declaration order).
  useEffect(() => {
    cameraRef.current = greyboxCamera({ width: spec.width, depth: spec.depth, openings: spec.openings }, GREYBOX_ASPECT);
  }, [spec.width, spec.depth, spec.openings]);

  // Rebuilds the scene geometry whenever the room shell or furniture list
  // changes — runs after the two effects above on the very first render
  // too, so this is also what performs the initial build.
  useEffect(() => {
    rebuildScene();
  }, [spec.width, spec.depth, spec.openings, furniture, rebuildScene]);

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
        className="max-h-full min-h-0 max-w-full min-w-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        style={{ aspectRatio: GREYBOX_ASPECT }}
      />
    </div>
  );
}
