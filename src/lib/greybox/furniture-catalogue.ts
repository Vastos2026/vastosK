import * as THREE from "three";

/**
 * Procedural furniture PROXY shapes — flat grey three.js primitives (boxes,
 * cylinders, spheres) handed to the greybox scene so the image model can see
 * roughly where furniture goes, without implying any material, colour, or
 * style (that's the generation prompt's job) and WITHOUT ever rendering text
 * (a box labelled "SOFA" risks the image model literally painting that word
 * onto a cushion in the final photo) — no GLTF/asset files, no textures, no
 * text geometry or sprites, ever.
 *
 * Conventions copied from build-scene.ts: Y-up, floor at y=0, all dimensions
 * in FEET, flat MeshStandardMaterial with roughness 1 (no metalness, no
 * shine), muted greys in the same tonal family as the room shell
 * (WALL_COLOR/FLOOR_COLOR/CEIL_COLOR/REVEAL_COLOR). Each entry's `build()`
 * returns a fresh Group centred on its own local origin at floor level
 * (y=0 at the object's bottom), facing +Z as its "front" — whoever places
 * the group in the scene applies position + a Y rotation.
 */

// Furniture sits deliberately low on the value ladder — 28-35% luma, well
// clear of the door filler's ~49% — so a wardrobe or dresser proxy is never
// mistaken for a door panel (a real, observed failure mode). Distinct enough
// from walls/floor to read as separate objects, but never implying a real
// material or colour. (build-scene.ts's shell palette: 0xb0b0b0 wall /
// 0x9c9c9c floor / 0xc4c4c4 ceiling / 0x6e6e6e reveal.)
const FRAME_COLOR = 0x585858; // frames/legs/carcasses — mid-dark grey
const SEAT_COLOR = 0x484848; // seats/mattresses/cushioned surfaces — darker grey
const RUG_COLOR = 0x8a8a8a; // lighter than the furniture greys so a rug still reads as a distinct object
const FOLIAGE_COLOR = 0x6b7d6b; // plant foliage — the one deliberate, faint hint of green-grey so leaves don't read as a stray grey box

function frameMat() {
  return new THREE.MeshStandardMaterial({ color: FRAME_COLOR, roughness: 1 });
}
function seatMat() {
  return new THREE.MeshStandardMaterial({ color: SEAT_COLOR, roughness: 1 });
}
function rugMat() {
  return new THREE.MeshStandardMaterial({ color: RUG_COLOR, roughness: 1 });
}
function foliageMat() {
  return new THREE.MeshStandardMaterial({ color: FOLIAGE_COLOR, roughness: 1 });
}

/** Adds a box mesh whose local origin is at the CENTRE of its bottom face. */
function addBox(
  group: THREE.Group,
  material: THREE.Material,
  w: number,
  h: number,
  d: number,
  cx: number,
  yBottom: number,
  cz: number,
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(cx, yBottom + h / 2, cz);
  group.add(mesh);
  return mesh;
}

/** Adds a cylinder mesh whose local origin is at the CENTRE of its bottom face. */
function addCylinder(
  group: THREE.Group,
  material: THREE.Material,
  radiusTop: number,
  radiusBottom: number,
  h: number,
  cx: number,
  yBottom: number,
  cz: number,
) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, h, 16), material);
  mesh.position.set(cx, yBottom + h / 2, cz);
  group.add(mesh);
  return mesh;
}

export interface FurnitureCatalogueEntry {
  /** Stable key, e.g. "bed", "sofa", "nightstand". */
  kind: string;
  /** Human-readable, e.g. "Bed", "Sofa". */
  label: string;
  /** Approximate floor footprint in feet, for the editor's default spacing. */
  footprintFt: { w: number; d: number };
  /** Which room-type strings this item is offered for. */
  roomTypes: string[];
  /** Returns a new Group, centred at its own local origin, floor at y=0, facing +Z. */
  build(): THREE.Group;
  /**
   * What this item is MADE OF, never where it is. Section 2.5: once furniture
   * is in the render, the render is the single source of spatial truth, and
   * positional prose creates a second source that can disagree with it.
   * {wood}/{soft}/{stone} interpolate from the design brief so the line
   * inherits the palette rather than restating it.
   */
  materialPhrase: string;
  /**
   * Used when more than one of this type is placed (e.g. two nightstands). Falls back to
   * materialPhrase when absent — most entries don't need one because duplicates are either
   * implausible (a second bed, a second kitchen island) or the singular phrase already reads
   * fine repeated implicitly. Fixed, hand-written text, not a pluralisation algorithm: this is a
   * 24-entry catalogue, not a grammar engine, and "add an s" breaks entries like `rug` ("a soft
   * neutral rug" -> "a soft neutral rugs") that don't inflect that way.
   */
  materialPhrasePlural?: string;
  /** Lower is dropped first when the furniture line exceeds its 200-char budget. */
  promptPriority: number;
}

