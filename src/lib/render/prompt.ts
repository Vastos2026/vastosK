/**
 * Builds the FLUX prompt for a render from the project's *real* data:
 * the parsed floor plan, the chosen design style, and the furniture the user
 * actually placed. No invented content — every clause is derived from inputs.
 */

import type { DesignStyle, FloorPlan, PlacedItem, PropertyType } from "@/lib/types";
import type { RenderView } from "./flux-client";
import { generateJson, geminiConfigured } from "@/lib/pipeline/gemini-client";
import { buildRoomSpec, roomSpecPromptBlock, frontViewLayoutLock, viewLayoutLock, type LockView } from "@/lib/room-spec";

/** The four wall cameras that get a camera-oriented layout lock. */
const LOCK_VIEWS = new Set<RenderView>(["front", "left", "right", "back"]);
const asLockView = (view: RenderView): LockView | null =>
  LOCK_VIEWS.has(view) ? (view as LockView) : null;

const VIEW_CAMERA: Record<RenderView, string> = {
  corner:
    "three-quarter two-point-perspective view looking diagonally INTO a room corner — TWO adjacent walls are visible, receding to the left and right and meeting at a vertical corner edge near the centre of the frame; the feature wall is seen at roughly 45°, NOT flat / head-on and NOT a straight front view — at standing eye level (~1.5 m / 5 ft), 35-50 mm lens, no fisheye or extreme wide-angle distortion",
  "corner-back":
    "three-quarter two-point-perspective view from the OPPOSITE corner — diagonally across the room from the main corner — at standing eye level (~1.5 m / 5 ft), 35-50 mm lens, showing the two walls the main corner could not see so the two shots together cover the whole room",
  front:
    "straight-on one-point-perspective view facing the feature wall head-on at eye level (~1.5 m), 35-50 mm lens, symmetrical framing — NOT a corner or angled view",
  side:
    "side view looking lengthwise down the room, parallel to the feature wall, at eye level (~1.5 m), 35-50 mm lens — a clearly DIFFERENT angle from the corner and front",
  left:
    "head-on one-point-perspective view facing the LEFT wall of the room (the wall to the left of the front feature wall) squarely, at eye level (~1.5 m), 35-50 mm lens, straight verticals — NOT the front feature wall",
  right:
    "head-on one-point-perspective view facing the RIGHT wall of the room (the wall to the right of the front feature wall) squarely, at eye level (~1.5 m), 35-50 mm lens, straight verticals — NOT the front feature wall",
  back:
    "head-on one-point-perspective view facing the BACK wall (the wall OPPOSITE the front feature wall, behind the main seating), at eye level (~1.5 m), 35-50 mm lens, straight verticals",
  top: "top-down dollhouse view looking straight down",
  pano: "equirectangular 360° panorama, seamless full wraparound view from the room centre at eye level",
};

/** The camera framing description for a view — shared with the anchor renderer. */
export function cameraDescription(view: RenderView): string {
  return VIEW_CAMERA[view];
}

const PROPERTY_NOUN: Record<PropertyType, string> = {
  apartment: "apartment interior",
  villa: "villa interior",
  office: "office interior",
  commercial: "commercial retail interior",
};

/**
 * Per-style material + finish + lighting vocabulary, so each style renders with
 * authentic detail. The Indian styles mirror the reference deliverable: wood
 * veneer + fluted panels, brass/matt-gold profiles, marble, cove/profile LED.
 */
