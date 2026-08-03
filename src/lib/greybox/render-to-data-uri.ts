"use client";

import * as THREE from "three";
import { buildGreyboxScene } from "./build-scene";
import { greyboxCamera } from "./camera";
import { GREYBOX_ASPECT, GREYBOX_RENDER_H, GREYBOX_RENDER_W } from "./dimensions";
import type { GreyboxRoomSpec } from "./types";

// Pure pixel statistics live in ./histogram, which carries no "use client"
// directive — this module is client-only (WebGL), and the server-side
// dev-check route needs to import assertHistogram without pulling that
// boundary in. Re-exported so existing/downstream import paths (Task 5 reads
// assertHistogram from here) keep working unchanged.
export { assertHistogram, GreyboxHistogramError } from "./histogram";

// The three render-dimension constants now live in ./dimensions (no "use
// client"), so camera.ts's projectOpenings and other server-side code (the
// section 7.1 mask/label passes, runware-client.ts) can import them without
// pulling in this module's WebGL client boundary. Re-exported here so every
// existing `from "./render-to-data-uri"` import keeps working unchanged.
export { GREYBOX_ASPECT, GREYBOX_RENDER_H, GREYBOX_RENDER_W } from "./dimensions";

/** Supersample factor. One extra offscreen render, no aliasing speckle for the model to read as texture. */
const SS = 2;

/**
 * Frees a built scene's GPU-backed resources (geometries, materials) after
 * its render has been read into a 2D context. Exported so render-mask.ts's
 * extra render passes (Pass B mask, label pass) reuse this instead of
 * carrying a byte-for-byte copy — this module already carries the "use
 * client" boundary and render-mask.ts already imports renderToContext from
 * here, so this adds no new client/server crossing.
 */
export function disposeScene(scene: THREE.Scene) {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}

/**
 * Renders a scene through a camera onto an offscreen canvas and returns a 2D
 * context holding the result at final size. Rendering at SS x and drawing
 * down through the 2D context does the supersample and gives pixel access in
 * one step — getImageData on this same context is what the histogram assert
 * and the mask reader both use.
 */
export function renderToContext(
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: { supersample: boolean; antialias: boolean },
): CanvasRenderingContext2D {
  const scale = opts.supersample ? SS : 1;
  const gl = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas: gl,
    antialias: opts.antialias,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(GREYBOX_RENDER_W * scale, GREYBOX_RENDER_H * scale, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Flat and predictable: tone mapping would remap the value ladder's
  // carefully spaced luma bands into something else entirely.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.render(scene, camera);

  const out = document.createElement("canvas");
  out.width = GREYBOX_RENDER_W;
  out.height = GREYBOX_RENDER_H;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.imageSmoothingEnabled = opts.supersample;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(gl, 0, 0, GREYBOX_RENDER_W, GREYBOX_RENDER_H);

  renderer.dispose();
  return ctx;
}

/**
 * Renders a room's greybox to an OFFSCREEN canvas — never attached to the
 * DOM, since a canvas needs no DOM presence to get a WebGL context or export
 * a data URI — and returns a PNG data URI.
 *
 * Runs entirely client-side (needs WebGL). Callers go through
 * ensure-greybox-key.ts, which uploads the result via /api/upload-greybox to
 * get a storage key the server can reuse for later regenerations without a
 * browser.
 */
export function renderGreyboxToDataUri(spec: GreyboxRoomSpec): string {
  const scene = buildGreyboxScene(spec);
  const camera = greyboxCamera(spec, GREYBOX_ASPECT);
  const ctx = renderToContext(scene, camera, { supersample: true, antialias: true });
  const dataUri = ctx.canvas.toDataURL("image/png");
  disposeScene(scene);
  return dataUri;
}