/**
 * A four-legged (or four-support) low table/desk/island shape: one flat top
 * slab on four thin cylindrical or panel legs. Shared by coffee-table,
 * dining-table, conference-table and bar-stool-style single-support pieces.
 */
function buildLeggedSlab(
  topW: number,
  topH: number,
  topD: number,
  topY0: number,
  legR: number,
  legInsetXY: number,
): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), topW, topH, topD, 0, topY0, 0);
  const lx = topW / 2 - legInsetXY;
  const lz = topD / 2 - legInsetXY;
  for (const [x, z] of [
    [-lx, -lz],
    [lx, -lz],
    [lx, lz],
    [-lx, lz],
  ] as [number, number][]) {
    addCylinder(group, frameMat(), legR, legR, topY0, x, 0, z);
  }
  return group;
}

/**
 * A bed's LENGTH is its head-to-foot run, which is the Z (depth) axis here
 * because the headboard sits at the -Z edge. That was 4.5ft — shorter than an
 * actual person — while the side-to-side width was 6.5ft, so the thing
 * rendered as a wide square slab rather than a bed and read wrong in the
 * reference image. Now a real king: 6.3ft across by 6.8ft head to foot.
 */
const BED_W = 6.3;
// Trimmed 6.8 -> 6.5 (81.6in -> 78in). 6.8ft was slightly over a real
// mattress run and the bed was eating more floor than it should in the
// small-to-average rooms most plans actually have. NOTE it is still nearly
// square (6.3 x 6.5), because BED_W is a KING width — see the doc comment
// above, which set the width to fix an earlier bug and left the footprint
// almost 1:1. A true queen (5.0 x 6.6) would read far more like a bed from
// the locked camera and free real floor space; that is a separate,
// deliberate change, not something to slip in under "shorten it".
const BED_LEN = 6.5;

/**
 * A real single/twin mattress — for a small bedroom or a second occupant,
 * offered as an opt-in alongside the double bed above rather than seeded by
 * default (see its promptPriority for why).
 */
const SINGLE_BED_W = 3.5;
const SINGLE_BED_LEN = 6.5;

/**
 * Shared bed massing — mattress slab plus a taller, thin headboard at the -Z
 * ("head") edge — parameterised by footprint so the double and single bed
 * don't fork into two near-identical builders.
 */
function buildBedShape(bedW: number, bedLen: number): THREE.Group {
  const group = new THREE.Group();
  const mattressH = 1.3;
  addBox(group, seatMat(), bedW, mattressH, bedLen, 0, 0, 0);
  // Headboard at the -Z ("head") edge, taller and thin.
  const headboardH = 3.2;
  const headboardD = 0.3;
  addBox(group, frameMat(), bedW, headboardH, headboardD, 0, 0, -bedLen / 2 - headboardD / 2);
  return group;
}

function buildBed(): THREE.Group {
  return buildBedShape(BED_W, BED_LEN);
}

function buildSingleBed(): THREE.Group {
  return buildBedShape(SINGLE_BED_W, SINGLE_BED_LEN);
}

/**
 * 1.6ft total sat well below mattress height (a real mattress top is
 * typically ~2-2.3ft off the floor with a bed frame), so the nightstand read
 * shorter than the bed it sits beside. 2.0ft (1.85ft carcass + 0.15ft top
 * slab) is a realistic nightstand height. Also no longer a solid cube: a
 * proud drawer-line strip on the front face and a slightly overhanging top
 * slab give it a carcass silhouette instead of a featureless box.
 */
const NIGHTSTAND_W = 1.3;
const NIGHTSTAND_D = 1.3;

function buildNightstand(): THREE.Group {
  const group = new THREE.Group();
  const carcassW = 1.2;
  const carcassD = 1.2;
  const carcassH = 1.85;
  addBox(group, frameMat(), carcassW, carcassH, carcassD, 0, 0, 0);
  // Drawer line: a thin proud strip across the front (+Z) face, roughly
  // mid-height, reading as a surface break rather than a flat panel.
  addBox(group, frameMat(), carcassW * 0.85, 0.12, 0.05, 0, carcassH * 0.55, carcassD / 2);
  // Top slab, overhanging the carcass slightly on every side.
  addBox(group, frameMat(), NIGHTSTAND_W, 0.15, NIGHTSTAND_D, 0, carcassH, 0);
  return group;
}

/**
 * A real double wardrobe is 4-6ft wide and roughly 2ft deep, 6.5-7ft tall —
 * 2ft wide (a single-door footprint) read as a narrow cabinet, not a
 * wardrobe. Now 5ft wide x 2ft deep x 6.8ft tall. Also no longer a solid
 * slab: a proud vertical seam splits the front face into two doors, with
 * small handle nibs near the inner edge of each, so the silhouette reads as
 * a double-door wardrobe rather than an unmarked box the same size as a
 * fridge or a bookshelf.
 */
const WARDROBE_W = 5;
const WARDROBE_D = 2;
const WARDROBE_H = 6.8;