const STYLE_MATERIALS: Record<string, string> = {
  "modern-indian":
    "walnut wood veneer with fluted wood panelling, matt-gold metal profiles, marble flooring, backlit decor niches, warm cove and profile LED lighting",
  "luxury-indian":
    "rich walnut veneer with brass inlays and jaali screens, Italian marble floors and feature walls, fluted and tinted glass, champagne-gold profiles, layered cove lighting and backlit niches",
  "south-indian":
    "teak wood with carved panels, terracotta and antique-brass accents, natural stone flooring, traditional motifs, warm temple-style lighting",
  "north-indian":
    "carved dark wood with jaali screens, rich red and gold textiles, ornate brass detailing, patterned flooring, warm chandelier lighting",
  contemporary:
    "matte laminates and soft neutral upholstery, brushed-metal accents, large-format tile flooring, a bold accent wall, recessed and cove lighting",
  minimalist:
    "clean plaster walls, light oak, handleless cabinetry, hidden cove lighting, uncluttered surfaces, soft even light",
  scandinavian:
    "pale ash and birch wood, white walls, light linen textiles, matte-black accents, bright airy daylight",
  pooja:
    "carved teak mandir with brass bells and jaali, white marble platform, fresh garlands, warm brass uplighting and a sacred golden glow",
};

/**
 * The focal point / feature wall each room type should be designed around —
 * Layer 2 of a professional interior (every room needs one).
 */
const FOCAL_POINT: Record<string, string> = {
  bedroom:
    "a feature wall behind the bed with a fluted or upholstered headboard panel and a concealed warm LED strip",
  living:
    "a feature media wall with fluted wood panelling, a floating console and backlit display niches",
  hall:
    "a feature media wall with fluted wood panelling, a floating console and backlit display niches",
  dining:
    "a textured feature wall with a statement pendant or chandelier over the dining table",
  kitchen:
    "a designed backsplash and full-height cabinetry as the feature, with under-cabinet lighting",
  bathroom: "a marble feature wall with a backlit mirror and a recessed niche",
  pooja: "a carved wooden mandir feature wall with brass detailing and warm uplighting",
  office: "a panelled feature wall behind the desk with backlit shelving",
  balcony:
    "an OPEN, airy balcony / sit-out — a railing or parapet along the open edge with sky and greenery beyond, potted plants and compact outdoor seating; NOT an enclosed room and NOT an indoor media/feature wall",
  utility: "a functional utility / wash area with practical cabinetry and tiled, easy-clean surfaces",
  other: "a designed accent feature wall with panelling and a concealed LED strip",
};

/**
 * Room types that are SEMI-OUTDOOR / service spaces — they must NOT get the indoor
 * design layers (false-ceiling media wall, backlit niches, cove LED, dressed beds).
 * Rendering a balcony as an enclosed media room was the "balcony looks wrong" bug.
 */
const OUTDOOR_TYPES = new Set(["balcony"]);

/** Best-guess room type from its semantic type or its printed name. */
function roomTypeOf(room: { type?: string; name: string }): string {
  const t = (room.type ?? "").toLowerCase();
  if (t && FOCAL_POINT[t]) return t;
  const n = room.name.toLowerCase();
  if (/bed|master/.test(n)) return "bedroom";
  if (/living|lounge|family|drawing/.test(n)) return "living";
  if (/dining/.test(n)) return "dining";
  if (/kitchen|pantry/.test(n)) return "kitchen";
  if (/bath|toilet|\bwc\b|wash/.test(n)) return "bathroom";
  if (/pooja|puja|mandir|temple/.test(n)) return "pooja";
  if (/office|study|cabin/.test(n)) return "office";
  if (/balcon|veranda|sit ?out|terrace|deck/.test(n)) return "balcony";
  if (/utility|laundry|wash area/.test(n)) return "utility";
  if (/hall|foyer|lobby/.test(n)) return "hall";
  return "other";
}

/**
 * The professional "design layers" for a room — what turns a furnished box into a
 * designed interior — chosen BY ROOM TYPE. Indoor rooms get the false-ceiling /
 * cove / panelling / niche treatment; semi-outdoor spaces (balcony) get open,
 * outdoor-appropriate finishes instead. Rendering a balcony with an indoor media
 * wall + cove ceiling was the "balcony looks wrong" bug.
 */
