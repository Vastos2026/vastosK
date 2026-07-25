/**
 * Merge Engine.
 *
 * Combines the two upstream views of the plan:
 *   • OpenCV → authoritative GEOMETRY (walls/doors/windows/room boxes, pixels)
 *   • Gemini → authoritative SEMANTICS (room names, types, dimensions, scale)
 *
 * It (1) resolves a feet-per-pixel scale, (2) converts pixel geometry to feet,
 * and (3) labels each detected room box with the best-matching Gemini room.
 */

import type { Door, FloorPlan, PlacedItem, Room, Wall, Window } from "@/lib/types";
import type { OpenCvResult } from "./opencv";
import type { SemanticFurniture, SemanticOpening, SemanticPlan } from "./types";

const ROOM_PALETTE = [
  "#e6a45c", "#6da8e2", "#5cc98a", "#d4972a", "#b98ce2",
  "#e27d9a", "#6dc7e2", "#8ac98a", "#c98a8a", "#8a9ec9",
];

/** A residential plan's longest wall, in feet — last-resort fallback only. */
const FALLBACK_LONGEST_SIDE_FT = 40;

const r1 = (n: number) => Math.round(n * 10) / 10;
const ri = (n: number) => Math.round(n);
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface MergeInput {
  geometry: OpenCvResult;
  semantic: SemanticPlan;
  fileName: string;
  /** explicit feet-per-pixel from the caller (highest priority) */
  scale?: number;
  /** known longest side in feet from the caller (e.g. user calibration) */
  longestSideFt?: number;
}

export interface MergeOutput {
  plan: FloorPlan;
  scale: number;
  /** true when scale came from a real measurement, not the fallback constant */
  calibrated: boolean;
  roomsNamed: number;
  /** furniture / fixtures detected on the plan, placed in feet space */
  items: PlacedItem[];
}

// Detected-furniture vocabulary lives in one shared place so the per-room
// detection client places fixtures exactly the way the parse pipeline does.
import { FURNITURE_SPEC } from "../furniture-spec";

