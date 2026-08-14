"use client";

import * as THREE from "three";
import { buildGreyboxScene, type GreyboxClass } from "./build-scene";
import { greyboxCamera, projectOpenings, type ProjectedOpening } from "./camera";
import {
  GREYBOX_ASPECT,
  GREYBOX_RENDER_H,
  GREYBOX_RENDER_W,
  assertHistogram,
  disposeScene,
  renderToContext,
} from "./render-to-data-uri";
import { annotateFurniture, type FurnitureBadge } from "./render-annotated";
import type { GreyboxRoomSpec } from "./types";

// projectOpenings/ProjectedOpening live in ./camera (no "use client") rather
// than here: camera.ts already imports openingCentre and already performs
// the identical in-front dot-product test in its candidate scorer, and Task
// 13's server-side code needs projection math without pulling in this
// module's WebGL client boundary. Re-exported so Task 6's
// `import { ProjectedOpening } from "./render-mask"` keeps working.
export { projectOpenings };
export type { ProjectedOpening };

/** Flat colours for the label pass. Values are arbitrary but must be distinct and unlit. */
const CLASS_COLOR: Record<GreyboxClass, number> = {
  wall: 0x101010,
  floor: 0x202020,
  ceiling: 0x303030,
  door: 0x404040,
  window: 0x505050,
  reveal: 0x606060,
  furniture: 0x707070,
};

function swapToFlat(scene: THREE.Scene, colorFor: (cls: GreyboxClass | undefined) => number | null) {
  const created: THREE.Material[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const color = colorFor(obj.userData.greyboxClass as GreyboxClass | undefined);
    if (color === null) {
      obj.visible = false;
      return;
    }
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    created.push(mat);
    obj.userData.originalMaterial = obj.material;
    obj.material = mat;
  });
  return created;
}

/**
 * Section 7.1's Pass B mask: same camera, same resolution, same frame,
 * openings pure white, everything else pure black, furniture hidden.
 *
 * Deliberately NOT colour-coded by opening type. A white component's type
 * comes from projectOpenings below — matching each known opening's projected
 * centre to the component containing it — so section 7.1 is followed to the
 * letter while section 4.2 still gets separate door and window counts.
 *
 * Never sent to FLUX. Stored beside the conditioning render for the ledger
 * and for debug overlays.
 */
function buildMaskScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = buildGreyboxScene(spec);
  scene.background = new THREE.Color(0x000000);
  scene.traverse((o) => {
    if (o instanceof THREE.Light) o.visible = false;
  });
  swapToFlat(scene, (cls) => {
    if (cls === "furniture") return null; // hidden — an occluded opening must not appear
    if (cls === "door" || cls === "window") return 0xffffff;
    return 0x000000;
  });
  return scene;
}

function buildLabelScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = buildGreyboxScene(spec);
  scene.background = new THREE.Color(0x000000);
  scene.traverse((o) => {
    if (o instanceof THREE.Light) o.visible = false;
  });
  swapToFlat(scene, (cls) => (cls ? CLASS_COLOR[cls] : 0x000000));
  return scene;
}

function classPixelIndex(labelCtx: CanvasRenderingContext2D): Map<GreyboxClass, number[]> {
  const img = labelCtx.getImageData(0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H);
  const byValue = new Map<number, GreyboxClass>();
  for (const [cls, color] of Object.entries(CLASS_COLOR) as [GreyboxClass, number][]) {
    byValue.set(color & 0xff, cls);
  }
  const out = new Map<GreyboxClass, number[]>();
  for (let i = 0; i < img.data.length; i += 4) {
    const cls = byValue.get(img.data[i]);
    if (!cls) continue;
    const list = out.get(cls);
    if (list) list.push(i / 4);
    else out.set(cls, [i / 4]);
  }
  return out;
}

/**
 * Pixel position for each furniture piece's numbered badge in the annotated
 * reference image, projected through the same locked camera as the
 * conditioning render, the mask and the opening ledger. Deliberately a
 * separate function from `furniture-descriptors.ts`'s `describeFurniture`
 * rather than a shared helper: that module returns a text PHRASE for the
 * FLUX prompt line (out of this task's scope — do not touch), this one
 * returns a PIXEL for a canvas draw call, and decoupling them means a change
 * meant for one image can never silently move the other's numbers. The two
 * still agree on the underlying geometry test (same eye height 1.5ft, same
 * mandatory in-front dot-product check camera.ts's `projectOpenings` and
 * `score` both already perform) because both are projecting the identical
 * furniture centres through the identical camera — there is only one correct
 * answer for "is this point on screen", not two implementations that happen
 * to match.
 *
 * 1-based numbering (`label = index + 1`) over `spec.furniture`'s own order —
 * the same order `toWorldFurniture` preserves from `Room.furniture` (it only
 * ever drops unknown-kind entries, never reorders) — so the prompt's per-box
 * text and this image's painted numerals name the same piece. A piece behind
 * the camera or outside the frame is skipped entirely, matching
 * `describeFurniture`'s own "not in frame -> not described" rule: a badge on
 * a piece the model cannot otherwise see would point at nothing.
 */
