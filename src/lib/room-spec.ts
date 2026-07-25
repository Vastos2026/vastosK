/**
 * Exact room transfer spec.
 *
 * After 2D Review the reviewed plan IS the design (there is no 3D Studio
 * step) — so everything the user verified must reach the render stage
 * unchanged: the room's dimensions, every furniture piece's size AND placement,
 * and the door/window positions. This module serializes that ground truth into
 * a machine-readable JSON spec plus a deterministic prompt block, so the image
 * model receives the exact same numbers the user saw in 2D Review.
 *
 * Coordinate convention (stated inside the prompt too): top-down 2D plan,
 * NORTH = the top of the plan; the origin is the room's north-west corner;
 * all measurements in feet.
 */

import type { Door, FloorPlan, PlacedItem, Room, Window } from "./types";

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Fallback ceiling height (matches the 3D scene's WALL_H). */
const CEILING_FT = 9;

/** How close (ft) an opening must be to a room edge to count as on that wall. */
const WALL_TOL = 1.5;

export type WallSide = "north" | "south" | "west" | "east";

export interface SpecFurniture {
  name: string;
  /** footprint + height in feet (W = east–west, D = north–south) */
  widthFt: number;
  depthFt: number;
  heightFt: number;
  /** offset of the piece's north-west corner from the room's north-west corner */
  fromWestFt: number;
  fromNorthFt: number;
  rotationDeg: number;
  /** human placement hint derived from the offsets ("against the north wall") */
  anchor: string;
}

export interface SpecOpening {
  wall: WallSide;
  /** distance along the wall from its west end (north/south walls) or north end (west/east walls) to the opening's centre */
  offsetFt: number;
  /** opening length in feet (doors default to a standard leaf when unknown) */
  lengthFt: number;
}

export interface RoomSpec {
  room: string;
  type?: string;
  widthFt: number;
  depthFt: number;
  ceilingFt: number;
  furniture: SpecFurniture[];
  doors: SpecOpening[];
  windows: SpecOpening[];
}

/** Which wall of the room an opening sits on, or undefined if not on this room. */
function wallOf(room: Room, x: number, y: number, orientation: "h" | "v"): WallSide | undefined {
  const withinX = x >= room.x - WALL_TOL && x <= room.x + room.width + WALL_TOL;
  const withinY = y >= room.y - WALL_TOL && y <= room.y + room.height + WALL_TOL;
  if (orientation === "h" && withinX) {
    if (Math.abs(y - room.y) <= WALL_TOL) return "north";
    if (Math.abs(y - (room.y + room.height)) <= WALL_TOL) return "south";
  }
  if (orientation === "v" && withinY) {
    if (Math.abs(x - room.x) <= WALL_TOL) return "west";
    if (Math.abs(x - (room.x + room.width)) <= WALL_TOL) return "east";
  }
  return undefined;
}

/** Offset of an opening's centre along its wall, from the wall's NW end. */
function offsetAlong(room: Room, wall: WallSide, x: number, y: number): number {
  return wall === "north" || wall === "south"
    ? Math.max(0, r1(x - room.x))
    : Math.max(0, r1(y - room.y));
}

/** Placement hint from the piece's clearances to each wall. */
function anchorOf(room: Room, it: PlacedItem): string {
  const NEAR = 0.7; // ft — reads as "against the wall"
  const west = it.x - room.x;
  const north = it.y - room.y;
  const east = room.x + room.width - (it.x + it.w);
  const south = room.y + room.height - (it.y + it.d);
  const near: string[] = [];
  if (north <= NEAR) near.push("north");
  if (south <= NEAR) near.push("south");
  if (west <= NEAR) near.push("west");
  if (east <= NEAR) near.push("east");
  if (near.length >= 2) return `in the ${near.join("-")} corner`;
  if (near.length === 1) return `against the ${near[0]} wall`;
  return "free-standing";
}

/**
 * Build the exact spec for one room from the REVIEWED plan: the room's own
 * dimensions, each furniture piece placed in it (position relative to the
 * room's NW corner) and the doors/windows sitting on its walls.
 */
export function buildRoomSpec(room: Room, items: PlacedItem[], plan?: FloorPlan): RoomSpec {
  const furniture: SpecFurniture[] = items
    .filter((it) => !it.ghost && it.roomId === room.id)
    .map((it) => ({
      name: it.name,
      widthFt: r1(it.w),
      depthFt: r1(it.d),
      heightFt: r1(it.h),
      fromWestFt: r1(it.x - room.x),
      fromNorthFt: r1(it.y - room.y),
      rotationDeg: Math.round(it.rotation ?? 0),
      anchor: anchorOf(room, it),
    }));

  const doors: SpecOpening[] = [];
  for (const d of (plan?.doors ?? []) as Door[]) {
    const wall = wallOf(room, d.x, d.y, d.orientation);
    if (!wall) continue;
    doors.push({ wall, offsetFt: offsetAlong(room, wall, d.x, d.y), lengthFt: 2.8 });
  }

  const windows: SpecOpening[] = [];
  for (const w of (plan?.windows ?? []) as Window[]) {
    const wall = wallOf(room, w.x, w.y, w.orientation);
    if (!wall) continue;
    windows.push({
      wall,
      offsetFt: offsetAlong(room, wall, w.x, w.y),
      lengthFt: Math.max(1, r1(w.length)),
    });
  }

  return {
    room: room.name,
    type: room.type,
    widthFt: r1(room.width),
    depthFt: r1(room.height),
    ceilingFt: room.ceilingFt ?? CEILING_FT,
    furniture,
    doors,
    windows,
  };
}

/** The spec as compact JSON — attachable to any payload that needs the data. */
export function roomSpecJson(spec: RoomSpec): string {
  return JSON.stringify(spec);
}

/**
 * The spec as a strict prompt block. Every number is the reviewed value —
 * nothing summarized, nothing dropped (furniture capped only at an extreme
 * count to keep the prompt usable).
 */
export function roomSpecPromptBlock(spec: RoomSpec, maxFurniture = 14): string {
  const lines: string[] = [
    `EXACT ROOM LAYOUT — follow precisely (top-down 2D plan, NORTH = top of the plan; ` +
      `origin at the room's north-west corner; all measurements in feet):`,
    `- Room "${spec.room}": ${spec.widthFt} ft east–west × ${spec.depthFt} ft north–south, ` +
      `ceiling ${spec.ceilingFt} ft (${r1(spec.widthFt * spec.depthFt)} sq ft).`,
  ];
  for (const f of spec.furniture.slice(0, maxFurniture)) {
    lines.push(
      `- ${f.name}: ${f.widthFt} W × ${f.depthFt} D × ${f.heightFt} H ft, its north-west corner ` +
        `${f.fromWestFt} ft from the west wall and ${f.fromNorthFt} ft from the north wall` +
        (f.rotationDeg ? `, rotated ${f.rotationDeg}°` : "") +
        ` — ${f.anchor}.`,
    );
  }
  if (spec.furniture.length > maxFurniture) {
    lines.push(`- (+${spec.furniture.length - maxFurniture} more pieces, same convention)`);
  }
  for (const d of spec.doors) {
    lines.push(
      `- Door on the ${d.wall} wall, centred ${d.offsetFt} ft from that wall's ` +
        `${d.wall === "north" || d.wall === "south" ? "west" : "north"} end (~${d.lengthFt} ft opening).`,
    );
  }
  for (const w of spec.windows) {
    lines.push(
      `- Window on the ${w.wall} wall, centred ${w.offsetFt} ft from that wall's ` +
        `${w.wall === "north" || w.wall === "south" ? "west" : "north"} end, ${w.lengthFt} ft wide.`,
    );
  }
  lines.push(
    `Reproduce this layout EXACTLY: every piece at its stated position, size and rotation; ` +
      `doors and windows exactly where stated. Do not add, remove, move or resize anything.`,
  );
  return lines.join("\n");
}

const clampI = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * The four wall cameras a room is rendered/filmed from. FRONT faces the plan's
 * NORTH wall; the 3D capture cameras (scene-3d `cameraFor`) fix the rest.
 */
export type LockView = "front" | "left" | "right" | "back";

/**
 * How each camera projects the plan onto the image. Derived from scene-3d's
 * capture poses (verified): for the FRONT camera screen-LEFT = WEST, far = NORTH;
 * turning the camera to each other wall rotates that mapping. `hAxis` is the world
 * axis that runs left↔right across the frame; `hFlip` = screen-left is that axis's
 * MAX end. The depth axis is the other one; `dFarIsMax` = the far/background wall
 * is that axis's MAX end.
 */
interface ViewProjection {
  hAxis: "ew" | "ns";
  hFlip: boolean;
  dFarIsMax: boolean;
  leftWall: string;
  rightWall: string;
  farWall: string;
  nearWall: string;
  cameraLine: string;
}

const VIEW_PROJECTION: Record<LockView, ViewProjection> = {
  // Camera SOUTH looking NORTH: left=west, right=east, far=north, near=south.
  front: {
    hAxis: "ew", hFlip: false, dFarIsMax: false,
    leftWall: "west", rightWall: "east", farWall: "north", nearWall: "south",
    cameraLine: "Camera is SOUTH looking NORTH (facing the room's NORTH wall).",
  },
  // Camera EAST looking WEST: left=south, right=north, far=west, near=east.
  left: {
    hAxis: "ns", hFlip: true, dFarIsMax: false,
    leftWall: "south", rightWall: "north", farWall: "west", nearWall: "east",
    cameraLine: "Camera is EAST looking WEST (facing the room's WEST wall).",
  },
  // Camera WEST looking EAST: left=north, right=south, far=east, near=west.
  right: {
    hAxis: "ns", hFlip: false, dFarIsMax: true,
    leftWall: "north", rightWall: "south", farWall: "east", nearWall: "west",
    cameraLine: "Camera is WEST looking EAST (facing the room's EAST wall).",
  },
  // Camera NORTH looking SOUTH: left=east, right=west, far=south, near=north.
  back: {
    hAxis: "ew", hFlip: true, dFarIsMax: true,
    leftWall: "east", rightWall: "west", farWall: "south", nearWall: "north",
    cameraLine: "Camera is NORTH looking SOUTH (facing the room's SOUTH — back — wall).",
  },
};

/**
 * VIEW LAYOUT LOCK — a CAMERA-ORIENTED spatial description for a wall render,
 * appended after {@link roomSpecPromptBlock}. The exact-layout block gives
 * authoritative offsets/openings; this block translates them into what an image
 * model actually obeys: each piece's position ACROSS THE FRAME, its DEPTH, its
 * real SIZE, and the RELATIONS between pieces ("the plant is to the LEFT of the
 * bed"). Image models reproduce explicit relative statements far more reliably
 * than absolute coordinates they must mentally project.
 *
 * Generalised from the front-only lock to all four wall cameras (2026-07-21) so
 * the walkthrough's Left/Right/Back sides get the SAME placement grounding the
 * front already had — the "perfect placement on every side" goal. Each view's
 * plan→frame mapping comes from {@link VIEW_PROJECTION}; every value is derived
 * deterministically from the reviewed SpecFurniture (no new fields, no invented
 * numbers). The FRONT projection reproduces the previous front-only geometry
 * exactly (same frame %, order, depth, occlusion, map) — only the block's title
 * generalised from "FRONT-VIEW LAYOUT LOCK" to "VIEW LAYOUT LOCK".
 *
 * Encoding chosen by an expert design panel + adversarial judge: frame-column %
 * spans (pin horizontal position AND size together), wall-gap depth (so a deep
 * piece reads "back-anchored, full depth" not a contradictory "mid"), a
 * left→right chain, a dominant-mass anchor split, overlap-gated occlusion, a
 * height-as-%-of-ceiling scale anchor, and a top-down schematic map.
 */
export function viewLayoutLock(spec: RoomSpec, view: LockView, maxFurniture = 14): string {
  const pieces = spec.furniture.slice(0, maxFurniture);
  if (!pieces.length) return "";

  const proj = VIEW_PROJECTION[view];
  const RW = spec.widthFt;
  const RD = spec.depthFt;
  const C = spec.ceilingFt || CEILING_FT;
  // The horizontal axis of the FRAME and the depth axis both depend on the camera.
  const hTotal = proj.hAxis === "ew" ? RW : RD;
  const dTotal = proj.hAxis === "ew" ? RD : RW;
  const Tw = Math.max(1, 0.12 * hTotal); // "against a side wall" tolerance (ft)
  const Td = Math.max(1, 0.12 * dTotal); // "against far/near wall" tolerance (ft)
  const TIE_EPS = 0.25; // don't assert an order for coincident centres
  const pctOf = (v: number, total: number) => Math.round((100 * v) / (total || 1));

  // Each piece's extent along the frame's horizontal axis and its depth axis.
  const along = (f: SpecFurniture) =>
    proj.hAxis === "ew"
      ? { aMin: f.fromWestFt, aLen: f.widthFt, dMin: f.fromNorthFt, dLen: f.depthFt }
      : { aMin: f.fromNorthFt, aLen: f.depthFt, dMin: f.fromWestFt, dLen: f.widthFt };

  // Unique single-letter labels for the map (initials, then A–Z on collision).
  const used = new Set<string>();
  const labelFor = (name: string): string => {
    const cands = name.toUpperCase().replace(/[^A-Z]/g, "") + "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const ch of cands) if (!used.has(ch)) { used.add(ch); return ch; }
    return "?";
  };

  interface P {
    f: SpecFurniture;
    label: string;
    /** screen-horizontal centre, feet (0 = screen-left edge) */
    sx: number;
    /** depth toward the camera, feet (larger = nearer camera) */
    sy: number;
    frameL: number;
    frameR: number;
    /** grid footprint in screen space, feet */
    gx0: number;
    gx1: number;
    gy0: number;
    gy1: number;
    horiz: string;
    depth: string;
    sizeStr: string;
  }
  const maxH = Math.max(...pieces.map((p) => p.heightFt));
  const enriched: P[] = pieces.map((f) => {
    const { aMin, aLen, dMin, dLen } = along(f);
    const aMax = aMin + aLen;
    const dMax = dMin + dLen;

    // Project the along-axis span onto the frame (flip when screen-left = axis max).
    const n0 = aMin / (hTotal || 1);
    const n1 = aMax / (hTotal || 1);
    const frameLfrac = proj.hFlip ? 1 - n1 : n0;
    const frameRfrac = proj.hFlip ? 1 - n0 : n1;
    const sx = ((frameLfrac + frameRfrac) / 2) * hTotal;

    // Gaps to the two side walls, mapped to screen-left / screen-right.
    const gMin = aMin; // gap to the axis-min wall
    const gMax = hTotal - aMax; // gap to the axis-max wall
    const leftGap = proj.hFlip ? gMax : gMin;
    const rightGap = proj.hFlip ? gMin : gMax;

    // Depth: gap to the far (background) wall and the near (camera) wall.
    const farGap = proj.dFarIsMax ? dTotal - dMax : dMin;
    const nearGap = proj.dFarIsMax ? dMin : dTotal - dMax;
    const sy = dTotal - nearGap; // larger = nearer camera
    const backPct = pctOf(farGap, dTotal);

    let horiz: string;
    if (leftGap <= Tw && rightGap <= Tw) horiz = "spans the full width";
    else if (leftGap <= Tw) horiz = `against the LEFT/${proj.leftWall} wall`;
    else if (rightGap <= Tw) horiz = `against the RIGHT/${proj.rightWall} wall`;
    else if (Math.abs(sx - hTotal / 2) <= Math.max(1, 0.1 * hTotal)) horiz = "horizontally CENTERED";
    else horiz = sx < hTotal / 2 ? "left of centre" : "right of centre";

    let depth: string;
    if (farGap <= Td && nearGap <= Td)
      depth = `back-anchored, spans the full depth (${r1(dLen)}ft deep, back edge ${backPct}% from the rear)`;
    else if (farGap <= Td) depth = `against the BACK/${proj.farWall} wall (far)`;
    else if (nearGap <= Td) depth = "at the FRONT, nearest the camera";
    else depth = `mid-depth (${backPct}%–${pctOf(farGap + dLen, dTotal)}% from the rear)`;

    const turned = f.rotationDeg % 90 !== 0 ? `, turned ${f.rotationDeg}°` : "";
    const sizeStr =
      `${r1(f.widthFt)}×${r1(f.depthFt)}×${r1(f.heightFt)}ft (~${pctOf(f.heightFt, C)}% of the ${r1(C)}ft ceiling tall)${turned}` +
      (f.heightFt === maxH ? " [tallest]" : "");

    return {
      f,
      label: labelFor(f.name),
      sx,
      sy,
      frameL: Math.round(frameLfrac * 100),
      frameR: Math.round(frameRfrac * 100),
      gx0: frameLfrac * hTotal,
      gx1: frameRfrac * hTotal,
      gy0: farGap, // feet from the far wall (row 0 = far)
      gy1: farGap + dLen,
      horiz,
      depth,
      sizeStr,
    };
  });

  const lr = [...enriched].sort(
    (a, b) => a.sx - b.sx || b.f.widthFt - a.f.widthFt || a.f.name.localeCompare(b.f.name),
  );

  const lines: string[] = [
    "=== VIEW LAYOUT LOCK ===",
    `${proj.cameraLine} In this image: screen LEFT = ${proj.leftWall.toUpperCase()} side, ` +
      `screen RIGHT = ${proj.rightWall.toUpperCase()} side, BACKGROUND/far = ${proj.farWall.toUpperCase()} wall, ` +
      `FOREGROUND/near = ${proj.nearWall.toUpperCase()}. Frame % = horizontal position across the image ` +
      `(0% = far-left edge, 100% = far-right edge). Place every piece at its stated frame span, real size, ` +
      `order and depth; do not move, resize, add or drop anything.`,
    "",
    "PIECES (screen left → right; size = W×D×H ft = east-west × north-south × tall):",
  ];
  for (const p of lr) {
    lines.push(`- ${p.f.name}: ${p.sizeStr} | frame ${p.frameL}%–${p.frameR}% | ${p.horiz} | ${p.depth}`);
  }
  lines.push("");

  const chain = lr
    .map((p, i) => (i === 0 ? p.f.name : (Math.abs(p.sx - lr[i - 1].sx) <= TIE_EPS ? " ~ " : " < ") + p.f.name))
    .join("");
  lines.push(`ORDER (left → right): ${chain}`);

  const anchor = enriched.reduce((a, b) => {
    const fa = a.f.widthFt * a.f.depthFt;
    const fb = b.f.widthFt * b.f.depthFt;
    return fb > fa || (fb === fa && b.f.widthFt > a.f.widthFt) ? b : a;
  });
  const leftOf = enriched.filter((p) => p !== anchor && p.sx < anchor.sx - TIE_EPS).map((p) => p.f.name);
  const rightOf = enriched.filter((p) => p !== anchor && p.sx > anchor.sx + TIE_EPS).map((p) => p.f.name);
  lines.push(
    `RELATIVE TO the ${anchor.f.name} (largest piece): to its LEFT = [${leftOf.join(", ") || "nothing"}]; ` +
      `to its RIGHT = [${rightOf.join(", ") || "nothing"}]`,
  );

  const occ: string[] = [];
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i];
      const b = enriched[j];
      if (!(a.frameL < b.frameR && b.frameL < a.frameR)) continue; // no horizontal overlap
      if (Math.abs(a.sy - b.sy) <= TIE_EPS) continue;
      const near = a.sy > b.sy ? a : b;
      const far = a.sy > b.sy ? b : a;
      occ.push(`${near.f.name} sits in FRONT of ${far.f.name} (closer to the camera)`);
    }
  }
  lines.push(
    occ.length
      ? `OCCLUSION: ${occ.join("; ")}`
      : "OCCLUSION: none — no pieces overlap left-to-right, so every piece is fully visible; do NOT stack pieces front-to-back",
  );
  lines.push("");
  lines.push(...asciiLayoutMap(enriched, hTotal, dTotal, proj));
  lines.push("=== END LAYOUT LOCK ===");
  return lines.join("\n");
}

