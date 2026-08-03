"use client";

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildGreyboxScene, CEILING_H } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import { catalogueEntry } from "@/lib/greybox/furniture-catalogue";
import { toWorldFurniture, worldToLocal } from "@/lib/greybox/furniture-layout";
import { GREYBOX_ASPECT } from "@/lib/greybox/dimensions";
import type { GreyboxOpening } from "@/lib/greybox/types";
import type { PlacedFurniture } from "@/lib/types";

/**
 * Aspect used only to draw the framing indicator. Was a hand-copied literal
 * (`1376 / 768`) that would have silently gone stale the moment Task 13's
 * documented one-line fallback (GREYBOX_RENDER_W/H -> 1280x704) ever landed —
 * importing the derived constant instead makes dimensions.ts genuinely the
 * only place these numbers are decided.
 */
const FRAME_ASPECT = GREYBOX_ASPECT;
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
/** Pointer movement (px) below which a pointerdown/pointerup pair counts as a click, not an orbit drag. */
const CLICK_SLOP_PX = 4;

/**
 * Disposes every geometry/material found under `root` — a superset of
 * greybox-preview.tsx's Mesh-only traversal, since this scene also carries a
 * THREE.CameraHelper (a LineSegments, not a Mesh) for the framing indicator.
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

interface FurnitureEditorState {
  width: number;
  depth: number;
  openings: GreyboxOpening[];
  furniture: PlacedFurniture[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFurnitureChange: (furniture: PlacedFurniture[]) => void;
}

/**
 * Interactive, orbit-controlled greybox editor for placing furniture — a
 * SEPARATE, freely-movable camera from the locked `greyboxCamera` export
 * view (camera.ts). To keep the user oriented, a wireframe CameraHelper for
 * the actual export camera is always drawn in the scene, regardless of
 * where the free-look camera has been orbited to.
 */