function projectFurniture(spec: GreyboxRoomSpec, camera: THREE.PerspectiveCamera): FurnitureBadge[] {
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const badges: FurnitureBadge[] = [];
  (spec.furniture ?? []).forEach((f, index) => {
    // Same low judging height furniture-descriptors.ts uses: these are
    // floor-seated proxies, not eye-height subjects.
    const point = new THREE.Vector3(f.x, 1.5, f.z);
    const inFront = point.clone().sub(camera.position).dot(forward) > 0;
    const p = point.clone().project(camera);
    if (!inFront || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return;
    badges.push({
      label: index + 1,
      px: Math.round(((p.x + 1) / 2) * GREYBOX_RENDER_W),
      py: Math.round(((1 - p.y) / 2) * GREYBOX_RENDER_H),
    });
  });
  return badges;
}

/**
 * Everything a save needs, from one set of renders through one camera: the
 * conditioning PNG, the Pass B mask PNG, the Gemini-only annotated PNG (when
 * there's furniture to badge), and each opening's projected pixel. The first
 * three MUST share a camera instance — a ledger, or a badge, derived from a
 * different viewpoint than the reference image is worse than no ledger/badge
 * at all.
 *
 * `annotatedDataUri` is `undefined`, not an unmodified copy of `dataUri`,
 * whenever there is nothing to badge — either the room has no furniture, or
 * every piece it has falls outside this camera's frame. Drawing and
 * returning an identical-looking second copy of the conditioning image would
 * cost a real canvas pass plus (via `ensureGreybox`) a wasted upload and a
 * stored object nothing ever points at usefully; `undefined` lets callers
 * skip both and simply omit the second reference image from the Gemini call.
 */
export async function renderGreyboxBundle(spec: GreyboxRoomSpec): Promise<{
  dataUri: string;
  maskDataUri: string;
  annotatedDataUri?: string;
  projected: ProjectedOpening[];
}> {
  const camera = greyboxCamera(spec, GREYBOX_ASPECT);

  // Declared here, not as `const` inside the try below, so `finally` can
  // dispose whatever actually got built no matter how far the block got.
  // assertHistogram throwing is its PURPOSE, not a rare edge case — it exists
  // to fail loudly the moment the value ladder collapses (Task 4's dev-check
  // fixtures prove it throws on cue) — so every scene built before that
  // point must still be disposed on that path, or every caught throw here
  // leaks a scene's geometries and materials.
  let real: THREE.Scene | undefined;
  let label: THREE.Scene | undefined;
  let mask: THREE.Scene | undefined;

  try {
    real = buildGreyboxScene(spec);
    const realCtx = renderToContext(real, camera, { supersample: true, antialias: true });

    // Label pass: no supersample, no antialias — flat class colours must stay
    // exact so a blended edge pixel is never misread as a different class.
    label = buildLabelScene(spec);
    const labelCtx = renderToContext(label, camera, { supersample: false, antialias: false });

    assertHistogram(realCtx.getImageData(0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H), classPixelIndex(labelCtx));

    mask = buildMaskScene(spec);
    const maskCtx = renderToContext(mask, camera, { supersample: false, antialias: false });

    const dataUri = realCtx.canvas.toDataURL("image/png");
    const badges = projectFurniture(spec, camera);
    // See this function's own doc comment: no badges means no annotated
    // image at all, not a wasted redraw-and-upload of an identical copy.
    const annotatedDataUri =
      badges.length > 0 ? await annotateFurniture(dataUri, badges, GREYBOX_RENDER_W, GREYBOX_RENDER_H) : undefined;

    return {
      dataUri,
      maskDataUri: maskCtx.canvas.toDataURL("image/png"),
      annotatedDataUri,
      projected: projectOpenings(spec, camera),
    };
  } finally {
    // Each guard covers a scene that may never have been reached (e.g. `mask`
    // when assertHistogram threw first) — disposing only what exists avoids
    // a second, masking error on top of whatever this block already threw.
    if (real) disposeScene(real);
    if (label) disposeScene(label);
    if (mask) disposeScene(mask);
  }
}
