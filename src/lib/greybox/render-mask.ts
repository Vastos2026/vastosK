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
 * Everything a save needs, from one set of renders through one camera: the
 * conditioning PNG, the Pass B mask PNG, and each opening's projected pixel.
 * They MUST share a camera instance — a ledger derived from a different
 * viewpoint than the reference image is worse than no ledger at all.
 */
export function renderGreyboxBundle(spec: GreyboxRoomSpec): {
  dataUri: string;
  maskDataUri: string;
  projected: ProjectedOpening[];
} {
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

    return {
      dataUri: realCtx.canvas.toDataURL("image/png"),
      maskDataUri: maskCtx.canvas.toDataURL("image/png"),
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