function designLayers(roomType: string, styleId: string): string[] {
  if (OUTDOOR_TYPES.has(roomType)) {
    return [
      "this is a SEMI-OUTDOOR balcony / sit-out — an OPEN, airy space, NOT an enclosed room: a railing or parapet (wrought iron, wood or glass) runs along the open edge with sky and greenery beyond",
      "balcony finishes: anti-skid terracotta / Athangudi / natural-stone floor tiles, a plain plastered or teak-clad inner wall (a teak jaali screen is welcome) and a simple flat soffit or a wooden pergola overhead — NO false-ceiling cove, NO backlit display niches, NO indoor media/feature wall",
      "natural daylight as the key light, with only a few warm wall / step / festoon lights",
      "styled like a real balcony: potted plants and greenery, compact cane or teak outdoor seating, and a traditional wooden swing (oonjal) only if there is room — keep it open and uncluttered",
      "respect the balcony's true proportions — typically a shallow, long strip, not a deep room",
    ];
  }
  return [
    STYLE_MATERIALS[styleId] ?? "refined materials, veneer panelling and metal accents",
    "architectural detail: a false ceiling with perimeter cove lighting, wall panelling with recessed display niches, full-height curtains/sheers at the windows, and clean skirting and trims (no flat blank walls)",
    "layered lighting from BUILT-IN sources only — perimeter cove lighting and recessed spotlights (warm ~3000K) — with soft realistic shadows and reflections",
    "a rich mix of 4-5 materials: wood veneer, marble or natural stone, soft upholstery and fabric, brass or metal accents and glass",
    "style ONLY the furniture that is present — neatly dressed bed linens with cushions and a throw, and an area rug beneath it — keep surfaces tastefully minimal; add NO freestanding furniture, accent chairs, plants, floor/table lamps or props beyond the listed layout",
  ];
}

export interface RenderPromptInput {
  view: RenderView;
  style: DesignStyle;
  propertyType: PropertyType;
  plan?: FloorPlan;
  items: PlacedItem[];
  /** Optional free-text design brief from the user — prioritised when present. */
  notes?: string;
}

/** Ceiling height the 3D scene uses (scene-3d `WALL_H`), so prompts match it. */
const CEILING_FT = 9; // fallback when a room has no explicit ceiling height
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How each camera's frame maps onto the layout block's compass (north = the top
 * of the 2D plan). Matches the 3D capture cameras (scene-3d `cameraFor`): the
 * FRONT camera stands south of the room looking north.
 */
const VIEW_ORIENTATION: Partial<Record<RenderView, string>> = {
  front:
    "ORIENTATION: this view faces the room's NORTH wall — the WEST wall is at the frame's left edge, the EAST wall at the right edge",
  left:
    "ORIENTATION: this view faces the room's WEST wall — the SOUTH wall is at the frame's left edge, the NORTH wall at the right edge",
  right:
    "ORIENTATION: this view faces the room's EAST wall — the NORTH wall is at the frame's left edge, the SOUTH wall at the right edge",
  back:
    "ORIENTATION: this view faces the room's SOUTH wall — the EAST wall is at the frame's left edge, the WEST wall at the right edge",
};

/**
 * The EXACT layout block for the render's lead room — the reviewed plan data
 * (room dimensions, every furniture piece's size AND placement, door/window
 * positions) serialized verbatim. This is the 2D-Review → render transfer:
 * with no 3D Studio step in between, this block is how the reviewed layout
 * reaches the image model unchanged.
 */