function buildWardrobe(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), WARDROBE_W, WARDROBE_H, WARDROBE_D, 0, 0, 0);
  // Vertical seam between the two doors: a thin proud strip running nearly
  // the full height down the centre of the front (+Z) face.
  addBox(group, frameMat(), 0.05, WARDROBE_H * 0.94, 0.04, 0, WARDROBE_H * 0.03, WARDROBE_D / 2);
  // Handle nibs, one per door, near the inner (split) edge, mid-height.
  const handleY = WARDROBE_H * 0.45;
  addCylinder(group, frameMat(), 0.035, 0.035, 0.6, -0.35, handleY, WARDROBE_D / 2);
  addCylinder(group, frameMat(), 0.035, 0.035, 0.6, 0.35, handleY, WARDROBE_D / 2);
  return group;
}

function buildDresser(): THREE.Group {
  const group = new THREE.Group();
  const w = 3.5;
  const d = 1.6;
  const topH = 0.12;
  const carcassH = 2.8 - topH;
  addBox(group, frameMat(), w, carcassH, d, 0, 0, 0);
  // Top slab, overhanging the carcass slightly on every side.
  addBox(group, frameMat(), w + 0.15, topH, d + 0.1, 0, carcassH, 0);
  // Three drawer lines: thin proud strips across the front (+Z) face,
  // evenly spaced, dividing the carcass into three drawer fronts.
  const lineW = w * 0.88;
  for (const frac of [0.28, 0.55, 0.82]) {
    addBox(group, frameMat(), lineW, 0.06, 0.03, 0, carcassH * frac, d / 2);
  }
  return group;
}

/** Sofa/armchair shape: seat slab + back slab + two arm boxes. */
function buildSeatWithArms(w: number, d: number, backH: number, armH: number): THREE.Group {
  const group = new THREE.Group();
  const seatH = backH * 0.55;
  const armW = w * 0.14;
  const backD = d * 0.18;
  // Seat slab.
  addBox(group, seatMat(), w - 2 * armW, seatH, d, 0, 0, 0);
  // Back slab, at the -Z edge, full height.
  addBox(group, frameMat(), w - 2 * armW, backH, backD, 0, 0, -d / 2 + backD / 2);
  // Two arms, running the full depth.
  addBox(group, frameMat(), armW, armH, d, -w / 2 + armW / 2, 0, 0);
  addBox(group, frameMat(), armW, armH, d, w / 2 - armW / 2, 0, 0);
  return group;
}

function buildSofa(): THREE.Group {
  return buildSeatWithArms(7, 3, 2.8, 2.2);
}

function buildArmchair(): THREE.Group {
  return buildSeatWithArms(2.8, 2.8, 2.6, 2.0);
}

function buildCoffeeTable(): THREE.Group {
  return buildLeggedSlab(3.5, 0.4, 1.8, 1.0, 0.06, 0.2);
}

/**
 * 4.5ft is narrow for a media console meant to sit under a wall-mounted TV
 * and span most of a living-room wall; 5-6ft is typical. Now 5.5ft wide.
 * Also no longer a solid box: a shallower, inset plinth lifts the main body
 * off the floor (reading as a shadow gap along the bottom edge instead of a
 * slab sitting flush on the ground), and a darker screen-height panel stands
 * proud of the front face so the unit reads as "console + mounted screen"
 * rather than one undifferentiated block.
 */
const TV_UNIT_W = 5.5;
const TV_UNIT_D = 1.4;

function buildTvUnit(): THREE.Group {
  const group = new THREE.Group();
  const plinthH = 0.15;
  const bodyH = 1.55;
  addBox(group, frameMat(), TV_UNIT_W - 0.3, plinthH, TV_UNIT_D - 0.3, 0, 0, 0);
  addBox(group, frameMat(), TV_UNIT_W, bodyH, TV_UNIT_D, 0, plinthH, 0);
  // Screen panel: a darker rectangle standing proud of the front (+Z) face,
  // vertically centred within the body, reading as a distinct screen rather
  // than part of the console carcass.
  addBox(
    group,
    seatMat(),
    TV_UNIT_W * 0.55,
    bodyH * 0.55,
    0.04,
    0,
    plinthH + bodyH * 0.2,
    TV_UNIT_D / 2,
  );
  return group;
}

function buildDiningTable(): THREE.Group {
  return buildLeggedSlab(5.5, 0.35, 3, 2.65, 0.08, 0.25);
}

function buildDiningChair(): THREE.Group {
  const group = new THREE.Group();
  const seatH = 1.5;
  addBox(group, seatMat(), 1.5, 0.25, 1.5, 0, seatH, 0);
  // Back slab at -Z edge.
  addBox(group, frameMat(), 1.5, 1.5, 0.15, 0, seatH + 0.25, -1.5 / 2 + 0.075);
  // Single central support column instead of 4 individual legs.
  addBox(group, frameMat(), 0.6, seatH, 0.6, 0, 0, 0);
  return group;
}

