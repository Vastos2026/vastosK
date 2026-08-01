import * as THREE from "three";
import type { GreyboxOpening, GreyboxRoomSpec, GreyboxWall } from "./types";

/**
 * Room spec → an untextured grey 3D box, rendered from `greyboxCamera` and
 * handed to the image model as a reference. The whole point is that this
 * render is ALREADY in the output's projection, so opening positions survive
 * generation instead of having to be re-derived by the model from a top-down
 * plan (which is what fails today — see the spec's "Rejected approach").
 *
 * Openings are cut by splitting each wall into sub-panels around the opening
 * rectangle, so there is no CSG dependency.
 */

export const CEILING_H = 10;
export const DOOR_HEAD = 7;
export const WINDOW_SILL = 3;
export const WINDOW_HEAD = 7;

const WALL_COLOR = 0xb4b4b4;
const FLOOR_COLOR = 0x9a9a9a;
const CEIL_COLOR = 0xc8c8c8;
// A near-black filler read as an open doorway leading somewhere else, in the
// Phase 0 spike (the model correctly inferred "void = opening through"). A
// mid-tone, wall-adjacent leaf colour reads as a CLOSED door instead.
const DOOR_COLOR = 0x8a7c6a;
const WINDOW_COLOR = 0xf2f2f2;
// Slightly darker than the wall — the jamb/lintel reveal around an opening,
// giving it visible depth instead of being a flat colour swap.
const REVEAL_COLOR = 0x7c7c7c;

/** Where a wall sits and how its local axis maps into world space. */
interface WallFrame {
  /** wall length */
  len: number;
  /** world position of the wall plane's centre, at y = 0 */
  cx: number;
  cz: number;
  /** rotation about Y so the plane faces into the room */
  rotY: number;
  /** unit vector along the direction of increasing `t`, in world space */
  ax: number;
  az: number;
  /** inward normal, used to offset opening fillers behind the wall */
  nx: number;
  nz: number;
}

/**
 * `t` is always measured in the PLAN's reading order — west→east on the
 * north/south walls, north→south on the east/west walls — so a door drawn a
 * quarter along a wall in the 2D editor lands a quarter along that same wall
 * here, whichever wall it is. That means `ax`/`az` (the world direction of
 * increasing `t`) is +X for BOTH horizontal walls and +Z for BOTH vertical
 * ones. It does NOT flip with the wall's facing direction — `rotY` alone
 * handles facing, and since every panel is positioned by its centre, the
 * plane's own rotation has no effect on where that centre lands.
 */
function wallFrame(wall: GreyboxWall, w: number, d: number): WallFrame {
  const hw = w / 2;
  const hd = d / 2;
  switch (wall) {
    // North wall: at -Z, faces +Z. `t` runs west → east.
    case "north":
      return { len: w, cx: 0, cz: -hd, rotY: 0, ax: 1, az: 0, nx: 0, nz: 1 };
    // South wall: at +Z, faces -Z. `t` also runs west → east.
    case "south":
      return { len: w, cx: 0, cz: hd, rotY: Math.PI, ax: 1, az: 0, nx: 0, nz: -1 };
    // West wall: at -X, faces +X. `t` runs north → south.
    case "west":
      return { len: d, cx: -hw, cz: 0, rotY: Math.PI / 2, ax: 0, az: 1, nx: 1, nz: 0 };
    // East wall: at +X, faces -X. `t` also runs north → south.
    case "east":
      return { len: d, cx: hw, cz: 0, rotY: -Math.PI / 2, ax: 0, az: 1, nx: -1, nz: 0 };
  }
}

/** Vertical extent of an opening, in feet from the floor. */
function openingVertical(o: GreyboxOpening): { y0: number; y1: number } {
  return o.type === "door" ? { y0: 0, y1: DOOR_HEAD } : { y0: WINDOW_SILL, y1: WINDOW_HEAD };
}

/**
 * World-space centre of an opening. Exported so camera.ts can score candidate
 * viewpoints by how many openings actually land in frame, rather than guessing
 * from a heuristic — the two must agree exactly on where an opening sits, so
 * they share this one derivation instead of each doing their own.
 */