/** The merged room whose centre is nearest to (px,py) in feet; undefined if none. */
function nearestRoom(rooms: Room[], px: number, py: number): Room | undefined {
  let best: Room | undefined;
  let bestD = Infinity;
  for (const r of rooms) {
    const d = Math.hypot(r.x + r.width / 2 - px, r.y + r.height / 2 - py);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/**
 * Detected furniture → placeable items, in feet, placed RELATIVE to their room.
 *
 * Furniture is detected in SEMANTIC feet space (semantic.ts), but the merged rooms
 * can be in a DIFFERENT space (the geometry path tiles OpenCV boxes) AND get moved
 * by the room cleanup (snap/separate/trim/compact). Placing furniture by its raw
 * absolute coordinates therefore drifts — pieces float in a wall or land outside
 * their room. Instead: find the SEMANTIC room a piece sits in, then drop it at the
 * SAME relative spot inside that room's MERGED rectangle, capped to fit with a wall
 * margin. Pieces with no semantic host go to the nearest merged room. So furniture
 * always sits realistically INSIDE its room, whatever the layout cleanup did.
 */
function toPlacedItems(
  furniture: SemanticFurniture[] | undefined,
  rooms: Room[],
  /** semantic room (feet position, where furniture was read) → its merged Room */
  semRooms: { sem: SemanticRoomLike; room: Room }[],
  planWidth: number,
  planHeight: number,
): PlacedItem[] {
  const MARGIN = 0.3; // keep furniture clear of the walls
  return (furniture ?? [])
    .map((f, i): PlacedItem | null => {
      const spec = FURNITURE_SPEC[f.type] ?? FURNITURE_SPEC.other;
      let w = clampN(r1(f.widthFt), 0.8, planWidth);
      let d = clampN(r1(f.heightFt), 0.8, planHeight);
      if (w < 0.8 || d < 0.8) return null;

      // Furniture centre in SEMANTIC space (same space the semantic rooms use).
      const fcx = r1(f.xFt) + w / 2;
      const fcy = r1(f.yFt) + d / 2;

      let target: Room | undefined;
      let relX = 0.5;
      let relY = 0.5;
      const host = semRooms.find(
        ({ sem }) =>
          sem.xFt !== undefined &&
          sem.yFt !== undefined &&
          !!sem.widthFt &&
          !!sem.heightFt &&
          fcx >= sem.xFt &&
          fcx <= sem.xFt + sem.widthFt &&
          fcy >= sem.yFt &&
          fcy <= sem.yFt + sem.heightFt,
      );
      if (host) {
        target = host.room;
        relX = (fcx - host.sem.xFt!) / host.sem.widthFt!;
        relY = (fcy - host.sem.yFt!) / host.sem.heightFt!;
      } else {
        // No semantic host (unpositioned room / detection gap): nearest merged room.
        target = nearestRoom(rooms, fcx, fcy);
      }

      if (!target) {
        // No rooms at all — fall back to the raw absolute clamp.
        const x = clampN(r1(f.xFt), 0, Math.max(0, planWidth - w));
        const y = clampN(r1(f.yFt), 0, Math.max(0, planHeight - d));
        return {
          id: `det_item_${i}`,
          catalogId: spec.catalogId,
          name: spec.name,
          roomId: undefined,
          x,
          y,
          rotation: 0,
          w,
          d,
          h: spec.h,
          color: spec.color,
        };
      }

      // Cap the piece to fit the room (minus wall margins), place it at the relative
      // spot, then clamp it fully inside the room so it never pokes through a wall.
      w = r1(Math.min(w, Math.max(0.8, target.width - 2 * MARGIN)));
      d = r1(Math.min(d, Math.max(0.8, target.height - 2 * MARGIN)));
      const cx = target.x + clampN(relX, 0, 1) * target.width;
      const cy = target.y + clampN(relY, 0, 1) * target.height;
      const x = clampN(r1(cx - w / 2), r1(target.x + MARGIN), r1(target.x + target.width - w - MARGIN));
      const y = clampN(r1(cy - d / 2), r1(target.y + MARGIN), r1(target.y + target.height - d - MARGIN));
      return {
        id: `det_item_${i}`,
        catalogId: spec.catalogId,
        name: spec.name,
        roomId: target.id,
        x,
        y,
        rotation: 0,
        w,
        d,
        h: spec.h,
        color: spec.color,
      };
    })
    .filter((it): it is PlacedItem => !!it);
}

type SemanticRoomLike = SemanticPlan["rooms"][number];
type RoomBox = { index: number; x: number; y: number; width: number; height: number };

export function mergePlan(input: MergeInput): MergeOutput {
  const { geometry: g, semantic } = input;

  // Dimension-driven path: when Gemini reconstructed the layout from the plan's
  // PRINTED dimensions (source "gemini-vision"), those feet values are
  // authoritative — build geometry directly from them instead of scaling noisy
  // pixel detection. This is what makes dimensions accurate (see semantic.ts).
  if (semantic.source === "gemini-vision" && semantic.overallWidthFt && semantic.overallHeightFt) {
    return buildFromSemantic(input);
  }

  const longestPx = Math.max(g.imageWidth, g.imageHeight) || 1;

  // Known feet values (from Gemini or the user) describe the BUILDING, not the
  // sheet. Scale against the building footprint when the detector found one, so
  // the title block, compass and margins don't shrink every room. Falls back to
  // the full image when no buildingBox is available (older runs stay identical).
  const bb = g.buildingBox;
  const buildingLongestPx =
    bb && Math.max(bb.w, bb.h) > 0 ? Math.max(bb.w, bb.h) : longestPx;

  // The building's longest side in feet, preferring the explicit envelope Gemini
  // reads off the outer dimension chain, then a single longest-side label.
  const semanticLongestFt =
    Math.max(semantic.overallWidthFt ?? 0, semantic.overallHeightFt ?? 0) ||
    (semantic.longestSideFt ?? 0);

  // 1) Resolve scale (feet per pixel) by priority:
  //    explicit → Gemini scale bar → local printed-dim scale → Gemini building
  //    dims → caller's → fallback. The local printed-dim scale (from the
  //    labeled detector reading the plan's dimension text) sits high because
  //    it's a direct measurement — it's what keeps the plan calibrated when
  //    Gemini is down instead of collapsing to the 40 ft fallback.
  let scale: number;
  let calibrated = true;
  if (input.scale && input.scale > 0) {
    scale = input.scale;
  } else if (semantic.scaleFtPerPx && semantic.scaleFtPerPx > 0) {
    scale = semantic.scaleFtPerPx;
  } else if (g.scaleFtPerPx && g.scaleFtPerPx > 0) {
    scale = g.scaleFtPerPx;
  } else if (semanticLongestFt > 0) {
    scale = semanticLongestFt / buildingLongestPx;
  } else if (input.longestSideFt && input.longestSideFt > 0) {
    scale = input.longestSideFt / buildingLongestPx;
  } else {
    scale = FALLBACK_LONGEST_SIDE_FT / buildingLongestPx;
    calibrated = false;
  }

  const planWidth = Math.max(8, r1(g.imageWidth * scale));
  const planHeight = Math.max(8, r1(g.imageHeight * scale));

  // 2) Convert pixel geometry → feet.
  const roomBoxes: RoomBox[] = g.rooms.map((b, i) => {
    const w = Math.max(3, ri(b.w * scale));
    const h = Math.max(3, ri(b.h * scale));
    return {
      index: i,
      x: Math.min(ri(b.x * scale), Math.max(0, planWidth - w)),
      y: Math.min(ri(b.y * scale), Math.max(0, planHeight - h)),
      width: Math.min(w, planWidth),
      height: Math.min(h, planHeight),
    };
  });

  // 3) Assign Gemini room names/types to the detected boxes.
  const assignments = assignRooms(roomBoxes, semantic);
  let roomsNamed = 0;

  const rooms: Room[] = roomBoxes.map((b, i) => {
    const sem = assignments[i];
    // The label-anchored detector already named each box from the plan's
    // printed label; prefer Gemini's name when present, fall back to the
    // detector's so rooms stay named even when Gemini is unavailable (quota).
    const detected = g.rooms[b.index];
    const name = sem?.name ?? detected?.name;
    if (name) roomsNamed++;
    return {
      id: `room_${i}`,
      name: name ?? `Room ${i + 1}`,
      type: sem?.type ?? detected?.type,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      color: ROOM_PALETTE[i % ROOM_PALETTE.length],
    };
  });

  // Eliminate overlaps + align shared walls, matching the vision path's cleanup
  // (objective: no room overlaps / consistent boundaries). Positions/trim only —
  // the scaled pixel boxes can overlap where OpenCV's regions touched, and this
  // fallback path previously left those overlaps in. Labels and scale are untouched.
  snapToGrid(rooms, planWidth, planHeight);
  separateOverlaps(rooms, planWidth, planHeight);
  trimResidualOverlaps(rooms, planWidth, planHeight);

  const walls: Wall[] = g.walls.map((w, i) => ({
    id: `wall_${i}`,
    x1: ri(w.x1 * scale),
    y1: ri(w.y1 * scale),
    x2: ri(w.x2 * scale),
    y2: ri(w.y2 * scale),
    thickness: Math.max(0.3, r1(w.thickness * scale)),
  }));

  const doors: Door[] = g.doors.map((d, i) => ({
    id: `door_${i}`,
    x: ri(d.x * scale),
    y: ri(d.y * scale),
    orientation: d.orientation,
  }));

  const windows: Window[] = g.windows.map((w, i) => ({
    id: `win_${i}`,
    x: ri(w.x * scale),
    y: ri(w.y * scale),
    orientation: w.orientation,
    length: Math.max(1, r1(w.length * scale)),
  }));

  // Record the resolved scale back onto the geometry (used by the overlay).
  g.scale = scale;

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms,
    doors,
    walls,
    windows,
    meta: {
      source: "merged",
      confidence: g.confidence,
      detectedAt: new Date().toISOString(),
      roomsNamed,
    },
  };

  return { plan, scale, calibrated, roomsNamed, items: [] };
}

/**
 * The bounding box (pixels) of the union of detected room boxes — the building's
 * real interior extent, free of the dimension lines / borders that inflate the
 * raw wall-pixel buildingBox. Undefined when fewer than 2 rooms were detected.
 */
function unionRoomBox(
  rooms: { x: number; y: number; w: number; h: number }[],
): NonNullable<OpenCvResult["buildingBox"]> | undefined {
  if (!rooms || rooms.length < 2) return undefined;
  const x0 = Math.min(...rooms.map((r) => r.x));
  const y0 = Math.min(...rooms.map((r) => r.y));
  const x1 = Math.max(...rooms.map((r) => r.x + r.w));
  const y1 = Math.max(...rooms.map((r) => r.y + r.h));
  const w = x1 - x0;
  const h = y1 - y0;
  return w > 0 && h > 0 ? { x: x0, y: y0, w, h } : undefined;
}

/**
 * Vision-path reconstruction. Prefers OpenCV's real, tiled geometry when the
 * detector found rooms (positions match the image + rooms share walls),
 * calibrated to feet by the building footprint against Gemini's printed overall
 * dimensions. Falls back to a pure-Gemini layout when OpenCV came up short.
 */
function buildFromSemantic(input: MergeInput): MergeOutput {
  const { geometry: g, semantic } = input;
  // Semantic-first footprint: the union of the DETECTED ROOM boxes ≈ the real
  // building interior. Prefer it over the raw wall-pixel buildingBox, which gets
  // inflated by the dimension lines / borders / title-block around the plan —
  // that inflation oversized the envelope AND pushed every room into one corner
  // (the "floating blocks" bug). Both the envelope sizing and the room→feet
  // mapping below use this bb, so the rooms now fill the footprint instead of
  // clustering. Falls back to the wall-pixel box when too few rooms were found.
  // The transform anchor. For the pink style the detector's buildingBox IS
  // the wall band's tight extent (pixel-true, no dimension-line inflation), so
  // prefer it — the union of room boxes under-counts whenever a service area
  // (stair/lift block) has no labelled room, which narrowed the envelope and
  // forced trims on the outermost rooms. Other styles keep the union-first
  // behaviour that guards against inflated wall-pixel boxes.
  const bb =
    (g.style === "pink" ? g.buildingBox : undefined) ??
    unionRoomBox(g.rooms) ??
    g.buildingBox;

  // Rooms Gemini both SIZED and POSITIONED — the dimension-driven layout.
  const positioned = semantic.rooms.filter(
    (r) => r.widthFt && r.heightFt && r.xFt !== undefined && r.yFt !== undefined,
  );


  // OpenCV UNDER-SEGMENTED = it found meaningfully fewer rooms than Gemini
  // positioned (or none). Two ways this happens:
  //   • dense multi-unit floor (30-60 rooms) the detector can't fully split, and
  //   • a single-unit colour-CAD plan the CONTOUR detector collapses into one
  //     blob + a couple slivers (3 boxes vs Gemini's 6 → the "1 giant LIVING &
  //     DINNING" reconstruction).
  // In BOTH cases OpenCV's boxes are too few to tile from, and its box-area
  // scale is meaningless (it inflates the envelope). So size the envelope from
  // Gemini's PRINTED overall dimensions and place rooms at Gemini's own read
  // positions. When the detector DID find the rooms, fall through to the
  // original, better-tuned footprint path so those plans don't regress.
  const cvUnderSegmented =
    positioned.length >= 3 && (!bb || g.rooms.length < Math.ceil(positioned.length * 0.7));
  if (cvUnderSegmented && semantic.overallWidthFt && semantic.overallHeightFt) {
    let planWidth = Math.max(8, r1(semantic.overallWidthFt));
    let planHeight = Math.max(8, r1(semantic.overallHeightFt));
    if (input.longestSideFt && input.longestSideFt > 0) {
      const k = input.longestSideFt / (Math.max(planWidth, planHeight) || 1);
      planWidth = Math.max(8, r1(planWidth * k));
      planHeight = Math.max(8, r1(planHeight * k));
    }
    return buildFromSemanticOnly(input, planWidth, planHeight);
  }

  // ORIGINAL path (single-unit plans): ISOTROPIC footprint envelope — the
  // detected footprint's true ASPECT (bb.w/bb.h), scaled by the room areas when
  // OpenCV found rooms, else by Gemini's overall dims. planWidth/Height are both
  // bb×fpp so the aspect is always the footprint's (a near-square Gemini envelope
  // would fail the aspect check + stretch rooms). Geometry tiling when OpenCV
  // found rooms; semantic placement otherwise. User calibration wins.
  let planWidth: number;
  let planHeight: number;
  if (bb && bb.w > 0 && bb.h > 0) {
    const sumFt = semantic.rooms.reduce(
      (s, r) => s + (r.widthFt && r.heightFt ? r.widthFt * r.heightFt : 0),
      0,
    );
    const sumPx = g.rooms.reduce((s, b) => s + Math.max(0, b.w) * Math.max(0, b.h), 0);
    const oW = semantic.overallWidthFt ?? 0;
    const oH = semantic.overallHeightFt ?? 0;
    const bbLongPx = Math.max(bb.w, bb.h);
    const bbAreaPx = bb.w * bb.h;

    // The envelope ALWAYS uses the footprint's true aspect (planW = bb.w*fpp,
    // planH = bb.h*fpp); only the feet-per-pixel SCALE is in question. Gather
    // candidate scales from both signals: Gemini's printed overall dims (the
    // outer "27' / 57'" chain) and the room-area ratio. Either can be wrong —
    // Gemini may misread the chain; OpenCV may erode/miss room boxes, which
    // inflates the room-area scale ~2× (the 58×111 / 18%-coverage bug). So pick
    // the scale that yields a BELIEVABLE room coverage (~60% of the envelope),
    // which rejects both a scattered-blocks scale (coverage too low) and an
    // overlap-forcing one (too high). User calibration always wins.
    let fpp: number;
    const cChain = oW > 0 && oH > 0 ? Math.max(oW, oH) / bbLongPx : 0;
    const covChain = cChain > 0 && sumFt > 0 ? sumFt / (bbAreaPx * cChain * cChain) : 0;
    if (input.longestSideFt && input.longestSideFt > 0) {
      fpp = input.longestSideFt / bbLongPx;
    } else if (g.scaleFtPerPx && g.scaleFtPerPx > 0) {
      // The detector read the plan's printed dimensions LOCALLY and measured
      // feet-per-pixel directly — the most accurate scale available.
      fpp = g.scaleFtPerPx;
    } else if (cChain > 0 && (sumFt === 0 || (covChain >= 0.35 && covChain <= 1.15))) {
      // Printed overall dimensions against the DETECTED footprint. Whenever the
      // implied room coverage is believable this IS the scale — the old
      // 0.6-coverage-target scoring below penalised tightly-packed plans (real
      // coverage ≈0.95) and picked the eroded box-area scale instead, blowing a
      // 40 ft plan up to a 70 ft envelope and scattering the tiled rooms.
      fpp = cChain;
    } else {
      const candidates: number[] = [];
      if (cChain > 0) candidates.push(cChain);
      if (sumFt > 0 && sumPx > 0) candidates.push(Math.sqrt(sumFt / sumPx));
      if (oW > 0) candidates.push(oW / bb.w);
      if (oH > 0) candidates.push(oH / bb.h);

      const TARGET = 0.6; // healthy share of the envelope filled by rooms
      fpp = candidates[0] ?? (oW > 0 ? oW / bb.w : 1);
      if (sumFt > 0 && candidates.length) {
        let best = Infinity;
        for (const c of candidates) {
          if (!(c > 0)) continue;
          const coverage = sumFt / (bbAreaPx * c * c);
          // penalise scales that would force overlaps (coverage well over 100%)
          const penalty = coverage > 0.95 ? (coverage - 0.95) * 2 : 0;
          const score = Math.abs(coverage - TARGET) + penalty;
          if (score < best) {
            best = score;
            fpp = c;
          }
        }
      }
    }
    planWidth = Math.max(8, r1(bb.w * fpp));
    planHeight = Math.max(8, r1(bb.h * fpp));
  } else {
    planWidth = Math.max(8, r1(semantic.overallWidthFt!));
    planHeight = Math.max(8, r1(semantic.overallHeightFt!));
  }

  // SANITY-CHECK the CV-derived envelope against Gemini's PRINTED overall dims.
  // When the detector's boxes are eroded/partial, the area-ratio scale can be
  // badly wrong (e.g. 70 ft tall for a 40 ft plan), which then rotates and
  // scatters the tiled rooms. The printed dimensions are ground truth, so when
  // the two disagree by more than a third the tiling is untrustworthy: rebuild
  // from Gemini's own dimensioned layout at its stated size. Skipped when the
  // envelope already came from the printed-area × wall-footprint estimate
  // (that one OUTRANKS Gemini's overall read) or from user calibration.
  const gOW = semantic.overallWidthFt ?? 0;
  const gOH = semantic.overallHeightFt ?? 0;
  const userCalibrated = !!(input.longestSideFt && input.longestSideFt > 0);
  if (gOW > 0 && gOH > 0 && !userCalibrated && positioned.length >= 3) {
    const gLong = Math.max(gOW, gOH);
    const pLong = Math.max(planWidth, planHeight);
    if (pLong > 0 && Math.abs(pLong - gLong) / gLong > 0.35) {
      return buildFromSemanticOnly(input, Math.max(8, r1(gOW)), Math.max(8, r1(gOH)));
    }
  }

  const sx = bb && bb.w > 0 ? planWidth / bb.w : 0;
  const sy = bb && bb.h > 0 ? planHeight / bb.h : 0;
  // Tile the OpenCV boxes ONLY when the detector found roughly as many rooms as
  // Gemini did — then its real, wall-sharing positions are worth using. When the
  // detector UNDER-segments (e.g. the contour detector collapses a colour-CAD
  // plan into one blob + slivers = 3 boxes while Gemini reads 6 rooms), tiling
  // those few boxes throws Gemini's complete layout away and reconstructs a
  // giant room + slivers. In that case place the rooms at Gemini's own read
  // positions instead. `positioned` = Gemini rooms with both a size and a box.
  const cvCoversRooms = g.rooms.length >= Math.max(2, Math.ceil(positioned.length * 0.7));
  if (cvCoversRooms && bb && sx > 0 && sy > 0) {
    return buildFromGeometry(input, planWidth, planHeight, bb, sx, sy);
  }
  return buildFromSemanticOnly(input, planWidth, planHeight);
}

/**
 * Geometry-first: tile the plan from OpenCV's detected room boxes (real
 * positions that share walls), labelled by Gemini and sized from the printed
 * dimensions. Walls are the detected walls plus the outer envelope; openings
 * come from Gemini's vision read, falling back to the detector's real gaps.
 */
function buildFromGeometry(
  input: MergeInput,
  planWidth: number,
  planHeight: number,
  bb: NonNullable<OpenCvResult["buildingBox"]>,
  sx: number,
  sy: number,
): MergeOutput {
  const { geometry: g, semantic } = input;

  // px (full image) → ft, with the plan origin at the building's top-left.
  const fx = (px: number) => clampN(r1((px - bb.x) * sx), 0, planWidth);
  const fy = (py: number) => clampN(r1((py - bb.y) * sy), 0, planHeight);

  // Detected room boxes → feet rectangles (real positions, already tiled).
  const roomBoxes: RoomBox[] = g.rooms.map((b, i) => {
    const x = fx(b.x);
    const y = fy(b.y);
    return {
      index: i,
      x,
      y,
      width: Math.max(2, Math.min(r1(b.w * sx), r1(planWidth - x))),
      height: Math.max(2, Math.min(r1(b.h * sy), r1(planHeight - y))),
    };
  });

  // Gemini names/types onto the boxes by SPATIAL position (vision rooms carry
  // xFt/yFt) — robust when detected boxes are similar in size.
  const assignments = assignRoomsByPosition(roomBoxes, semantic);
  let roomsNamed = 0;
  const kx = semantic.overallWidthFt && semantic.overallWidthFt > 0 ? planWidth / semantic.overallWidthFt : 1;
  const ky = semantic.overallHeightFt && semantic.overallHeightFt > 0 ? planHeight / semantic.overallHeightFt : 1;
  const rooms: Room[] = roomBoxes.map((b, i) => {
    const sem = assignments[i];
    const detected = g.rooms[b.index];
    if (sem || detected?.name) roomsNamed++;
    // Prefer the printed size (more accurate than eroded pixel boxes), anchored
    // at the detected position — Gemini's read first, then the dimension text
    // the labeled detector read locally off the plan. The snap/separate passes
    // below re-close gaps the size swap can open, keeping the layout tiled.
    // Keep the DETECTED box's orientation though: Gemini sometimes reads a
    // "22 x 6" label in the wrong order, which would render a wide balcony as
    // a tall stretched strip — so if the printed aspect is inverted vs the
    // detected box, swap width/height.
    const printedW = sem?.widthFt ?? detected?.widthFt;
    const printedH = sem?.heightFt ?? detected?.heightFt;
    let pw = printedW ? r1(printedW) : b.width;
    let ph = printedH ? r1(printedH) : b.height;
    // Only correct a clearly ELONGATED room (balcony / corridor) whose detected
    // box unambiguously disagrees on orientation — detected boxes are noisy, so
    // never transpose a near-square room (that would distort a correct layout).
    // And never swap into a size that can't physically fit the envelope: an
    // under-claimed watershed box must not flip a 9.5×30 living room onto its
    // side inside a 20 ft-wide plan.
    if (printedW && printedH && b.width > 0 && b.height > 0) {
      const orientDiffers = (b.width >= b.height) !== (pw >= ph);
      const printElong = Math.max(pw, ph) / Math.min(pw, ph);
      const boxElong = Math.max(b.width, b.height) / Math.min(b.width, b.height);
      const swappedFits = ph <= planWidth + 0.5 && pw <= planHeight + 0.5;
      if (orientDiffers && printElong >= 1.6 && boxElong >= 1.3 && swappedFits) {
        [pw, ph] = [ph, pw];
      }
    }
    const width = Math.max(2, Math.min(pw, planWidth));
    const height = Math.max(2, Math.min(ph, planHeight));
    // Position source: the detected box — UNLESS its area wildly disagrees
    // with the printed size (>2.5× either way). Such a box captured only a
    // FRAGMENT of the room (an under-claimed watershed region), and marrying
    // the full printed size to a fragment's corner collides with the
    // neighbours and gets the room trimmed. Gemini's own read position is the
    // honest anchor for those.
    let px = b.x;
    let py = b.y;
    if (printedW && printedH && sem && sem.xFt !== undefined && sem.yFt !== undefined) {
      const boxArea = Math.max(0.1, b.width * b.height);
      const ratio = (printedW * printedH) / boxArea;
      if (ratio > 2.5 || ratio < 0.4) {
        px = r1(sem.xFt * kx);
        py = r1(sem.yFt * ky);
      }
    }
    return {
      id: `room_${i}`,
      name: sem?.name ?? detected?.name ?? `Room ${i + 1}`,
      type: sem?.type ?? detected?.type,
      x: clampN(px, 0, r1(planWidth - width)),
      y: clampN(py, 0, r1(planHeight - height)),
      width,
      height,
      color: ROOM_PALETTE[i % ROOM_PALETTE.length],
    };
  });

  // NEVER lose a labelled room: any room Gemini both sized and positioned that
  // no detected box matched (the detector lost its region — a leaked watershed
  // or an unlabeled shaft) is appended at its semantic position, mapped into
  // plan space. The compact/snap/separate passes below then tile it in.
  const usedSem = new Set(assignments.filter((a): a is SemanticRoomLike => !!a));
  for (const sem of semantic.rooms) {
    if (usedSem.has(sem) || !sem.widthFt || !sem.heightFt || sem.xFt === undefined || sem.yFt === undefined) {
      continue;
    }
    const width = Math.max(2, Math.min(r1(sem.widthFt), planWidth));
    const height = Math.max(2, Math.min(r1(sem.heightFt), planHeight));
    const i = rooms.length;
    rooms.push({
      id: `room_${i}`,
      name: sem.name,
      type: sem.type,
      x: clampN(r1(sem.xFt * kx), 0, r1(planWidth - width)),
      y: clampN(r1(sem.yFt * ky), 0, r1(planHeight - height)),
      width,
      height,
      color: ROOM_PALETTE[i % ROOM_PALETTE.length],
    });
    assignments.push(sem);
    roomsNamed++;
  }

  // Close gaps the printed-size swap opened: pull rooms that Gemini says share a
  // wall flush against each other (bounded, overlap-guarded), THEN align shared
  // walls onto common gridlines, push apart any overlap, and trim any residual.
  // `assignments[i]` is the semantic room for rooms[i], so its adjacency aligns.
  compactByAdjacency(rooms, assignments.map((a) => a?.adjacentTo), planWidth, planHeight);
  snapToGrid(rooms, planWidth, planHeight);
  separateOverlaps(rooms, planWidth, planHeight);
  trimResidualOverlaps(rooms, planWidth, planHeight);

  // Pair each merged room with its semantic room (same index) so furniture lands
  // at the right relative spot inside it.
  const semRooms = rooms
    .map((room, i) => ({ sem: assignments[i], room }))
    .filter((p): p is { sem: SemanticRoomLike; room: Room } => !!p.sem);

  const scale = (sx + sy) / 2;
  const wallFt =
    g.wallThicknessPx && scale > 0
      ? Math.min(1.2, Math.max(0.3, r1(g.wallThicknessPx * scale)))
      : 0.5;

  // Real detected walls (scaled) + the outer building envelope.
  const walls: Wall[] = g.walls.map((w, i) => ({
    id: `wall_${i}`,
    x1: fx(w.x1),
    y1: fy(w.y1),
    x2: fx(w.x2),
    y2: fy(w.y2),
    thickness: wallFt,
  }));
  walls.push(...envelopeWalls(planWidth, planHeight, wallFt, walls.length));

  // Openings: the DETECTOR's symbol-level read first — its doors/windows are
  // snapped to the drawn wall gaps and black window frames (pixel-accurate),
  // while Gemini's boxes carry ±1-2% grid jitter and duplicate symbols.
  // DOORS are unioned: any door Gemini saw that is nowhere near a detected one
  // is appended (the detector can lose a door when its wall gets pruned), so
  // the set stays complete with pixel accuracy where available. WINDOWS stay
  // detector-only when present — Gemini duplicates window symbols heavily.
  const cvDoors: Door[] = g.doors.map((d, i) => ({
    id: `door_${i}`,
    x: fx(d.x),
    y: fy(d.y),
    orientation: d.orientation,
  }));
  const extraDoors = toDoors(semantic.doors, planWidth, planHeight).filter(
    (d) => !cvDoors.some((c) => Math.hypot(c.x - d.x, c.y - d.y) < 4),
  );
  const doors: Door[] = [...cvDoors, ...extraDoors].map((d, i) => ({ ...d, id: `door_${i}` }));
  const windows: Window[] = g.windows.length
    ? g.windows.map((w, i) => ({
        id: `win_${i}`,
        x: fx(w.x),
        y: fy(w.y),
        orientation: w.orientation,
        length: Math.max(1, r1(w.length * (w.orientation === "h" ? sx : sy))),
      }))
    : toWindows(semantic.windows, planWidth, planHeight);

  g.scale = scale;
  g.confidence = Math.max(g.confidence, 0.8);

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms,
    doors,
    walls,
    windows,
    meta: {
      source: "merged",
      confidence: g.confidence,
      detectedAt: new Date().toISOString(),
      roomsNamed,
    },
  };
  return {
    plan,
    scale,
    calibrated: true,
    roomsNamed,
    items: toPlacedItems(semantic.furniture, rooms, semRooms, planWidth, planHeight),
  };
}