/**
 * 4ft is narrow for a sideboard meant to run along a dining-room wall; 5-6ft
 * is typical. Now 5.5ft wide. Also no longer a solid box: like the dresser
 * it gets a slightly overhanging top slab, but the front face is divided by
 * two vertical door seams instead of horizontal drawer lines, so it reads as
 * a longer, lower cabinet with doors rather than a stack of drawers.
 */
const SIDEBOARD_W = 5.5;
const SIDEBOARD_D = 1.6;

function buildSideboard(): THREE.Group {
  const group = new THREE.Group();
  const h = 2.5;
  const topH = 0.1;
  const carcassH = h - topH;
  addBox(group, frameMat(), SIDEBOARD_W, carcassH, SIDEBOARD_D, 0, 0, 0);
  // Top slab, overhanging the carcass slightly on every side.
  addBox(group, frameMat(), SIDEBOARD_W + 0.1, topH, SIDEBOARD_D + 0.08, 0, carcassH, 0);
  // Two vertical door seams, evenly spaced, dividing the front (+Z) face
  // into three door panels rather than the dresser's horizontal drawer lines.
  for (const x of [-SIDEBOARD_W / 6, SIDEBOARD_W / 6]) {
    addBox(group, frameMat(), 0.04, carcassH * 0.9, 0.03, x, carcassH * 0.05, SIDEBOARD_D / 2);
  }
  return group;
}

function buildDesk(): THREE.Group {
  const group = new THREE.Group();
  const topH = 0.25;
  const topY0 = 2.4 - topH;
  addBox(group, frameMat(), 4, topH, 2, 0, topY0, 0);
  // Two thin panel legs, inset from the ends.
  const legW = 0.15;
  const lx = 4 / 2 - 0.3;
  addBox(group, frameMat(), legW, topY0, 2 - 0.3, -lx, 0, 0);
  addBox(group, frameMat(), legW, topY0, 2 - 0.3, lx, 0, 0);
  return group;
}

function buildOfficeChair(): THREE.Group {
  const group = new THREE.Group();
  const seatH = 1.6;
  addBox(group, seatMat(), 1.8, 0.25, 1.8, 0, seatH, 0);
  addBox(group, frameMat(), 1.8, 1.6, 0.15, 0, seatH + 0.25, -1.8 / 2 + 0.075);
  // Single central cylinder support.
  addCylinder(group, frameMat(), 0.25, 0.35, seatH, 0, 0, 0);
  return group;
}

/**
 * Was a solid 3x6.5x1ft slab — indistinguishable from a wardrobe or a fridge
 * at the same footprint, since a bookshelf's whole identity is that it's
 * OPEN. Rebuilt as two side panels, a back panel, and 5 evenly-spaced
 * horizontal shelf slabs with real open gaps between them; the voids (not
 * the panels) are what read as a bookshelf. Overall footprint unchanged.
 */
function buildBookshelf(): THREE.Group {
  const group = new THREE.Group();
  const w = 3;
  const d = 1;
  const h = 6.5;
  const panelT = 0.1;
  const shelfT = 0.08;
  // Side panels, full height.
  addBox(group, frameMat(), panelT, h, d, -w / 2 + panelT / 2, 0, 0);
  addBox(group, frameMat(), panelT, h, d, w / 2 - panelT / 2, 0, 0);
  // Back panel, thin, full height, inset between the sides.
  addBox(group, frameMat(), w - 2 * panelT, h, panelT, 0, 0, -d / 2 + panelT / 2);
  // Five horizontal shelves, evenly spaced with open gaps between them —
  // the gaps are what make this read as a bookshelf rather than a slab.
  const shelfCount = 5;
  for (let i = 0; i < shelfCount; i++) {
    const yTop = (h / (shelfCount - 1)) * i;
    const yBottom = Math.min(yTop, h - shelfT);
    addBox(group, frameMat(), w - 2 * panelT, shelfT, d, 0, yBottom, 0);
  }
  return group;
}

/**
 * Reduced from 5 x 2.5ft. At that size the island could not legally be placed
 * in a smaller kitchen at all: resolvePlacement needs the whole footprint
 * inside the room and clear of the camera exclusion disk, and a 5ft slab in a
 * modest kitchen left no legal cell anywhere, so the Add button just reported
 * "no free space". 4 x 2ft is still a real island and fits.
 */
const ISLAND_W = 4;
const ISLAND_D = 2;

function buildKitchenIsland(): THREE.Group {
  const group = new THREE.Group();
  const topH = 0.3;
  const baseH = 2.5 - topH;
  const overhang = 0.6;
  addBox(group, frameMat(), ISLAND_W, baseH, ISLAND_D, 0, 0, 0);
  // Worktop overhangs the base on the +Z side only (where stools tuck
  // under), so the silhouette reads as an island rather than a plain block
  // the same size top-to-bottom.
  addBox(group, seatMat(), ISLAND_W, topH, ISLAND_D + overhang, 0, baseH, overhang / 2);
  return group;
}

