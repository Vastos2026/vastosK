import * as THREE from "three";
import { CEILING_H } from "./build-scene";
import type { GreyboxRoomSpec, GreyboxWall } from "./types";

/** Eye height, feet. */
const EYE_H = 5;
/** How far the camera sits from its corner, as a fraction of the room. */
const INSET = 0.12;
const FOV = 65;

/**
 * The automatic camera rule: stand in the corner diagonally opposite the main
 * door and look at the room's centre. That keeps the door itself in frame (so
 * its position is verifiable) while showing two full walls, which is what
 * makes the reference render legible as a room.
 *
 * With no door, falls back to the corner opposite the south wall's midpoint —
 * the conventional "looking in from the entrance side" view.
 */
export function greyboxCamera(spec: GreyboxRoomSpec, aspect: number): THREE.PerspectiveCamera {
  const door = spec.openings.find((o) => o.type === "door");
  const doorWall: GreyboxWall = door?.wall ?? "south";

  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const insetX = spec.width * INSET;
  const insetZ = spec.depth * INSET;

  // Start at the corner OPPOSITE the door's wall, then bias along that wall to
  // the far side of the door, so the door is seen at an angle rather than
  // head-on (a head-on view flattens the room and hides the side walls).
  let x = 0;
  let z = 0;
  const t = door?.t ?? 0.5;
  if (doorWall === "north" || doorWall === "south") {
    z = doorWall === "north" ? hd - insetZ : -hd + insetZ;
    x = t < 0.5 ? hw - insetX : -hw + insetX;
  } else {
    x = doorWall === "west" ? hw - insetX : -hw + insetX;
    z = t < 0.5 ? hd - insetZ : -hd + insetZ;
  }

  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 200);
  camera.position.set(x, EYE_H, z);
  camera.lookAt(0, CEILING_H * 0.42, 0);
  return camera;
}
