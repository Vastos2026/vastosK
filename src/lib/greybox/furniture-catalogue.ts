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

function buildBed(): THREE.Group {
  const group = new THREE.Group();
  const mattressH = 1.3;
  addBox(group, seatMat(), 6.5, mattressH, 4.5, 0, 0, 0);
  // Headboard at the -Z ("head") edge, taller and thin.
  const headboardH = 3.2;
  const headboardD = 0.3;
  addBox(group, frameMat(), 6.5, headboardH, headboardD, 0, 0, -4.5 / 2 - headboardD / 2);
  return group;
}

function buildNightstand(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 1.3, 1.6, 1.3, 0, 0, 0);
  return group;
}

function buildWardrobe(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 2, 6.5, 2, 0, 0, 0);
  return group;
}

function buildDresser(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 3.5, 2.8, 1.6, 0, 0, 0);
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

function buildTvUnit(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 4.5, 1.8, 1.3, 0, 0, 0);
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

function buildSideboard(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 4, 2.8, 1.4, 0, 0, 0);
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

function buildBookshelf(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 3, 6.5, 1, 0, 0, 0);
  return group;
}

function buildKitchenIsland(): THREE.Group {
  const group = new THREE.Group();
  const topH = 0.3;
  const baseH = 2.5 - topH;
  addBox(group, frameMat(), 5, baseH, 2.5, 0, 0, 0);
  addBox(group, seatMat(), 5, topH, 2.5, 0, baseH, 0);
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
  // Two stacked boxes of decreasing size — a tiered altar look.
  const baseH = 2.4;
  addBox(group, frameMat(), 2, baseH, 1.5, 0, 0, 0);
  addBox(group, seatMat(), 1.3, 4 - baseH, 1, 0, baseH, 0);
  return group;
}

function buildConsoleTable(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 4, 1.2, 0.9, 0, 0, 0);
  return group;
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

function buildOutdoorChair(): THREE.Group {
  const group = new THREE.Group();
  const seatH = 1.4;
  addBox(group, seatMat(), 2, 0.25, 2, 0, seatH, 0);
  addBox(group, frameMat(), 2, 1.2, 0.15, 0, seatH + 0.25, -2 / 2 + 0.075);
  addBox(group, frameMat(), 0.5, seatH, 0.5, 0, 0, 0);
  return group;
}

function buildSideTable(): THREE.Group {
  const group = new THREE.Group();
  addBox(group, frameMat(), 1.5, 1.8, 1.5, 0, 0, 0);
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
    footprintFt: { w: 6.5, d: 4.5 },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildBed,
    materialPhrase: "upholstered bed in {soft}",
    promptPriority: 100,
  },
  {
    kind: "nightstand",
    label: "Nightstand",
    footprintFt: { w: 1.3, d: 1.3 },
    roomTypes: ["Master Bedroom", "Bedroom", "Guest Room"],
    build: buildNightstand,
    materialPhrase: "{wood} nightstand",
    materialPhrasePlural: "{wood} nightstands",
    promptPriority: 50,
  },
  {
    kind: "wardrobe",
    label: "Wardrobe",
    footprintFt: { w: 2, d: 2 },
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
    footprintFt: { w: 4.5, d: 1.3 },
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
    roomTypes: ["Dining Room", "Living + Dining", "Meeting Room", "Conference Room", "Open Workspace"],
    build: buildDiningChair,
    materialPhrase: "{soft} dining chair",
    materialPhrasePlural: "{soft} dining chairs",
    promptPriority: 70,
  },
  {
    kind: "sideboard",
    label: "Sideboard",
    footprintFt: { w: 4, d: 1.4 },
    roomTypes: ["Dining Room"],
    build: buildSideboard,
    materialPhrase: "{wood} sideboard",
    promptPriority: 65,
  },
  {
    kind: "desk",
    label: "Desk",
    footprintFt: { w: 4, d: 2 },
    roomTypes: ["Study", "Cabin", "Open Workspace"],
    build: buildDesk,
    materialPhrase: "{wood} desk",
    promptPriority: 80,
  },
  {
    kind: "office-chair",
    label: "Office Chair",
    footprintFt: { w: 1.8, d: 1.8 },
    roomTypes: ["Study", "Cabin", "Open Workspace"],
    build: buildOfficeChair,
    materialPhrase: "dark task chair",
    promptPriority: 45,
  },
  {
    kind: "bookshelf",
    label: "Bookshelf",
    footprintFt: { w: 3, d: 1 },
    roomTypes: ["Study", "Cabin"],
    build: buildBookshelf,
    materialPhrase: "{wood} open shelving",
    promptPriority: 60,
  },
  {
    kind: "kitchen-island",
    label: "Kitchen Island",
    footprintFt: { w: 5, d: 2.5 },
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
    kind: "outdoor-chair",
    label: "Outdoor Chair",
    footprintFt: { w: 2, d: 2 },
    roomTypes: ["Balcony"],
    build: buildOutdoorChair,
    materialPhrase: "woven outdoor chair",
    materialPhrasePlural: "woven outdoor chairs",
    promptPriority: 35,
  },
  {
    kind: "side-table",
    label: "Side Table",
    footprintFt: { w: 1.5, d: 1.5 },
    roomTypes: ["Living Room", "Lounge", "Balcony"],
    build: buildSideTable,
    materialPhrase: "{wood} side table",
    materialPhrasePlural: "{wood} side tables",
    promptPriority: 30,
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
  ["Bathroom", "Washroom", "Utility", "Store Room", "Storage", "Garage"].map((rt) =>
    rt.toLowerCase(),
  ),
);

/**
 * Items whose roomTypes includes the given room type string (case-insensitive
 * exact match). Falls back to a small universal set (rug, plant, side-table)
 * when no items match — e.g. for a "Custom" category project with a
 * free-text room type that doesn't match any entry. Known service/utility
 * room types (NO_FURNITURE_ROOM_TYPES) skip that fallback entirely and
 * always return an empty set, since "no match found" there means "this room
 * genuinely has no furniture", not "we don't recognise this room type".
 */
export function furnitureForRoomType(roomType: string | undefined): FurnitureCatalogueEntry[] {
  const needle = roomType?.trim().toLowerCase();
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