/** Back-compat alias — the front camera's layout lock. */
export function frontViewLayoutLock(spec: RoomSpec, maxFurniture = 14): string {
  return viewLayoutLock(spec, "front", maxFurniture);
}

/** Top-down schematic of the layout, oriented exactly as THIS camera frames it. */
function asciiLayoutMap(
  pieces: { f: SpecFurniture; label: string; gx0: number; gx1: number; gy0: number; gy1: number }[],
  hTotal: number,
  dTotal: number,
  proj: ViewProjection,
): string[] {
  const cols = clampI(hTotal, 3, 28);
  const rows = clampI(dTotal, 3, 20);
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill("."));
  // Largest footprint first, so small pieces overwrite (sit "on top") last.
  const order = [...pieces].sort(
    (a, b) => (b.gx1 - b.gx0) * (b.gy1 - b.gy0) - (a.gx1 - a.gx0) * (a.gy1 - a.gy0),
  );
  for (const p of order) {
    for (let r = 0; r < rows; r++) {
      const ry0 = (r / rows) * dTotal;
      const ry1 = ((r + 1) / rows) * dTotal;
      if (!(p.gy0 < ry1 && ry0 < p.gy1)) continue;
      for (let c = 0; c < cols; c++) {
        const cx0 = (c / cols) * hTotal;
        const cx1 = ((c + 1) / cols) * hTotal;
        if (p.gx0 < cx1 && cx0 < p.gx1) grid[r][c] = p.label;
      }
    }
  }
  const pad = "        ";
  const out: string[] = [
    `TOP-DOWN REFERENCE MAP (schematic only — do NOT draw it; top = far/${proj.farWall} wall, ` +
      `bottom = near camera/${proj.nearWall}, left = ${proj.leftWall}, right = ${proj.rightWall}):`,
    pad + `  ${proj.farWall.toUpperCase()} WALL (far in image)`,
    pad + "+" + "-".repeat(cols) + "+",
  ];
  for (let r = 0; r < rows; r++) out.push(pad + "|" + grid[r].join("") + "|");
  out.push(pad + "+" + "-".repeat(cols) + "+");
  out.push(pad + `  ${proj.nearWall.toUpperCase()} (near camera)`);
  out.push("  " + pieces.map((p) => `${p.label}=${p.f.name}`).join("  "));
  return out;
}
