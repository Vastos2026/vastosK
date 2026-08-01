"use client";

import * as THREE from "three";
import { buildGreyboxScene } from "./build-scene";
import { greyboxCamera } from "./camera";
import type { GreyboxRoomSpec } from "./types";

const RENDER_W = 1376;
const RENDER_H = 768;

/**
 * Renders a room's greybox to an OFFSCREEN canvas — never attached to the
 * DOM, since a canvas needs no DOM presence to get a WebGL context or export
 * a data URI — and returns a PNG data URI.
 *
 * Runs entirely client-side (needs WebGL). Callers (design/page.tsx,
 * generate/page.tsx, via ensure-greybox-key.ts) invoke this right before
 * their generation call, then upload the result via /api/upload-greybox to
 * get a storage key the server can reuse for later regenerations without a
 * browser.
 */
export function renderGreyboxToDataUri(spec: GreyboxRoomSpec): string {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(RENDER_W, RENDER_H, false);

  const scene = buildGreyboxScene(spec);
  const camera = greyboxCamera(spec, RENDER_W / RENDER_H);
  renderer.render(scene, camera);
  const dataUri = canvas.toDataURL("image/png");

  renderer.dispose();
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });

  return dataUri;
}