export function openingCentre(spec: GreyboxRoomSpec, o: GreyboxOpening): THREE.Vector3 {
  const frame = wallFrame(o.wall, spec.width, spec.depth);
  const L = frame.len;
  const spanLen = Math.max(0, Math.min(1, o.span)) * L;
  const centre = Math.max(0, Math.min(1, o.t)) * L;
  const x0 = Math.max(0, Math.min(L - spanLen, centre - spanLen / 2));
  const u = x0 + spanLen / 2 - L / 2;
  const { y0, y1 } = openingVertical(o);
  return new THREE.Vector3(frame.cx + frame.ax * u, (y0 + y1) / 2, frame.cz + frame.az * u);
}

/**
 * Adds one rectangular panel lying in a wall's plane. `u` is the panel's
 * centre along the wall's local axis, measured from the wall's centre.
 */
function addPanel(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  y: number,
  panelW: number,
  panelH: number,
  material: THREE.Material,
  offset = 0,
) {
  if (panelW <= 1e-6 || panelH <= 1e-6) return;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), material);
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * offset,
    y,
    frame.cz + frame.az * u + frame.nz * offset,
  );
  mesh.rotation.y = frame.rotY;
  group.add(mesh);
}

/**
 * A short vertical return face along one edge of an opening (a door/window
 * jamb) — perpendicular to the wall, extending `depth` outward from the wall
 * face, giving the opening visible DEPTH instead of a flat colour swap.
 *
 * Built from an explicit orthonormal basis (not an Euler rotation.y +
 * rotation.z composition) because Three.js applies Euler axes in a fixed
 * order — composing two single-axis rotations by hand is easy to get
 * subtly wrong. A basis matrix says exactly which world direction each of
 * the plane's local axes should map to, with no ordering ambiguity.
 */
function addRevealSide(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  y0: number,
  y1: number,
  depth: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(depth, y1 - y0), material);
  const xAxis = new THREE.Vector3(frame.nx, 0, frame.nz); // local width -> outward normal
  const yAxis = new THREE.Vector3(0, 1, 0); // local height -> world up
  const zAxis = xAxis.clone().cross(yAxis);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * (depth / 2),
    (y0 + y1) / 2,
    frame.cz + frame.az * u + frame.nz * (depth / 2),
  );
  group.add(mesh);
}

/** The horizontal return face above an opening (a lintel) — same construction as addRevealSide, see its comment. */
function addRevealTop(
  group: THREE.Group,
  frame: WallFrame,
  u: number,
  width: number,
  y: number,
  depth: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  const xAxis = new THREE.Vector3(frame.ax, 0, frame.az); // local width -> along the wall
  const yAxis = new THREE.Vector3(frame.nx, 0, frame.nz); // local "height" -> outward normal
  const zAxis = xAxis.clone().cross(yAxis);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  mesh.position.set(
    frame.cx + frame.ax * u + frame.nx * (depth / 2),
    y,
    frame.cz + frame.az * u + frame.nz * (depth / 2),
  );
  group.add(mesh);
}

/**
 * Builds one wall as a set of panels surrounding its openings: full-height
 * panels for the gaps between openings, plus a panel below and above each
 * opening. The opening itself is left as a hole and backed by a contrasting
 * filler plane just outside the wall, so it reads unmistakably as a door or a
 * window rather than showing the background through it.
 */
const REVEAL_DEPTH = 0.08;

