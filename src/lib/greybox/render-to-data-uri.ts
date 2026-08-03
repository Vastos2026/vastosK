"use client";

import * as THREE from "three";
import { buildGreyboxScene } from "./build-scene";
import { greyboxCamera } from "./camera";
import type { GreyboxRoomSpec } from "./types";

// Pure pixel statistics live in ./histogram, which carries no "use client"
// directive — this module is client-only (WebGL), and the server-side
// dev-check route needs to import assertHistogram without pulling that
// boundary in. Re-exported so existing/downstream import paths (Task 5 reads
// assertHistogram from here) keep working unchanged.
export { assertHistogram, GreyboxHistogramError } from "./histogram";

/**
 * The ONE place greybox output dimensions are decided. Section 3.4 requires
 * the generation width/height to produce exactly this aspect — any mismatch
 * and FLUX letterboxes or crops, which breaks the camera match the whole
 * pipeline depends on. runware-client.ts imports these rather than keeping
 * its own numbers, so the two cannot drift.
 *
 * 1376x768 is section 3.4's stated target (both divisible by 16). If Runware
 * rejects it on bfl:5@1 with invalidWidth — FLUX.1-dev required divisibility
 * by 64 and the ControlNet spike hit exactly this — change these two numbers
 * to 1280x704 and nothing else needs to move. Task 13 verifies which applies.
 */
export const GREYBOX_RENDER_W = 1376;
export const GREYBOX_RENDER_H = 768;
export const GREYBOX_ASPECT = GREYBOX_RENDER_W / GREYBOX_RENDER_H;

/** Supersample factor. One extra offscreen render, no aliasing speckle for the model to read as texture. */
const SS = 2;

function disposeScene(scene: THREE.Scene) {
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
