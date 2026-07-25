"use client";

/**
 * 360° room viewer — maps an equirectangular render onto the inside of a sphere
 * with the camera PINNED at the centre, so the user looks around the room in
 * place (a real 360, not a curved panorama).
 *
 * The camera never leaves the centre: OrbitControls only ROTATES (zoom-by-dolly
 * is disabled), and zoom changes the FIELD OF VIEW instead. Letting the camera
 * dolly toward the sphere wall is what made the old viewer "bend" the image into
 * a fisheye bowl.
 */

import { useEffect } from "react";
import { Canvas, useThree, useLoader } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { BackSide, PerspectiveCamera, TextureLoader } from "three";
import { Icon } from "@/components/ui/icon";

const MIN_FOV = 35;
const MAX_FOV = 88;

function Dome({ src }: { src: string }) {
  const texture = useLoader(TextureLoader, src);
  return (
    <mesh scale={[-1, 1, 1]}>
      {/* scale.x = -1 flips the sphere so the equirectangular texture reads the
          right way round from the inside; BackSide renders the inner surface. */}
      <sphereGeometry args={[10, 96, 64]} />
      <meshBasicMaterial map={texture} side={BackSide} />
    </mesh>
  );
}

/** Zoom by FOV (camera stays at centre) instead of dollying it off-centre. */
function FovZoom() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera as PerspectiveCamera;
      cam.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, cam.fov + e.deltaY * 0.04));
      cam.updateProjectionMatrix();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [camera, gl]);
  return null;
}

export default function Panorama360({ src }: { src: string }) {
  return (
    <div className="relative h-full w-full">
      {/* Camera at the sphere centre (tiny offset so OrbitControls has a radius to
          rotate around); looks straight ahead. */}
      <Canvas camera={{ position: [0, 0, 0.01], fov: 72, near: 0.01, far: 100 }}>
        <Dome src={src} />
        <FovZoom />
        <OrbitControls
          enableZoom={false}
          enablePan={false}
          enableDamping
          dampingFactor={0.1}
          rotateSpeed={-0.3}
          target={[0, 0, 0]}
        />
      </Canvas>
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs text-muted backdrop-blur">
        <Icon name="Move" className="size-3.5 text-accent" /> Drag to look around · scroll to zoom
      </div>
    </div>
  );
}