export function FurnitureEditorCanvas({
  width,
  depth,
  openings,
  furniture,
  selectedId,
  onSelect,
  onFurnitureChange,
}: {
  width: number;
  depth: number;
  openings: GreyboxOpening[];
  furniture: PlacedFurniture[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFurnitureChange: (furniture: PlacedFurniture[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest-value box so the mount-once effect's pointer handlers and render
  // loop always see current props without tearing down the renderer/orbit
  // camera on every furniture edit or callback identity change.
  const stateRef = useRef<FurnitureEditorState>({
    width,
    depth,
    openings,
    furniture,
    selectedId,
    onSelect,
    onFurnitureChange,
  });
  useEffect(() => {
    stateRef.current = { width, depth, openings, furniture, selectedId, onSelect, onFurnitureChange };
  });

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  // The room's top-level group (build-scene.ts's `group`) — its Group-typed
  // children are the furniture items (every other child, wall/floor/ceiling
  // panels and corner posts, is a plain Mesh added directly), which is how
  // raycasting finds "which placed item" without build-scene.ts itself
  // tagging anything (it's a read-only reference for this task).
  const roomGroupRef = useRef<THREE.Group | null>(null);
  const hasInitCameraRef = useRef(false);

  const rebuildScene = useCallback(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!renderer || !camera) return;

    const { width: w, depth: d, openings: op, furniture: f } = stateRef.current;
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

    // Framing indicator: a wireframe frustum of the LOCKED export camera, so
    // the user always sees where the actual exported image is framed from —
    // this is a hard requirement, not a nicety, since nothing else in this
    // free-look view tells them that.
    const frameCamera = greyboxCamera({ width: w, depth: d, openings: op }, FRAME_ASPECT);
    scene.add(new THREE.CameraHelper(frameCamera));

    sceneRef.current = scene;
    roomGroupRef.current = roomGroup;

    // First build only: start the free orbit camera pulled back and above
    // the room, looking down at an angle so the whole footprint is visible
    // at once. Deliberately NOT copying frameCamera's position — that camera
    // is the LOCKED export view, jammed only INSET (4% of the room's
    // width/depth) off a wall/corner (camera.ts), tuned for its own wide 85°
    // FOV to frame tight rooms from close range. This editor's camera uses a
    // much narrower 60° FOV, so reusing that tight position would produce an
    // extreme, distorted close-up of whatever wall/opening panel happens to
    // be nearby. 0.9x width/depth puts the eye outside the room shell on
    // both axes (comfortably past any wall), and 1.3x ceiling height lifts
    // it well above the ceiling line for a natural three-quarters "look at
    // the whole room" angle — picked by eye for a typical 10-16ft room to
    // frame reasonably in a 60° lens, not derived from the export camera's
    // own framing math.
    if (!hasInitCameraRef.current) {
      camera.position.set(w * 0.9, CEILING_H * 1.3, d * 0.9);
      controls?.target.set(0, CEILING_H * 0.4, 0);
      controls?.update();
      hasInitCameraRef.current = true;
    }
  }, []);

  // Mount-once setup: renderer, free orbit camera + controls, pointer
  // handlers, resize observer, render loop. Never re-runs on prop changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const rect0 = wrap.getBoundingClientRect();
    const w0 = Math.max(1, rect0.width);
    const h0 = Math.max(1, rect0.height);
    renderer.setSize(w0, h0, false);

    const camera = new THREE.PerspectiveCamera(60, w0 / h0, 0.1, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, CEILING_H * 0.4, 0);
    // Damping needs a per-frame update() to settle — the render loop below
    // already calls update() every frame regardless, so damping is safe and
    // gives smoother orbiting than a snap-to-stop.
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.update();

    rendererRef.current = renderer;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const raycaster = new THREE.Raycaster();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pointerNDC = new THREE.Vector2();
    let dragging = false;
    let dragId: string | null = null;
    let dragLocal: { x: number; z: number } | null = null;
    let downClient = { x: 0, y: 0 };

    /** The live furniture Group for a given id, found via the userData tag rebuildScene stamps. */
    function findFurnitureGroup(id: string): THREE.Group | null {
      const group = roomGroupRef.current;
      if (!group) return null;
      for (const child of group.children) {
        if (child instanceof THREE.Group && child.userData.furnitureId === id) return child;
      }
      return null;
    }

    function ndcFromEvent(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    /** Walks up from the nearest hit mesh to whichever ancestor Group carries a furnitureId tag. */
    function furnitureIdAt(e: PointerEvent): string | null {
      const group = roomGroupRef.current;
      if (!group) return null;
      ndcFromEvent(e);
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(group.children, true);
      for (const hit of hits) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData.furnitureId) return obj.userData.furnitureId as string;
          obj = obj.parent;
        }
      }
      return null;
    }

    function onPointerDown(e: PointerEvent) {
      downClient = { x: e.clientX, y: e.clientY };
      const hitId = furnitureIdAt(e);
      if (hitId && hitId === stateRef.current.selectedId) {
        // Dragging the already-selected item: take the pointer away from
        // OrbitControls so the two gestures never fight over the same drag.
        dragging = true;
        dragId = hitId;
        controls.enabled = false;
        canvas!.setPointerCapture(e.pointerId);
      }
      // Otherwise leave controls.enabled as-is — a normal orbit drag.
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || !dragId) return;
      ndcFromEvent(e);
      raycaster.setFromCamera(pointerNDC, camera);
      const hitPoint = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(floorPlane, hitPoint)) return;
      const { width: w, depth: d, furniture: f } = stateRef.current;
      const local = worldToLocal(hitPoint.x, hitPoint.z, w, d);
      const draggedKind = f.find((item) => item.id === dragId)?.kind ?? "";
      const { mx, mz } = footprintClampMargins(draggedKind, w, d);
      const nx = Math.min(1 - mx, Math.max(mx, local.x));
      const nz = Math.min(1 - mz, Math.max(mz, local.z));
      dragLocal = { x: nx, z: nz };
      // Mutate the live 3D object directly instead of calling onFurnitureChange
      // here — committing to React state on every pointermove would re-run the
      // scene-rebuild effect (dispose+reconstruct every wall panel, the floor,
      // ceiling and all furniture) on every mouse-move frame, visibly janky.
      // The object moves smoothly at render-loop speed; React only finds out
      // once, on release (below).
      const liveGroup = findFurnitureGroup(dragId);
      if (liveGroup) {
        const worldX = (nx - 0.5) * w;
        const worldZ = (nz - 0.5) * d;
        liveGroup.position.set(worldX, 0, worldZ);
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (dragging) {
        dragging = false;
        controls.enabled = true;
        if (canvas!.hasPointerCapture(e.pointerId)) canvas!.releasePointerCapture(e.pointerId);
        // Commit the final position to React state now — ONE rebuild for the
        // whole drag gesture, not one per frame.
        if (dragId && dragLocal) {
          const { furniture: f, onFurnitureChange: onChange } = stateRef.current;
          const finalLocal = dragLocal;
          const finalId = dragId;
          onChange(f.map((item) => (item.id === finalId ? { ...item, x: finalLocal.x, z: finalLocal.z } : item)));
        }
        dragId = null;
        dragLocal = null;
        return;
      }
      const dx = e.clientX - downClient.x;
      const dy = e.clientY - downClient.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP_PX) return; // was an orbit drag, not a click
      const hitId = furnitureIdAt(e);
      stateRef.current.onSelect(hitId);
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    });
    ro.observe(wrap);

    let raf = 0;
    function loop() {
      controls.update();
      if (sceneRef.current) renderer.render(sceneRef.current, camera);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      if (sceneRef.current) disposeObject3D(sceneRef.current);
      sceneRef.current = null;
      roomGroupRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      hasInitCameraRef.current = false;
    };
  }, []);

  // Rebuilds the scene geometry whenever the room shell or furniture list
  // changes — runs after the mount effect above on the very first render
  // too (effects for one component fire in declaration order), so this is
  // also what performs the initial build.
  useEffect(() => {
    rebuildScene();
  }, [width, depth, openings, furniture, rebuildScene]);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full touch-none" />
    </div>
  );
}
