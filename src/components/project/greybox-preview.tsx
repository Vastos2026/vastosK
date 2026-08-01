"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { buildGreyboxScene } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";

/**
 * Renders a room's greybox to a canvas at a fixed pixel size and hands back a
 * PNG data URL.
 *
 * Fixed size (not responsive) on purpose: this image is a generation INPUT
 * whose aspect ratio must match the image model's output, so it must not
 * track the element's layout size the way lasso-canvas.tsx and
 * sketch-canvas.tsx do — those draw for the screen, this one draws for the
 * model.
 */
export function GreyboxPreview({
  spec,
  width,
  height,
  onReady,
}: {
  spec: GreyboxRoomSpec;
  width: number;
  height: number;
  onReady?: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // preserveDrawingBuffer keeps the rendered pixels readable by toDataURL —
    // without it the buffer is cleared after present and the export comes back
    // blank.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);

    const scene = buildGreyboxScene(spec);
    const camera = greyboxCamera(spec, width / height);
    renderer.render(scene, camera);

    onReady?.(canvas.toDataURL("image/png"));

    return () => {
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m.dispose();
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, width, height]);

  return <canvas ref={canvasRef} className="w-full rounded-xl border border-border" />;
}