/**
 * Pure-Gemini fallback (OpenCV found < 2 rooms): place rooms at their read feet
 * positions/sizes, synthesize walls from the rectangles, and use the openings
 * Gemini read. Lower fidelity than geometry-first, but honest when the detector
 * can't segment the plan.
 */
function buildFromSemanticOnly(
  input: MergeInput,
  planWidth: number,
  planHeight: number,
): MergeOutput {
  const { geometry: g, semantic } = input;

  const positioned = semantic.rooms.filter(
    (r) => r.widthFt && r.heightFt && r.xFt !== undefined && r.yFt !== undefined,
  );

  const rooms: Room[] = positioned.map((r, i) => {
    const width = Math.max(2, Math.min(r1(r.widthFt!), planWidth));
    const height = Math.max(2, Math.min(r1(r.heightFt!), planHeight));
    const x = Math.min(Math.max(0, r1(r.xFt!)), r1(planWidth - width));
    const y = Math.min(Math.max(0, r1(r.yFt!)), r1(planHeight - height));
    return {
      id: `room_${i}`,
      name: r.name,
      type: r.type,
      x,
      y,
      width,
      height,
      color: ROOM_PALETTE[i % ROOM_PALETTE.length],
    };
  });

  // Clean the layout (positions only — printed sizes stay exact), then trim any
  // pair too large to separate by moving so the result is overlap-free. Here
  // rooms[i] is built directly from positioned[i], so adjacency aligns by index.
  compactByAdjacency(rooms, positioned.map((p) => p.adjacentTo), planWidth, planHeight);
  snapToGrid(rooms, planWidth, planHeight);
  separateOverlaps(rooms, planWidth, planHeight);
  trimResidualOverlaps(rooms, planWidth, planHeight);

  // Each merged room maps 1:1 to its semantic room (built from positioned[i]).
  const semRooms = rooms.map((room, i) => ({ sem: positioned[i], room }));

  const footprintPx = g.buildingBox?.w && g.buildingBox.w > 0 ? g.buildingBox.w : g.imageWidth;
  const scale = footprintPx > 0 ? r1(planWidth / footprintPx) : 0;
  g.scale = scale;
  g.confidence = Math.max(g.confidence, 0.85);

  const wallFt =
    g.wallThicknessPx && scale > 0 ? Math.min(1.2, Math.max(0.3, r1(g.wallThicknessPx * scale))) : 0.5;
  const walls = roomsToWalls(rooms, wallFt);

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms,
    doors: toDoors(semantic.doors, planWidth, planHeight),
    windows: toWindows(semantic.windows, planWidth, planHeight),
    walls,
    meta: {
      source: "merged",
      confidence: g.confidence,
      detectedAt: new Date().toISOString(),
      roomsNamed: rooms.length,
    },
  };

  return {
    plan,
    scale,
    calibrated: true,
    roomsNamed: rooms.length,
    items: toPlacedItems(semantic.furniture, rooms, semRooms, planWidth, planHeight),
  };
}