function buildWall(
  group: THREE.Group,
  wall: GreyboxWall,
  spec: GreyboxRoomSpec,
  wallMat: THREE.Material,
  doorMat: THREE.Material,
  windowMat: THREE.Material,
  revealMat: THREE.Material,
) {
  const frame = wallFrame(wall, spec.width, spec.depth);
  const L = frame.len;
  const half = L / 2;

  const openings = spec.openings
    .filter((o) => o.wall === wall)
    .map((o) => {
      const spanLen = Math.max(0, Math.min(1, o.span)) * L;
      const centre = Math.max(0, Math.min(1, o.t)) * L;
      // Keep the opening fully on the wall rather than letting it hang off an end.
      const x0 = Math.max(0, Math.min(L - spanLen, centre - spanLen / 2));
      return { o, x0, x1: x0 + spanLen, ...openingVertical(o) };
    })
    .sort((a, b) => a.x0 - b.x0);

  let cursor = 0;
  for (const op of openings) {
    // Full-height panel filling the gap before this opening.
    const gapW = op.x0 - cursor;
    addPanel(group, frame, cursor + gapW / 2 - half, CEILING_H / 2, gapW, CEILING_H, wallMat);

    const opW = op.x1 - op.x0;
    const u = op.x0 + opW / 2 - half;
    // Panel below the opening — zero-height for a door, so addPanel skips it.
    addPanel(group, frame, u, op.y0 / 2, opW, op.y0, wallMat);
    // Panel above the opening.
    addPanel(group, frame, u, (op.y1 + CEILING_H) / 2, opW, CEILING_H - op.y1, wallMat);
    // Filler just outside the wall.
    addPanel(
      group,
      frame,
      u,
      (op.y0 + op.y1) / 2,
      opW,
      op.y1 - op.y0,
      op.o.type === "door" ? doorMat : windowMat,
      -0.08,
    );

    // Reveal: short returned faces along the opening's edges, at wall
    // thickness — gives the opening visible DEPTH (a real recess), which is
    // what keeps a corner or wall junction from being mistaken for one (the
    // Phase 0 spike's invented glazing) and gives a door frame to read as
    // "closed door", not "hole".
    addRevealSide(group, frame, u - opW / 2, op.y0, op.y1, REVEAL_DEPTH, revealMat);
    addRevealSide(group, frame, u + opW / 2, op.y0, op.y1, REVEAL_DEPTH, revealMat);
    addRevealTop(group, frame, u, opW, op.y1, REVEAL_DEPTH, revealMat);

    cursor = op.x1;
  }
  // Remaining full-height panel after the last opening.
  const tailW = L - cursor;
  addPanel(group, frame, cursor + tailW / 2 - half, CEILING_H / 2, tailW, CEILING_H, wallMat);
}

/**
 * Flat grey materials only: form must read clearly without implying any
 * material or style — that is the prompt's job, not the reference image's.
 */
export function buildGreyboxScene(spec: GreyboxRoomSpec): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  const wallMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const floorMat = new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: CEIL_COLOR, side: THREE.DoubleSide, roughness: 1 });
  const doorMat = new THREE.MeshBasicMaterial({ color: DOOR_COLOR, side: THREE.DoubleSide });
  const windowMat = new THREE.MeshBasicMaterial({ color: WINDOW_COLOR, side: THREE.DoubleSide });
  const revealMat = new THREE.MeshStandardMaterial({ color: REVEAL_COLOR, side: THREE.DoubleSide, roughness: 1 });

  const group = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.depth), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = CEILING_H;
  group.add(ceiling);

  (["north", "south", "east", "west"] as GreyboxWall[]).forEach((wall) =>
    buildWall(group, wall, spec, wallMat, doorMat, windowMat, revealMat),
  );

  // A post at each of the room's 4 internal corners, in the REVEAL colour —
  // a deliberate, unambiguous "this is a corner" visual cue, cheaper than
  // trying to out-argue the model with prompt wording alone (which the
  // Phase 0 strict prompt already tried and only partly worked against
  // invented glazing at an unbroken corner). Sized to actually be visible:
  // a first attempt at the WALL colour and a token 0.06 width blended in
  // completely — same colour as its surroundings reads as no signal at all.
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const POST_W = 0.22;
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  for (const [cx, cz] of corners) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(POST_W, CEILING_H, POST_W), revealMat);
    post.position.set(cx, CEILING_H / 2, cz);
    group.add(post);
  }

  scene.add(group);

  // Lighting exists only to make FORM readable, not to look good. A plain
  // hemisphere light leaves the ceiling near-black — its visible face points
  // down, so it only ever picks up the ground colour (seen on the first live
  // render). A strong ambient floor plus a soft key keeps every surface
  // clearly separated without any of them going to black, which matters
  // because a black ceiling reads to the image model as an opening rather
  // than a surface.
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 0.5));
  // Two directional lights from opposite corners at different strengths: every
  // wall catches a different amount, so adjacent surfaces never share a value
  // and the room's corners stay legible. A single key left the wall opposite
  // it flat, and cranking ambient to compensate washed the whole render into
  // one grey (both seen on live renders).
  const key = new THREE.DirectionalLight(0xffffff, 0.75);
  key.position.set(spec.width, CEILING_H * 1.5, spec.depth);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-spec.width, CEILING_H, -spec.depth);
  scene.add(fill);

  return scene;
}