function buildBarStool(): THREE.Group {
  const group = new THREE.Group();
  const legH = 2.3;
  addCylinder(group, frameMat(), 0.1, 0.14, legH, 0, 0, 0);
  addCylinder(group, seatMat(), 0.65, 0.65, 0.3, 0, legH, 0);
  return group;
}

function buildPoojaMandir(): THREE.Group {
  const group = new THREE.Group();
  // Base cabinet.
  const baseH = 2.2;
  addBox(group, frameMat(), 2, baseH, 1.5, 0, 0, 0);
  // Upper shrine, narrower than the base.
  const shrineH = 1.4;
  addBox(group, seatMat(), 1.3, shrineH, 1, 0, baseH, 0);
  // Stepped, tapering top plus a small domed finial — two shrinking tiers
  // and a cylinder cap — so the silhouette reads as a shrine roof instead of
  // two flat stacked boxes.
  const tier1H = 0.35;
  addBox(group, seatMat(), 0.9, tier1H, 0.7, 0, baseH + shrineH, 0);
  const tier2H = 0.25;
  addBox(group, seatMat(), 0.55, tier2H, 0.45, 0, baseH + shrineH + tier1H, 0);
  addCylinder(group, seatMat(), 0.02, 0.15, 0.3, 0, baseH + shrineH + tier1H + tier2H, 0);
  return group;
}

/**
 * 1.2ft total was coffee-table height, not console-table height — a real
 * console table (the slim hall/entryway kind meant to be walked past, not
 * sat at) is ~2.5-2.8ft tall. Now 2.6ft (2.45ft legs + 0.15ft top), built via
 * the shared buildLeggedSlab helper so it's a slim top on four legs rather
 * than the solid block it was before.
 */
function buildConsoleTable(): THREE.Group {
  return buildLeggedSlab(4, 0.15, 0.9, 2.45, 0.05, 0.15);
}

function buildBench(): THREE.Group {
  const group = new THREE.Group();
  const seatH = 0.3;
  const legH = 1.6 - seatH;
  addBox(group, seatMat(), 3.5, seatH, 1.3, 0, legH, 0);
  const legW = 0.15;
  const lx = 3.5 / 2 - 0.3;
  addBox(group, frameMat(), legW, legH, 1.3 - 0.3, -lx, 0, 0);
  addBox(group, frameMat(), legW, legH, 1.3 - 0.3, lx, 0, 0);
  return group;
}

function buildConferenceTable(): THREE.Group {
  return buildLeggedSlab(9, 0.35, 4, 2.65, 0.1, 0.3);
}

/**
 * A compact hatchback's footprint — 5ft wide by 12ft long (ratio 2.4), which
 * puts `shapeWord` (furniture-descriptors.ts) into "long low box", a correct
 * silhouette for a car.
 */
const CAR_W = 5;
const CAR_LEN = 12;

function buildCar(): THREE.Group {
  const group = new THREE.Group();
  const bodyH = 2;
  addBox(group, frameMat(), CAR_W, bodyH, CAR_LEN, 0, 0, 0);
  // Cabin/greenhouse: narrower, set back slightly toward the rear, sitting on
  // the body roof — reads as "car" rather than an undifferentiated slab.
  const cabinW = CAR_W * 0.7;
  const cabinH = 1.6;
  const cabinLen = CAR_LEN * 0.5;
  addBox(group, frameMat(), cabinW, cabinH, cabinLen, 0, bodyH, -CAR_LEN * 0.05);
  // Four wheels, short cylinders tucked well inside the body's own footprint
  // so they never push the bounding box past CAR_W x CAR_LEN.
  const wheelR = 0.5;
  const wheelH = 0.3;
  const wx = CAR_W / 2 - 0.8;
  const wz = CAR_LEN / 2 - 1.5;
  for (const [x, z] of [
    [-wx, -wz],
    [wx, -wz],
    [wx, wz],
    [-wx, wz],
  ] as [number, number][]) {
    addCylinder(group, seatMat(), wheelR, wheelR, wheelH, x, 0, z);
  }
  return group;
}

function buildSideTable(): THREE.Group {
  const group = new THREE.Group();
  const h = 1.8;
  const topH = 0.12;
  // Slim top slab on a single tapered pedestal, not a solid cube.
  addBox(group, frameMat(), 1.5, topH, 1.5, 0, h - topH, 0);
  addCylinder(group, frameMat(), 0.12, 0.25, h - topH, 0, 0, 0);
  return group;
}

function buildRug(): THREE.Group {
  const group = new THREE.Group();
  // One flat box with slight thickness, not a plane, so it reads as an
  // object sitting on the floor in a perspective render.
  addBox(group, rugMat(), 6, 0.08, 8, 0, 0, 0);
  return group;
}