/** The four outer envelope wall segments (feet), ids continuing from `start`. */
function envelopeWalls(W: number, H: number, thickness: number, start: number): Wall[] {
  let i = start;
  return [
    { id: `wall_${i++}`, x1: 0, y1: 0, x2: W, y2: 0, thickness },
    { id: `wall_${i++}`, x1: 0, y1: H, x2: W, y2: H, thickness },
    { id: `wall_${i++}`, x1: 0, y1: 0, x2: 0, y2: H, thickness },
    { id: `wall_${i++}`, x1: W, y1: 0, x2: W, y2: H, thickness },
  ];
}

/** Gemini openings (already in feet) → domain doors, clamped to the envelope. */
function toDoors(list: SemanticOpening[] | undefined, W: number, H: number): Door[] {
  return (list ?? []).map((d, i) => ({
    id: `door_${i}`,
    x: clampN(r1(d.xFt), 0, W),
    y: clampN(r1(d.yFt), 0, H),
    orientation: d.orientation,
  }));
}

/** Gemini openings (already in feet) → domain windows, clamped to the envelope. */
function toWindows(list: SemanticOpening[] | undefined, W: number, H: number): Window[] {
  return (list ?? []).map((w, i) => ({
    id: `win_${i}`,
    x: clampN(r1(w.xFt), 0, W),
    y: clampN(r1(w.yFt), 0, H),
    orientation: w.orientation,
    length: Math.max(1, r1(w.lengthFt ?? 3)),
  }));
}