function exactLayoutBlock(plan: FloorPlan | undefined, items: PlacedItem[]): string {
  const rooms = plan?.rooms ?? [];
  if (!rooms.length) return "";
  const lead = [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const spec = buildRoomSpec(lead, items, plan);
  return roomSpecPromptBlock(spec);
}

/**
 * The FRONT-view layout blocks: the authoritative exact-offset block PLUS the
 * camera-oriented LAYOUT LOCK (frame position, depth, relations). FRONT-only —
 * the lock's left/right/depth semantics are specific to the front camera.
 */
function frontLayoutBlocks(plan: FloorPlan | undefined, items: PlacedItem[]): string {
  const rooms = plan?.rooms ?? [];
  if (!rooms.length) return "";
  const lead = [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const spec = buildRoomSpec(lead, items, plan);
  const exact = roomSpecPromptBlock(spec);
  const lock = frontViewLayoutLock(spec);
  return lock ? `${exact}\n\n${lock}` : exact;
}

/** The camera-oriented layout lock for a wall view (left/right/back) of the lead room. */
function sideViewLockBlock(plan: FloorPlan | undefined, items: PlacedItem[], view: LockView): string {
  const rooms = plan?.rooms ?? [];
  if (!rooms.length) return "";
  const lead = [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return viewLayoutLock(buildRoomSpec(lead, items, plan), view);
}

/**
 * STRICT real-world dimensions — the room's footprint + ceiling and the real size
 * of each furniture piece — injected into EVERY render prompt (hero, anchored
 * views, FLUX). Without explicit numbers the model guesses the room size per shot,
 * so one camera looks spacious and another cramped; stating the exact feet locks
 * the proportions and keeps the SAME sense of scale across all views.
 * Deliberately camera-agnostic (the room is the same size from every angle).
 */
export function dimensionBrief({ plan, items }: Pick<RenderPromptInput, "plan" | "items">): string {
  const rooms = plan?.rooms ?? [];
  const lead = rooms.length
    ? [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    : undefined;

  const segs: string[] = [];
  if (lead) {
    const w = Math.round(lead.width);
    const d = Math.round(lead.height);
    const ceiling = lead.ceilingFt ?? CEILING_FT;
    segs.push(
      `ROOM DIMENSIONS — follow STRICTLY: this room is exactly ${w} ft wide × ${d} ft deep ` +
        `(about ${w * d} sq ft of floor) with a ${ceiling} ft ceiling. Render the space at ` +
        `EXACTLY these proportions and floor area, and keep that SAME sense of size and ` +
        `spaciousness in EVERY view — do NOT make it look larger/wider in one shot and ` +
        `smaller/cramped in another`,
    );
  }
  // Real furniture sizes (deduped by name) so each piece is at correct scale
  // relative to the room and to the other pieces.
  const seen = new Set<string>();
  const sizes: string[] = [];
  for (const it of items.filter((i) => !i.ghost)) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push(`${it.name} ${r1(it.w)}×${r1(it.d)}×${r1(it.h)} ft`);
    if (sizes.length >= 8) break;
  }
  if (sizes.length) {
    segs.push(
      `FURNITURE SIZES (W×D×H, real scale — keep each piece at this size and in correct ` +
        `proportion to the room and to the other pieces): ${sizes.join("; ")}`,
    );
  }
  return segs.join(". ");
}

/**
 * The FRONT-view "architectural photograph" prompt — a GENERALISED version of the
 * user's detailed dimensional template, populated from the room's REAL data:
 * the room's W×D×H, every furniture piece's real size, the focal point, and the
 * design layers + palette for the SELECTED style (the style paragraph "depends on
 * the design" as the user asked). This is the single front photo that the orbit
 * video is then generated from. Dimensions are stated strictly because the user
 * emphasised they matter most.
 */
export function buildFrontPhotoPrompt({
  style,
  propertyType,
  plan,
  items,
  notes,
}: RenderPromptInput): string {
  const rooms = plan?.rooms ?? [];
  const lead = rooms.length
    ? [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    : undefined;
  const roomType = lead ? roomTypeOf(lead) : "other";
  const isOutdoor = OUTDOOR_TYPES.has(roomType);
  const focal = FOCAL_POINT[roomType] ?? FOCAL_POINT.other;

  // The reviewed layout, transferred verbatim: the exact-offset block PLUS the
  // camera-oriented FRONT layout lock (frame position, depth, relations).
  const layout = frontLayoutBlocks(plan, items);
  // Fallback furniture sizes (deduped) for renders without a lead room.
  const seen = new Set<string>();
  const furniture: string[] = [];
  for (const it of items.filter((i) => !i.ghost)) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    furniture.push(`- ${it.name}: ${r1(it.w)} ft wide × ${r1(it.d)} ft deep × ${r1(it.h)} ft high`);
    if (furniture.length >= 12) break;
  }

  const lines = [
    `Design a photorealistic, professionally-photographed FRONT-VIEW interior rendering of a ${style.name} ${PROPERTY_NOUN[propertyType]}${lead ? ` (the ${lead.name.toLowerCase()})` : ""}, built strictly to real-world architectural scale — every element in accurate proportion.`,
    notes?.trim() ? `Design brief (top priority): ${notes.trim()}.` : "",
    lead
      ? `ROOM DIMENSIONS — follow STRICTLY: ${Math.round(lead.width)} ft wide × ${Math.round(lead.height)} ft deep × ${lead.ceilingFt ?? CEILING_FT} ft ceiling (about ${Math.round(lead.width) * Math.round(lead.height)} sq ft). Render at EXACTLY these proportions and floor area.`
      : "",
    layout,
    layout
      ? `ORIENTATION: the camera faces the room's NORTH wall (as drawn in the layout above) — the WEST wall is at the frame's left edge, the EAST wall at the frame's right edge. Place every listed piece on the correct side of the frame accordingly.`
      : "",
    `CAMERA: head-on FRONT view in one-point perspective, camera centred on the room's axis facing the feature wall squarely — a perfectly SYMMETRICAL, straight-on composition like a professional architectural photograph. Wide architectural lens at eye level (~5 ft / 1.5 m), perfectly straight vertical lines, accurate perspective with NO distortion of dimensions, framing the whole room including part of the ceiling and floor.`,
    `STYLE: ${style.name} — ${style.tagline}.`,
    !layout && furniture.length
      ? `FURNITURE — render each at its EXACT real size, in correct proportion to the room and to the other pieces, with realistic circulation/clearance between them:\n${furniture.join("\n")}`
      : "",
    `DESIGN: ${designLayers(roomType, style.id).join("; ")}.`,
    isOutdoor ? "" : `Designed around ${focal} as the focal point, facing the camera.`,
    `PALETTE: ${style.wallColor} walls, ${style.floorColor} flooring, ${style.accentColor} accents.`,
    `The result must look like a luxury interior photographed by an architectural photographer: true-to-life proportions and scale, realistic global illumination, soft shadows and reflections, warm ~3000K lighting with natural daylight. No people, no text or watermarks.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Compose a single descriptive prompt string for text-to-image generation. */
export function buildRenderPrompt(input: RenderPromptInput): string {
  // The FRONT view is the room's hero photo → use the detailed dimensional template.
  if (input.view === "front") return buildFrontPhotoPrompt(input);
  const { view, style, propertyType, plan, items, notes } = input;
  // Lead room: the largest placed room reads as the scene's focus.
  const rooms = plan?.rooms ?? [];
  const lead = rooms.length
    ? [...rooms].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    : undefined;
  const roomType = lead ? roomTypeOf(lead) : "other";

  const parts: string[] = [
    view === "pano"
      ? `Equirectangular 360-degree VR panorama (2:1), photorealistic, professionally-designed Indian ${PROPERTY_NOUN[propertyType]}, seamless wraparound`
      : `Photorealistic, professionally-designed Indian ${PROPERTY_NOUN[propertyType]} interior — interior-design magazine / Pinterest quality, NOT a bare furniture arrangement`,
    // The user's brief leads so FLUX prioritises it.
    ...(notes?.trim() ? [`design brief (top priority): ${notes.trim()}`] : []),
    VIEW_CAMERA[view],
    `${style.name} interior design style — ${style.tagline}`,
  ];

  if (lead) {
    parts.push(`scene centred on the ${lead.name.toLowerCase()}`);
    if (view !== "top") {
      // STRICT room + furniture dimensions, so the rendered space matches the real
      // size and reads at the SAME scale in every view (corner vs front etc.).
      parts.push(dimensionBrief({ plan, items }));
    }
    // The reviewed layout transferred verbatim — exact furniture placements and
    // door/window positions, identical for every camera.
    const layout = exactLayoutBlock(plan, items);
    if (layout) parts.push(layout);
    // Pin the layout's compass onto this camera's frame (front camera faces the
    // plan's north wall — the 3D capture convention), so pieces land on the
    // correct side of the image instead of a mirrored guess.
    const orientation = layout ? VIEW_ORIENTATION[view] : undefined;
    if (orientation) parts.push(orientation);
    // Camera-oriented placement lock for the head-on wall views (left/right/back
    // get the SAME frame-%/order/depth grounding the front view already had, so
    // every side places furniture precisely). The front view uses its own
    // buildFrontPhotoPrompt path; corner/side/top have no single frame mapping.
    const lockView = layout ? asLockView(view) : null;
    if (lockView && lockView !== "front") {
      const lock = sideViewLockBlock(plan, items, lockView);
      if (lock) parts.push(lock);
    }
    // Layer 2 — every room is designed around one focal point / feature wall.
    // Semi-outdoor spaces (balcony) have NO feature wall, so they get open framing.
    const isOutdoor = OUTDOOR_TYPES.has(roomType);
    const focal = FOCAL_POINT[roomType] ?? FOCAL_POINT.other;
    if (view === "corner-back") {
      // The diagonally-opposite corner looks BACK across the room, so the focal
      // wall sits BEHIND the camera — this shot must show the OTHER half of the
      // room, not the same feature wall (otherwise it reads as an adjacent, not
      // an opposite, corner).
      parts.push(
        isOutdoor
          ? `THIS photo is from the diagonally OPPOSITE corner, looking back along the balcony — show its other end and the inner wall, with the open railing edge to one side; it is ${focal}`
          : `the room is designed around ${focal}, but THIS photo is taken from the diagonally OPPOSITE corner looking back across the room — that feature/focal wall is BEHIND the camera and must NOT appear; instead show the OPPOSITE side of the room: the wall facing the feature wall, the windows and curtains, side seating, and the far/foot end of the furniture`,
      );
    } else if (view === "corner") {
      // The corner shot is an ANGLED three-quarter view, NOT head-on — otherwise it
      // renders identically to the `front` view (the bug: "the angle is not
      // switching"). Show the feature wall at ~45° meeting an adjacent wall.
      parts.push(
        isOutdoor
          ? `show the balcony at a THREE-QUARTER ANGLE in two-point perspective along its length — the open railing edge receding to one side and the inner wall to the other, meeting at a vertical corner; it is ${focal}`
          : `the room is designed around ${focal} — show it at a THREE-QUARTER ANGLE in two-point perspective: the feature wall recedes to one side and the adjacent wall to the other, meeting at a vertical corner edge, with the furniture seen from the corner; do NOT frame the feature wall flat or head-on (that head-on framing is the separate FRONT view, not this corner view)`,
      );
    } else if (view === "side") {
      // A SIDE view looks LENGTHWISE down the room — clearly different from both the
      // angled corner and the head-on front, so the three angles never look alike.
      parts.push(
        isOutdoor
          ? `a SIDE view looking LENGTHWISE along the balcony from one end to the other — the open railing edge runs along ONE side of the frame, the inner wall along the other; it is ${focal}`
          : `a SIDE view looking LENGTHWISE down the room, parallel to the feature wall — the ${focal} runs along ONE side of the frame seen edge-on (NOT facing the camera), the opposite wall along the other side, showing the room's full depth; a clearly DIFFERENT angle from both the corner and the head-on front`,
      );
    } else if (view === "left" || view === "right" || view === "back") {
      // Each faces a NON-feature wall head-on. Same room/design as the front, just a
      // different wall in shot — these are the "turn to the left / right / back" stills.
      const wall =
        view === "back"
          ? "the BACK wall (the wall OPPOSITE the front feature wall, behind the main seating)"
          : `the ${view.toUpperCase()} wall (the wall to the ${view} of the front feature wall)`;
      const where = view === "back" ? "behind the camera" : "off to the side, at the very edge or out of frame";
      parts.push(
        `face ${wall} HEAD-ON, square to the camera, so that wall fills the frame; the front feature wall (${focal}) is NOT the subject here — it sits ${where}. Keep the SAME room, design, materials, colours and lighting as the other views; only the wall in shot changes.`,
      );
    } else {
      parts.push(`designed around ${focal} as the focal point, facing the camera`);
    }
  }

  // Real furniture the user placed (deduped by name, capped so the prompt
  // stays focused rather than an exhaustive inventory).
  const furniture = uniqueNames(items.filter((it) => !it.ghost).map((it) => it.name));
  if (furniture.length) {
    parts.push(`furnished with ${listToProse(furniture.slice(0, 8))}`);
  }

  parts.push(
    `palette: ${style.wallColor} walls, ${style.floorColor} flooring, ${style.accentColor} accents`,
    // The professional "layers" — chosen by room type (indoor vs semi-outdoor), so
    // a balcony is NOT dressed as an indoor media room.
    ...designLayers(roomType, style.id),
    // Consistency (universal): keep the SHELL + main furniture fixed across views.
    "this is ONE specific room shown from different cameras — render ONLY the room's built-in design (ceiling, walls, panelling, flooring, lighting) and the exact furniture listed above, with the SAME pieces, SAME placement, SAME wall / floor / wood / fabric colours and SAME materials in EVERY view; add no extra furniture or props and never change the colour scheme between views — only the camera changes",
    "no people, no text or watermarks",
    "V-Ray / Corona architectural render quality, ultra-detailed, sharp focus, 4k",
  );

  return parts.join(", ") + ".";
}

/**
 * The room's *design identity* — the look that must stay byte-for-byte the same
 * across every camera angle: the exact furniture pieces, the palette, the
 * material vocabulary, the feature/focal wall and the built-in design layers.
 *
 * This is the SAME deterministic vocabulary {@link buildRenderPrompt} feeds the
 * hero render (same constants, same furniture/style/plan inputs), pulled out so
 * the anchored views ({@link renderViewFromAnchor}) can be grounded in identical
 * words — closing the gap where an anchored view only saw the hero image and a
 * style name, and so drifted.
 *
 * Deliberately CAMERA-AGNOSTIC: it lists only what stays the same from any angle
 * (furniture, palette, materials, built-in design layers). It does NOT name the
 * feature/focal wall — that wall is in shot for the corner/front cameras but sits
 * BEHIND the opposite-corner camera, so asserting it "must appear" would force a
 * duplicate wall or make the model copy the hero's frame. The hero image carries
 * the feature wall's look for the views that actually see it.
 */
export function buildIdentityBrief({
  style,
  items,
  plan,
  view,
}: Pick<RenderPromptInput, "style" | "items" | "plan"> & {
  /**
   * When this is one of the four wall cameras, the CAMERA-ORIENTED layout lock
   * for that view is appended — so an anchored walkthrough side gets the exact
   * frame-%/order/depth placement grounding, not just camera-agnostic offsets.
   * Omit (or pass a non-wall view) to keep the brief camera-agnostic.
   */
  view?: RenderView;
}): string {
  const lines: string[] = [];
  // Lead with the STRICT room + furniture dimensions so anchored views render the
  // space at the same true size/scale as the hero (not more/less spacious).
  const dims = dimensionBrief({ plan, items });
  if (dims) lines.push(dims);
  // Exact placements + openings — identical from any camera, so anchored views
  // keep every piece where 2D Review put it.
  const layout = exactLayoutBlock(plan, items);
  if (layout) lines.push(layout);
  const furniture = uniqueNames(items.filter((it) => !it.ghost).map((it) => it.name));
  if (furniture.length) {
    lines.push(`Furniture, exactly these pieces and one of each: ${listToProse(furniture.slice(0, 8))}`);
  }
  lines.push(`Palette: ${style.wallColor} walls, ${style.floorColor} flooring, ${style.accentColor} accents`);
  lines.push(
    `Materials and finishes: ${STYLE_MATERIALS[style.id] ?? "refined materials, veneer panelling and metal accents"}`,
  );
  lines.push(
    "Built-ins: a false ceiling with perimeter cove lighting, wall panelling with recessed niches, full-height curtains/sheers, clean skirting; warm ~3000K built-in lighting only",
  );
  let out = lines.join(". ") + ".";
  // Camera-oriented placement lock for a wall view (front/left/right/back) — this
  // is what makes an ANCHORED side still place furniture where the plan says,
  // instead of only matching the hero's materials. Appended as its own block
  // (multi-line, so kept out of the ". "-joined identity sentence above).
  const lockView = view ? asLockView(view) : null;
  if (lockView) {
    const lock = sideViewLockBlock(plan, items, lockView);
    if (lock) out += `\n\n${lock}`;
  }
  return out;
}

/**
 * Workflow step 15 — "Gemini Creates Render Prompt".
 *
 * Takes the deterministic, grounded description and asks Gemini to rewrite it as
 * a single polished prompt for a photorealistic architectural render. Purely a
 * refinement: it must not invent rooms or furniture, only improve phrasing,
 * lighting and material language. Best-effort — returns the base prompt
 * unchanged if Gemini is unconfigured or unavailable.
 */
/**
 * Matches the exact-layout block (ends "…resize anything.") plus, if present, the
 * FRONT-VIEW LAYOUT LOCK that follows it — so both survive a Gemini rewrite
 * verbatim. The optional group is greedy but its inner scan is lazy, so it
 * extends to the lock's end marker only when the lock is actually there.
 */
const LAYOUT_BLOCK_RE = /EXACT ROOM LAYOUT[\s\S]*?resize anything\.(?:[\s\S]*?=== END LAYOUT LOCK ===)?/;

export async function refinePromptWithGemini(
  basePrompt: string,
  style: DesignStyle,
): Promise<string> {
  if (!geminiConfigured()) return basePrompt;

  const instruction = `You are a prompt engineer for a photorealistic interior-render model (FLUX).
Rewrite the DESCRIPTION below into ONE vivid, concise prompt (max ~75 words) for a
"${style.name}" interior. Keep every concrete fact (room, dimensions, furniture,
colors) exactly as given — do NOT add or remove rooms or furniture. Emphasise
realistic materials, lighting and camera. If the description contains an
"EXACT ROOM LAYOUT" and/or "FRONT-VIEW LAYOUT LOCK" section, do NOT repeat it —
it is re-attached verbatim afterwards. Return JSON: { "prompt": string }.

DESCRIPTION:
${basePrompt}`;

  try {
    const out = await generateJson<{ prompt?: string }>([{ text: instruction }], {
      temperature: 0.4,
    });
    const refined = out?.prompt?.trim();
    if (!refined || refined.length <= 20) return basePrompt;
    // The reviewed layout must survive refinement VERBATIM — the whole point of
    // the exact transfer. Re-attach it if the rewrite dropped it.
    const layout = basePrompt.match(LAYOUT_BLOCK_RE)?.[0];
    return layout && !refined.includes("EXACT ROOM LAYOUT")
      ? `${refined}\n\n${layout}`
      : refined;
  } catch {
    return basePrompt;
  }
}

/** A short prompt for a masked inpaint edit, grounded in the user's instruction. */
export function buildInpaintPrompt(instruction: string, style: DesignStyle): string {
  const base = instruction.trim() || "refine this region";
  return `${base}, ${style.name} interior style, photorealistic, consistent lighting and perspective with the surrounding room, seamless, high detail.`;
}

function uniqueNames(names: string[]): string[] {
  return Array.from(new Set(names));
}

function listToProse(items: string[]): string {
  const lower = items.map((s) => s.toLowerCase());
  if (lower.length === 1) return lower[0];
  return `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]}`;
}