function buildPlant(): THREE.Group {
  const group = new THREE.Group();
  const potH = 1.3;
  addCylinder(group, frameMat(), 0.5, 0.6, potH, 0, 0, 0);
  // Foliage: the one deliberately non-boxy shape, since a box would misread
  // badly as foliage.
  const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 1), foliageMat());
  foliage.position.set(0, potH + 1.1, 0);
  group.add(foliage);
  return group;
}

export const FURNITURE_CATALOGUE: FurnitureCatalogueEntry[] = [
  {
    kind: "bed",
    label: "Bed",
    footprintFt: { w: BED_W, d: BED_LEN },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildBed,
    materialPhrase: "upholstered bed in {soft}",
    promptPriority: 100,
  },
  {
    kind: "single-bed",
    label: "Single Bed",
    footprintFt: { w: SINGLE_BED_W, d: SINGLE_BED_LEN },
    roomTypes: ["Bedroom", "Guest Room", "Master Bedroom"],
    build: buildSingleBed,
    materialPhrase: "upholstered single bed in {soft}",
    // Below the double bed's 100, and — just as important — below wardrobe
    // (85) and dresser (65), the other two pieces that fill a normal
    // bedroom's default top-3: at anything above 65 this would bump one of
    // them out and get seeded ALONGSIDE the double bed, which is not what
    // "opt-in for a small room" means. 60 keeps the existing default trio
    // (bed, wardrobe, dresser) intact; the single bed is only ever added by
    // hand from the Furnish editor's sidebar.
    promptPriority: 60,
  },
  {
    kind: "nightstand",
    label: "Nightstand",
    footprintFt: { w: NIGHTSTAND_W, d: NIGHTSTAND_D },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildNightstand,
    materialPhrase: "{wood} nightstand",
    materialPhrasePlural: "{wood} nightstands",
    promptPriority: 50,
  },
  {
    kind: "wardrobe",
    label: "Wardrobe",
    footprintFt: { w: WARDROBE_W, d: WARDROBE_D },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildWardrobe,
    materialPhrase: "{wood} wardrobe",
    promptPriority: 85,
  },
  {
    kind: "dresser",
    label: "Dresser",
    footprintFt: { w: 3.5, d: 1.6 },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildDresser,
    materialPhrase: "{wood} dresser",
    promptPriority: 65,
  },
  {
    kind: "sofa",
    label: "Sofa",
    footprintFt: { w: 7, d: 3 },
    roomTypes: ["Living Room", "Lounge", "Living + Dining"],
    build: buildSofa,
    materialPhrase: "{soft} sofa",
    promptPriority: 95,
  },
  {
    kind: "armchair",
    label: "Armchair",
    footprintFt: { w: 2.8, d: 2.8 },
    roomTypes: ["Living Room", "Lounge", "Living + Dining"],
    build: buildArmchair,
    materialPhrase: "{soft} armchair",
    materialPhrasePlural: "{soft} armchairs",
    promptPriority: 70,
  },
  {
    kind: "coffee-table",
    label: "Coffee Table",
    footprintFt: { w: 3.5, d: 1.8 },
    roomTypes: ["Living Room", "Lounge", "Living + Dining"],
    build: buildCoffeeTable,
    materialPhrase: "{wood} coffee table",
    promptPriority: 55,
  },
  {
    kind: "tv-unit",
    label: "TV Unit",
    footprintFt: { w: TV_UNIT_W, d: TV_UNIT_D },
    roomTypes: ["Living Room", "Lounge", "Living + Dining"],
    build: buildTvUnit,
    materialPhrase: "low {wood} media console with a black screen",
    promptPriority: 75,
  },
  {
    kind: "dining-table",
    label: "Dining Table",
    footprintFt: { w: 5.5, d: 3 },
    roomTypes: ["Dining Room", "Living + Dining"],
    build: buildDiningTable,
    materialPhrase: "{wood} dining table",
    promptPriority: 90,
  },
  {
    kind: "dining-chair",
    label: "Dining Chair",
    footprintFt: { w: 1.5, d: 1.5 },
    // "Open Workspace" removed: no catalogue entry gives that room type a
    // TABLE, so this seeded a chair with no partner to sit at, and described
    // office seating to the image model as a "dining chair". Open Workspace's
    // own desk + office-chair pair is both sufficient and correct for it.
    roomTypes: ["Dining Room", "Living + Dining", "Meeting Room", "Conference Room"],
    build: buildDiningChair,
    materialPhrase: "{soft} dining chair",
    materialPhrasePlural: "{soft} dining chairs",
    promptPriority: 70,
  },
  {
    kind: "sideboard",
    label: "Sideboard",
    footprintFt: { w: SIDEBOARD_W, d: SIDEBOARD_D },
    roomTypes: ["Dining Room"],
    build: buildSideboard,
    materialPhrase: "{wood} sideboard",
    promptPriority: 65,
  },
  {
    kind: "desk",
    label: "Desk",
    footprintFt: { w: 4, d: 2 },
    roomTypes: ["Study", "Work Room", "Cabin", "Open Workspace"],
    build: buildDesk,
    materialPhrase: "{wood} desk",
    promptPriority: 80,
  },
  {
    kind: "office-chair",
    label: "Office Chair",
    footprintFt: { w: 1.8, d: 1.8 },
    roomTypes: ["Study", "Work Room", "Cabin", "Open Workspace"],
    build: buildOfficeChair,
    materialPhrase: "dark task chair",
    promptPriority: 45,
  },
  {
    kind: "bookshelf",
    label: "Bookshelf",
    footprintFt: { w: 3, d: 1 },
    roomTypes: ["Study", "Work Room", "Cabin"],
    build: buildBookshelf,
    materialPhrase: "{wood} open shelving",
    promptPriority: 60,
  },
  {
    kind: "kitchen-island",
    label: "Kitchen Island",
    footprintFt: { w: ISLAND_W, d: ISLAND_D },
    roomTypes: ["Kitchen", "Pantry"],
    build: buildKitchenIsland,
    materialPhrase: "{stone}-topped island",
    promptPriority: 90,
  },
  {
    kind: "bar-stool",
    label: "Bar Stool",
    footprintFt: { w: 1.3, d: 1.3 },
    roomTypes: ["Kitchen", "Pantry"],
    build: buildBarStool,
    materialPhrase: "{wood} bar stool",
    materialPhrasePlural: "{wood} bar stools",
    promptPriority: 45,
  },
  {
    kind: "pooja-mandir",
    label: "Pooja Mandir",
    footprintFt: { w: 2, d: 1.5 },
    roomTypes: ["Pooja Room"],
    build: buildPoojaMandir,
    materialPhrase: "carved {wood} pooja mandir",
    promptPriority: 55,
  },
  {
    kind: "console-table",
    label: "Console Table",
    footprintFt: { w: 4, d: 0.9 },
    roomTypes: ["Foyer", "Reception"],
    build: buildConsoleTable,
    materialPhrase: "slim {wood} console",
    promptPriority: 40,
  },
  {
    kind: "bench",
    label: "Bench",
    footprintFt: { w: 3.5, d: 1.3 },
    roomTypes: ["Foyer", "Reception", "Master Bedroom", "Bedroom", "Guest Room"],
    build: buildBench,
    materialPhrase: "{wood} bench",
    materialPhrasePlural: "{wood} benches",
    promptPriority: 35,
  },
  {
    kind: "conference-table",
    label: "Conference Table",
    footprintFt: { w: 9, d: 4 },
    roomTypes: ["Meeting Room", "Conference Room"],
    build: buildConferenceTable,
    materialPhrase: "{wood} conference table",
    promptPriority: 85,
  },
  {
    kind: "side-table",
    label: "Side Table",
    footprintFt: { w: 1.5, d: 1.5 },
    roomTypes: ["Living Room", "Lounge"],
    build: buildSideTable,
    materialPhrase: "{wood} side table",
    materialPhrasePlural: "{wood} side tables",
    promptPriority: 30,
  },
  {
    kind: "car",
    label: "Car",
    footprintFt: { w: CAR_W, d: CAR_LEN },
    // A garage holds a car too — see NO_FURNITURE_ROOM_TYPES below, which no
    // longer lists "Garage" for exactly this reason.
    roomTypes: ["Portico", "Parking", "Garage"],
    build: buildCar,
    // A STATIC phrase, deliberately with no {wood}/{soft}/{stone} token: a
    // car's material is not the project's furniture palette, and interpolate()
    // (furniture-layout.ts) passes a phrase with no such token through
    // unchanged, so this is safe to leave untokenised.
    materialPhrase: "a small parked hatchback car",
    // Defines the space, same tier as a bed or a sofa.
    promptPriority: 100,
  },
  {
    kind: "rug",
    label: "Rug",
    footprintFt: { w: 6, d: 8 },
    roomTypes: [],
    build: buildRug,
    materialPhrase: "a soft neutral rug",
    materialPhrasePlural: "soft neutral rugs",
    promptPriority: 20,
  },
  {
    kind: "plant",
    label: "Plant",
    footprintFt: { w: 2.2, d: 2.2 },
    roomTypes: [],
    build: buildPlant,
    materialPhrase: "a potted green plant",
    materialPhrasePlural: "potted green plants",
    promptPriority: 15,
  },
];