/**
 * Slide rooms that share a wall (Gemini's adjacency graph) toward each other to
 * close gaps, keeping every room's exact size. Bounded relaxation with an
 * overlap guard, so it can never create overlaps or push a room out of bounds.
 */
function compactByAdjacency(
  rooms: Room[],
  /** adjacency names per room, ALIGNED with `rooms` (adjacency[i] is for rooms[i]) */
  adjacency: (string[] | undefined)[],
  planWidth: number,
  planHeight: number,
): void {
  // Resolve adjacency (by room name) into index pairs; for duplicate names
  // (e.g. two "ATM"s) pick the nearest room.
  const byName = new Map<string, number[]>();
  rooms.forEach((r, i) => {
    const arr = byName.get(r.name);
    if (arr) arr.push(i);
    else byName.set(r.name, [i]);
  });

  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  rooms.forEach((_, i) => {
    for (const name of adjacency[i] ?? []) {
      const cands = byName.get(name.trim());
      if (!cands?.length) continue;
      const j = cands.reduce(
        (best, c) =>
          centerDist(rooms[i], rooms[c]) < centerDist(rooms[i], rooms[best]) ? c : best,
        cands[0],
      );
      if (j === i) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([i, j]);
    }
  });
  if (!pairs.length) return;

  const MAX_PULL = 8; // ft — ignore "adjacencies" that are implausibly far apart
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (const [i, j] of pairs) {
      const a = rooms[i];
      const b = rooms[j];
      const oy = span(a.y, a.y + a.height, b.y, b.y + b.height);
      const ox = span(a.x, a.x + a.width, b.x, b.x + b.width);
      if (oy > 1 && ox <= 0.1) {
        // horizontal neighbours — close the X gap from both sides
        const [L, R] = a.x <= b.x ? [a, b] : [b, a];
        const gap = R.x - (L.x + L.width);
        if (gap > 0.1 && gap <= MAX_PULL) {
          const d = gap / 2;
          if (
            tryShift(rooms, L, d, 0, planWidth, planHeight) &&
            tryShift(rooms, R, -d, 0, planWidth, planHeight)
          )
            moved = true;
        }
      } else if (ox > 1 && oy <= 0.1) {
        // vertical neighbours — close the Y gap from both sides
        const [T, B] = a.y <= b.y ? [a, b] : [b, a];
        const gap = B.y - (T.y + T.height);
        if (gap > 0.1 && gap <= MAX_PULL) {
          const d = gap / 2;
          if (
            tryShift(rooms, T, 0, d, planWidth, planHeight) &&
            tryShift(rooms, B, 0, -d, planWidth, planHeight)
          )
            moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Push overlapping rooms apart along their axis of least overlap until none
 * overlap (positions only — sizes never change). Bounded relaxation, clamped to
 * the plan envelope.
 */
function separateOverlaps(rooms: Room[], planWidth: number, planHeight: number): void {
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const ox = span(a.x, a.x + a.width, b.x, b.x + b.width);
        const oy = span(a.y, a.y + a.height, b.y, b.y + b.height);
        if (ox > 0.1 && oy > 0.1) {
          if (ox <= oy) {
            const shift = ox / 2 + 0.05;
            const [lo, hi] = a.x <= b.x ? [a, b] : [b, a];
            lo.x = Math.max(0, r1(lo.x - shift));
            hi.x = Math.min(r1(planWidth - hi.width), r1(hi.x + shift));
          } else {
            const shift = oy / 2 + 0.05;
            const [lo, hi] = a.y <= b.y ? [a, b] : [b, a];
            lo.y = Math.max(0, r1(lo.y - shift));
            hi.y = Math.min(r1(planHeight - hi.height), r1(hi.y + shift));
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Last-resort overlap removal. The room's PRINTED size is sacred and its
 * position is the estimate — so first try to SLIDE the smaller room clear of
 * the overlap (either axis, overlap-guarded, in-bounds); only when no slide
 * resolves it is the smaller room trimmed by the minimum needed. Without the
 * slide-first step a position error of a few feet was amputating rooms (a
 * 13.5 ft kitchen cut to 9 ft) while both printed sizes were correct.
 */
function trimResidualOverlaps(rooms: Room[], planWidth: number, planHeight: number): void {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const ox = span(a.x, a.x + a.width, b.x, b.x + b.width);
        const oy = span(a.y, a.y + a.height, b.y, b.y + b.height);
        // Match analyzePlan's overlap test (area > 0.5 sq ft) so thin slivers —
        // tiny on one axis, long on the other — are trimmed too, not skipped.
        if (ox <= 0 || oy <= 0 || ox * oy <= 0.5) continue;
        const small = a.width * a.height <= b.width * b.height ? a : b;
        const big = small === a ? b : a;

        // Slide the smaller room out of the overlap, least-overlap axis first.
        const sxDir = small.x + small.width / 2 >= big.x + big.width / 2 ? 1 : -1;
        const syDir = small.y + small.height / 2 >= big.y + big.height / 2 ? 1 : -1;
        const moves: [number, number][] =
          ox <= oy
            ? [[sxDir * (ox + 0.1), 0], [0, syDir * (oy + 0.1)]]
            : [[0, syDir * (oy + 0.1)], [sxDir * (ox + 0.1), 0]];
        let slid = false;
        for (const [dx, dy] of moves) {
          if (tryShift(rooms, small, dx, dy, planWidth, planHeight)) {
            slid = true;
            break;
          }
        }
        if (slid) {
          changed = true;
          continue;
        }

        if (ox <= oy) {
          if (small.x > big.x) small.x = r1(small.x + ox + 0.1); // pull the left edge in
          small.width = Math.max(2, r1(small.width - ox - 0.1));
        } else {
          if (small.y > big.y) small.y = r1(small.y + oy + 0.1); // pull the top edge in
          small.height = Math.max(2, r1(small.height - oy - 0.1));
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Overlap length of two 1-D intervals (negative when they don't overlap). */
function span(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function centerDist(a: Room, b: Room): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/** Move a room by (dx,dy) within bounds; revert if it overlaps another room. */
function tryShift(
  rooms: Room[],
  room: Room,
  dx: number,
  dy: number,
  planWidth: number,
  planHeight: number,
): boolean {
  const nx = Math.max(0, Math.min(r1(room.x + dx), r1(planWidth - room.width)));
  const ny = Math.max(0, Math.min(r1(room.y + dy), r1(planHeight - room.height)));
  if (nx === room.x && ny === room.y) return false;
  const ox = room.x;
  const oy = room.y;
  room.x = nx;
  room.y = ny;
  for (const other of rooms) {
    if (other === room) continue;
    const sx = span(room.x, room.x + room.width, other.x, other.x + other.width);
    const sy = span(room.y, room.y + room.height, other.y, other.y + other.height);
    if (sx > 0.1 && sy > 0.1) {
      room.x = ox;
      room.y = oy;
      return false;
    }
  }
  return true;
}

/**
 * Snap each room's top-left corner onto shared gridlines (clusters of all room
 * edges within a tolerance). Aligns rooms that should share a wall and closes
 * sub-tolerance gaps, while preserving each room's printed width/height. A
 * room's right/bottom is derived from its size, so sizes never change.
 */
function snapToGrid(rooms: Room[], planWidth: number, planHeight: number, tol = 1.2): void {
  const xLines = gridlines(rooms.flatMap((r) => [r.x, r1(r.x + r.width)]), tol);
  const yLines = gridlines(rooms.flatMap((r) => [r.y, r1(r.y + r.height)]), tol);
  for (const r of rooms) {
    r.x = Math.min(snapToNearest(r.x, xLines, tol), r1(planWidth - r.width));
    r.y = Math.min(snapToNearest(r.y, yLines, tol), r1(planHeight - r.height));
    if (r.x < 0) r.x = 0;
    if (r.y < 0) r.y = 0;
  }
}

/** Cluster sorted values within `tol` into representative gridlines (centroids). */
function gridlines(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lines: number[] = [];
  let cluster: number[] = [];
  for (const v of sorted) {
    if (cluster.length && v - cluster[cluster.length - 1] > tol) {
      lines.push(r1(cluster.reduce((s, x) => s + x, 0) / cluster.length));
      cluster = [];
    }
    cluster.push(v);
  }
  if (cluster.length) lines.push(r1(cluster.reduce((s, x) => s + x, 0) / cluster.length));
  return lines;
}

function snapToNearest(v: number, lines: number[], tol: number): number {
  let best = v;
  let bestD = tol;
  for (const l of lines) {
    const d = Math.abs(l - v);
    if (d <= bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

/** Perimeter wall segments (in feet) around each room rectangle. */
function roomsToWalls(rooms: Room[], thickness = 0.5): Wall[] {
  const walls: Wall[] = [];
  let i = 0;
  for (const r of rooms) {
    const x2 = r1(r.x + r.width);
    const y2 = r1(r.y + r.height);
    walls.push({ id: `wall_${i++}`, x1: r.x, y1: r.y, x2, y2: r.y, thickness });
    walls.push({ id: `wall_${i++}`, x1: r.x, y1: y2, x2, y2, thickness });
    walls.push({ id: `wall_${i++}`, x1: r.x, y1: r.y, x2: r.x, y2, thickness });
    walls.push({ id: `wall_${i++}`, x1: x2, y1: r.y, x2, y2, thickness });
  }
  return walls;
}

/**
 * Label detected boxes by SPATIAL match to Gemini's read positions: vision rooms
 * carry xFt/yFt, so assign by nearest centre (global-greedy: shortest pairs
 * first). This keeps names on the right box even when the eroded detection boxes
 * are all similar in size. Falls back to area-based matching without positions.
 */
function assignRoomsByPosition(
  boxes: RoomBox[],
  semantic: SemanticPlan,
): (SemanticRoomLike | undefined)[] {
  const sem = semantic.rooms;
  const result: (SemanticRoomLike | undefined)[] = new Array(boxes.length).fill(undefined);
  if (!sem.some((r) => r.xFt !== undefined && r.yFt !== undefined)) {
    return assignRooms(boxes, semantic);
  }

  const pairs: { bi: number; si: number; d: number }[] = [];
  boxes.forEach((b, bi) => {
    const bcx = b.x + b.width / 2;
    const bcy = b.y + b.height / 2;
    sem.forEach((r, si) => {
      if (r.xFt === undefined || r.yFt === undefined) return;
      const scx = r.xFt + (r.widthFt ?? 0) / 2;
      const scy = r.yFt + (r.heightFt ?? 0) / 2;
      pairs.push({ bi, si, d: Math.hypot(bcx - scx, bcy - scy) });
    });
  });
  pairs.sort((a, b) => a.d - b.d);

  const usedBox = new Set<number>();
  const usedSem = new Set<number>();
  for (const { bi, si } of pairs) {
    if (usedBox.has(bi) || usedSem.has(si)) continue;
    result[bi] = sem[si];
    usedBox.add(bi);
    usedSem.add(si);
  }
  return result;
}

/**
 * Greedy match: for each detected box (in reading order, top→bottom then
 * left→right) pick the best unused Gemini room. When the room carries
 * dimensions, prefer the box whose feet footprint is closest in area;
 * otherwise the next unused room is taken, preserving reading order.
 */
function assignRooms(
  boxes: RoomBox[],
  semantic: SemanticPlan,
): (SemanticRoomLike | undefined)[] {
  const sem = semantic.rooms;
  const result: (SemanticRoomLike | undefined)[] = new Array(boxes.length).fill(undefined);
  if (sem.length === 0) return result;

  const order = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set<number>();

  for (const box of order) {
    let pick = -1;
    let bestScore = Infinity;
    for (let s = 0; s < sem.length; s++) {
      if (used.has(s)) continue;
      const room = sem[s];
      // Dimension-aware score when possible; neutral 0 (→ reading order) else.
      let score = 0;
      if (room.widthFt && room.heightFt) {
        const boxArea = box.width * box.height;
        const semArea = room.widthFt * room.heightFt;
        score = Math.abs(boxArea - semArea) / Math.max(boxArea, semArea, 1);
      }
      if (score < bestScore) {
        bestScore = score;
        pick = s;
      }
    }
    if (pick >= 0) {
      used.add(pick);
      result[box.index] = sem[pick];
    }
  }
  return result;
}