const UNIVERSAL_FALLBACK_KINDS = ["rug", "plant", "side-table"];

/**
 * Utility/back-of-house room types that get NO furniture at all, not even
 * the universal fallback (rug/plant/side-table). These are known, named room
 * types (unlike a Custom category's free-text room, which is what the
 * fallback below actually exists for) where the correct 3D scene and the
 * correct generated image both contain sanitary fixtures, shelving or
 * mechanical equipment rather than any soft-furnishing decor item — dropping
 * a rug or a potted plant into a toilet or a store room is exactly the kind
 * of "unnecessary thing" this list exists to prevent. Kept in sync with the
 * room-type strings in config/project-types/*.json and with the positive
 * contents clause in ai/prompting/prompt-builder.ts's SERVICE_ROOM_CONTENTS.
 */
const NO_FURNITURE_ROOM_TYPES = new Set(
  // "Garage" removed: it now offers the "car" catalogue entry (roomTypes
  // includes "Garage"), and NO_FURNITURE_ROOM_TYPES short-circuits
  // furnitureForRoomType to [] before any catalogue match runs, which made
  // that roomTypes entry silently dead. The garage's positive-contents
  // fallback in ai/prompting/prompt-builder.ts's SERVICE_ROOM_CONTENTS stays
  // as-is — it's still what a garage with no car placed should say.
  // "Balcony" added: it should read as an open outdoor space (a railing, sky,
  // a view out), never furniture — see the outdoor-chair/side-table removal
  // above.
  ["Bathroom", "Washroom", "Utility", "Store Room", "Storage", "Balcony"].map((rt) =>
    rt.toLowerCase(),
  ),
);

/**
 * Common labels that mean the same room as one of the catalogue's own
 * roomTypes strings, normalised before matching.
 *
 * Matching is exact (case-insensitive), which is predictable but brittle: a
 * room typed "Hall" — extremely common on Indian residential plans, and what
 * Gemini returns whenever a plan prints that word — matched NOTHING, so the
 * editor silently offered only the rug/plant/side-table fallback. That is the
 * reported "the coffee table wasn't available in the 3D scene": the coffee
 * table's geometry was fine all along (dev-check now proves every entry
 * builds a real mesh), it was simply never offered for that room.
 *
 * An explicit alias table rather than fuzzy/substring matching, deliberately.
 * Substring matching would make "Store Room" match "Room" and drag furniture
 * into rooms that must stay empty, and a typo-tolerant match would be
 * unpredictable. Keys must be lowercase; values must be an exact roomTypes
 * string used by at least one entry, which dev-check asserts.
 */
const ROOM_TYPE_ALIASES: Record<string, string> = {
  hall: "Living Room",
  living: "Living Room",
  "living area": "Living Room",
  "drawing room": "Living Room",
  "family room": "Living Room",
  "sitting room": "Living Room",
  dining: "Dining Room",
  "dining area": "Dining Room",
  "living + dining": "Living + Dining",
  "living and dining": "Living + Dining",
  "living cum dining": "Living + Dining",
  "master bed room": "Master Bedroom",
  "m. bedroom": "Master Bedroom",
  "bed room": "Bedroom",
  "kids bedroom": "Bedroom",
  "children's bedroom": "Bedroom",
  "guest bedroom": "Guest Room",
  "home office": "Study",
  office: "Study",
  "study room": "Study",
  "work from home": "Work Room",
  wfh: "Work Room",
  "work area": "Work Room",
  "puja room": "Pooja Room",
  "prayer room": "Pooja Room",
  toilet: "Bathroom",
  washroom: "Bathroom",
  wc: "Bathroom",
  "powder room": "Bathroom",
  entrance: "Foyer",
  lobby: "Foyer",
  entry: "Foyer",
  "car porch": "Portico",
  "car park": "Portico",
  carport: "Portico",
  porch: "Portico",
};

/** Lowercased room type with aliases resolved, ready for exact comparison. */
function canonicalRoomType(roomType: string | undefined): string | undefined {
  const raw = roomType?.trim().toLowerCase();
  if (!raw) return undefined;
  return (ROOM_TYPE_ALIASES[raw] ?? raw).toLowerCase();
}

/**
 * Items whose roomTypes includes the given room type string (case-insensitive
 * exact match, after alias normalisation). Falls back to a small universal set (rug, plant, side-table)
 * when no items match — e.g. for a "Custom" category project with a
 * free-text room type that doesn't match any entry. Known service/utility
 * room types (NO_FURNITURE_ROOM_TYPES) skip that fallback entirely and
 * always return an empty set, since "no match found" there means "this room
 * genuinely has no furniture", not "we don't recognise this room type".
 */
export function furnitureForRoomType(roomType: string | undefined): FurnitureCatalogueEntry[] {
  const needle = canonicalRoomType(roomType);
  if (needle && NO_FURNITURE_ROOM_TYPES.has(needle)) return [];
  const matches = needle
    ? FURNITURE_CATALOGUE.filter((entry) =>
        entry.roomTypes.some((rt) => rt.toLowerCase() === needle),
      )
    : [];
  if (matches.length > 0) return matches;
  return UNIVERSAL_FALLBACK_KINDS.map((kind) => catalogueEntry(kind)).filter(
    (entry): entry is FurnitureCatalogueEntry => entry !== undefined,
  );
}

/**
 * Look up one entry by kind, or undefined if the kind is unknown (e.g. stale
 * data after a catalogue edit) — callers must handle undefined gracefully,
 * never throw.
 */
export function catalogueEntry(kind: string): FurnitureCatalogueEntry | undefined {
  return FURNITURE_CATALOGUE.find((entry) => entry.kind === kind);
}
