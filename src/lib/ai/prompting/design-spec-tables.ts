import "server-only";
import { COLOUR_PALETTES, STYLES } from "@/lib/data";
import { clamp, stripWallFinishes } from "./design-planning";
import type { DesignSpecification, LuxuryLevel, UniversalInput, UniversalInputRoom } from "./types";
import type { MaterialTokens } from "@/lib/greybox/furniture-layout";

/**
 * The deterministic Design Specification builder — the table-driven
 * replacement for `runDesignPlanning`'s Gemini call.
 *
 * WHY THIS EXISTS. Only four of that call's ten fields ever reached an image
 * model: `compactBrief`, `wallColour`, `compactGuidance` and `materialTokens`
 * (the other six have no reader anywhere in src/). Those four are roughly 400
 * characters per room, and every input that produces them — style, luxury
 * level, colour palette, room type — is a value the user picked from a fixed
 * list. A model was being paid, and waited on for ~50 seconds, to look up a
 * table.
 *
 * It was also a LOSSY lookup, which is the real argument. `colour_palette`
 * appears nowhere in prompt-builder.ts, and `style`/`luxury_level` only in its
 * no-greybox branch — so on the normal path all three of the user's explicit
 * choices reached the model ONLY through this call's prose. Nothing guaranteed
 * a choice survived it. That is exactly how three chosen magentas came back as
 * ivory walls: the planner read them as an accent scheme and painted the walls
 * a safe neutral, and no downstream code could tell it had overruled the user.
 * Here, slot one IS the wall colour. There is no interpretive layer left to
 * disagree with.
 *
 * WHAT IT DOES NOT REPLACE. `analyseDesignReference` (design-reference.ts)
 * stays exactly as it is. A reference photo is genuinely unbounded input and
 * no table can anticipate it — that call already produces free-text style,
 * palette, material, lighting and furniture attributes, which this builder
 * consumes through the same `UniversalInput.design` fields a preset produces.
 * So the reference path costs one vision call and no planning call, and a
 * style string nothing here has ever seen ("Retro pastel cafe") still works:
 * `styleBriefFor` falls through to a composed generic rather than failing.
 *
 * SIZING. Every value here is written to a budget, because prompt-builder
 * slices the room-brief section (label + brief + guidance, joined) as a whole.
 * A 240-char brief plus a 120-char guidance silently lost the guidance
 * entirely under the old 240-char section budget — it is last in the join. The
 * numbers below are chosen so a full label, a full brief and a full guidance
 * all fit inside BUDGET.brief with room to spare, rather than relying on
 * whatever length a model happened to return.
 */

/** Max chars for a style brief. Sized against BUDGET.brief (300) alongside a room label and guidance. */
const BRIEF_MAX = 165;
/** Max chars for one room's guidance line. */
const GUIDANCE_MAX = 100;
/** Max chars for the wall colour phrase. Matches DesignSpecification.wallColour's stated bound. */
const WALL_COLOUR_MAX = 40;

/**
 * The 24 style briefs, one per style and luxury level.
 *
 * DELIBERATELY CONTEXT-FREE. Not one of these names a room, a building or an
 * occupant. That is the property that makes them reusable: the same
 * "Minimalist Indian, Premium" brief has to sit behind a bedroom, a cafe, a
 * dental clinic and a portico without reading oddly, because the room type
 * and the project type are stated elsewhere in the prompt and would be
 * duplicated (or contradicted) if they appeared here too.
 *
 * Each one answers only: what materials, how the colour is applied, what the
 * light does, and how much detailing. The luxury level is folded into the
 * prose rather than appended as a separate clause, because "Standard" and
 * "Ultra Luxury" change WHICH materials are plausible, not just how many
 * adjectives they get — a standard-tier walnut is a walnut veneer, and saying
 * so is more useful to the model than saying "restrained detailing".
 */
const STYLE_BRIEFS: Record<string, Record<LuxuryLevel, string>> = {
  "Modern Indian": {
    Standard:
      "Clean-lined joinery in oak veneer and painted MDF, cotton upholstery, a granite or quartz counter. Warm even daylight, simple flush detailing.",
    Premium:
      "Solid teak and walnut joinery against plaster, linen and cotton upholstery, honed granite surfaces, slim brass inlay. Warm directional daylight, crisp shadow gaps.",
    "Ultra Luxury":
      "Book-matched walnut, hand-finished brass, honed marble and stone-clad surfaces, heavy linen and silk. Layered daylight with deep soft shadow, mitred joints throughout.",
  },
  "Luxury Indian": {
    Standard:
      "Dark-stained wood, patterned cotton, a marble-effect counter, modest brass hardware. Warm lamplight over even daylight, simple carved edges.",
    Premium:
      "Rosewood and teak with brass inlay, veined marble, silk and velvet upholstery, jaali screens. Warm pooled lamplight, rich shadow, ornamented margins.",
    "Ultra Luxury":
      "Carved rosewood, cast and hand-chased brass, book-matched veined marble, heavy silk and velvet, inlaid stone. Deep warm pooled light, jewelled saturated colour.",
  },
  "Traditional South Indian": {
    Standard:
      "Teak-toned wood, terracotta tile, cotton textiles, simple turned legs. Warm daylight through deep openings, plain painted colour fields.",
    Premium:
      "Solid teak with carved margins, red-oxide and terracotta floors, brass lamps and vessels, handloom cotton. Warm raking daylight, deep shadow under eaves.",
    "Ultra Luxury":
      "Aged solid teak with deep relief carving, polished red-oxide, antique brass, black granite, handwoven silk. Warm raking light, heavy carved timber ceilings.",
  },
  "Traditional North Indian": {
    Standard:
      "Dark wood frames, printed cotton, painted plaster in deep tones, simple brass pulls. Warm even light, modest arched detailing.",
    Premium:
      "Carved sheesham and mango wood, block-printed and embroidered cotton, sandstone and inlaid marble, arched niches. Warm layered light, saturated reds and golds.",
    "Ultra Luxury":
      "Intricately carved sheesham, marble inlay and pietra dura, mirrorwork, heavy embroidered silk, gilded margins. Deep warm pooled light, jewel-toned saturation.",
  },
  "Contemporary Indian": {
    Standard:
      "Light oak veneer, painted surfaces, cotton and wool upholstery, a quartz counter. Bright even daylight, minimal hardware, soft neutral fields.",
    Premium:
      "Light oak and walnut, textured plaster, wool and boucle upholstery, terrazzo and honed stone, matte black metal. Bright directional daylight, one bold accent.",
    "Ultra Luxury":
      "Wide-plank oak, sculptural stone, boucle and heavy wool, blackened steel and bright brass. Bright layered daylight, generous negative space, exacting joints.",
  },
  "Minimalist Indian": {
    Standard:
      "Pale oak veneer, painted surfaces, undyed cotton, a plain stone counter. Even soft daylight, no visible hardware, uninterrupted colour fields.",
    Premium:
      "Pale oak and plainly painted surfaces, undyed linen and cotton, honed limestone. Soft even daylight, concealed hardware, long uninterrupted planes.",
    "Ultra Luxury":
      "Wide pale oak, honed limestone and travertine, undyed linen and wool, hidden fixings throughout. Soft even daylight, near-empty surfaces, exacting shadow gaps.",
  },
  Scandinavian: {
    Standard:
      "Pale birch and painted white surfaces, wool and cotton textiles, simple tapered legs. Bright cool daylight, unfussy hardware, light neutral fields.",
    Premium:
      "Pale oak and ash, white-painted joinery, wool and sheepskin, matte white stone. Bright cool daylight, soft long shadows, restrained black metal detail.",
    "Ultra Luxury":
      "Wide pale oak, solid ash, undyed wool and sheepskin, honed white stone, blackened steel. Bright cool daylight, deep soft shadow, flawless simple joinery.",
  },
  "Temple / Pooja": {
    Standard:
      "Teak-toned wood, brass lamps and bells, marigold and vermilion accents, plain warm-toned surfaces. Warm lamplight, simple carved margins.",
    Premium:
      "Carved teak and rosewood, polished brass lamps and vessels, white marble, silk cloth, marigold and vermilion. Warm pooled lamplight, gilded margins.",
    "Ultra Luxury":
      "Deeply carved rosewood, gilded and hand-chased brass, white marble with inlay, heavy silk, silver vessels. Warm pooled lamplight against deep shadow.",
  },
};

/**
 * Fallback used when the style string matches no entry above — a Custom
 * project's free text, or a design-reference upload's derived style ("Retro
 * pastel cafe, rounded forms"). The style string itself is the most specific
 * thing available and is stated verbatim, with the luxury tier supplying the
 * material register a table lookup would otherwise have provided.
 *
 * This is why an unseen style needs no new code path: it degrades to a
 * composed brief rather than an error or an empty string.
 */
const LUXURY_FALLBACK: Record<LuxuryLevel, string> = {
  Standard: "Everyday-quality materials, simple hardware, even natural daylight, restrained detailing.",
  Premium: "Elevated natural materials, considered hardware, directional natural daylight, crisp detailing.",
  "Ultra Luxury": "Rare and heavy natural materials, bespoke hardware, layered daylight with deep soft shadow, exacting joints.",
};

/**
 * `{wood}` / `{soft}` / `{stone}`, interpolated into every furniture material
 * phrase (furniture-layout.ts). Per style AND per luxury level, because the
 * tier genuinely changes the species rather than just the adjective: a
 * standard-tier walnut is a walnut veneer, and a model told "walnut veneer
 * sideboard" renders something different from "solid walnut sideboard".
 */
const STYLE_TOKENS: Record<string, Record<LuxuryLevel, MaterialTokens>> = {
  "Modern Indian": {
    Standard: { wood: "oak veneer", soft: "grey cotton", stone: "speckled granite" },
    Premium: { wood: "teak", soft: "oatmeal linen", stone: "honed granite" },
    "Ultra Luxury": { wood: "book-matched walnut", soft: "heavy oatmeal linen", stone: "honed marble" },
  },
  "Luxury Indian": {
    Standard: { wood: "dark-stained wood", soft: "patterned cotton", stone: "marble-effect quartz" },
    Premium: { wood: "rosewood", soft: "deep indigo velvet", stone: "veined marble" },
    "Ultra Luxury": { wood: "carved rosewood", soft: "indigo silk velvet", stone: "book-matched veined marble" },
  },
  "Traditional South Indian": {
    Standard: { wood: "teak-toned wood", soft: "handloom cotton", stone: "terracotta tile" },
    Premium: { wood: "solid teak", soft: "handloom cotton", stone: "polished red oxide" },
    "Ultra Luxury": { wood: "aged carved teak", soft: "handwoven silk", stone: "black granite" },
  },
  "Traditional North Indian": {
    Standard: { wood: "dark mango wood", soft: "block-printed cotton", stone: "sandstone" },
    Premium: { wood: "carved sheesham", soft: "embroidered cotton", stone: "inlaid marble" },
    "Ultra Luxury": { wood: "carved sheesham", soft: "embroidered silk", stone: "pietra dura marble" },
  },
  "Contemporary Indian": {
    Standard: { wood: "light oak veneer", soft: "grey wool", stone: "white quartz" },
    Premium: { wood: "light oak", soft: "cream boucle", stone: "terrazzo" },
    "Ultra Luxury": { wood: "wide-plank oak", soft: "heavy cream boucle", stone: "sculptural travertine" },
  },
  "Minimalist Indian": {
    Standard: { wood: "pale oak veneer", soft: "undyed cotton", stone: "matte white stone" },
    Premium: { wood: "pale oak", soft: "undyed linen", stone: "honed limestone" },
    "Ultra Luxury": { wood: "wide pale oak", soft: "undyed heavy linen", stone: "honed travertine" },
  },
  Scandinavian: {
    Standard: { wood: "pale birch", soft: "grey wool", stone: "matte white stone" },
    Premium: { wood: "pale oak", soft: "natural sheepskin", stone: "honed white stone" },
    "Ultra Luxury": { wood: "wide pale oak", soft: "undyed wool", stone: "honed white marble" },
  },
  "Temple / Pooja": {
    Standard: { wood: "teak-toned wood", soft: "saffron cotton", stone: "cream marble-effect tile" },
    Premium: { wood: "carved teak", soft: "saffron silk", stone: "white marble" },
    "Ultra Luxury": { wood: "carved rosewood", soft: "gold-bordered silk", stone: "inlaid white marble" },
  },
};

const FALLBACK_TOKENS: Record<LuxuryLevel, MaterialTokens> = {
  Standard: { wood: "oak veneer", soft: "neutral cotton", stone: "pale quartz" },
  Premium: { wood: "walnut", soft: "oatmeal linen", stone: "honed limestone" },
  "Ultra Luxury": { wood: "solid walnut", soft: "heavy linen", stone: "honed marble" },
};

/**
 * One line per room type, at most GUIDANCE_MAX chars. Answers the same
 * question the planner's `compactGuidance` did: the single most important
 * thing about THAT room's materials, colour or light.
 *
 * Never furniture positions — a reference image already fixes those, and a
 * position stated here would compete with it. Keys are lowercased room types
 * and are matched after the same alias normalisation the furniture catalogue
 * uses, so "Hall" and "Drawing Room" reach the Living Room entry rather than
 * falling through.
 */
const ROOM_GUIDANCE: Record<string, string> = {
  "living room": "The largest uninterrupted daylight and the fullest material range in the space.",
  "dining room": "One pooled light source over the table; surfaces calmer than the living areas.",
  "living + dining": "One continuous material palette across both zones, lit from the longest window wall.",
  "master bedroom": "The quietest palette in the space, softest light, most textile of any room.",
  bedroom: "Calm and low-contrast, soft indirect light, textile-heavy surfaces.",
  "guest room": "Calm and simple, a slightly cooler palette than the main bedroom.",
  kitchen: "Hardest surfaces in the space; bright even task light with no deep shadow.",
  bathroom: "Continuous tiled and stone surfaces, bright even light, no soft furnishing.",
  study: "Focused task light at the desk, low-contrast walls, minimal pattern.",
  "work room": "Focused task light at the desk, low-contrast walls, minimal pattern.",
  "pooja room": "Warm pooled lamplight against deep shadow; the richest metal in the space.",
  foyer: "Darker and more compressed than the rooms beyond, one focal light.",
  utility: "Utilitarian hard surfaces, bright flat light, no decorative material.",
  "store room": "Plain hard surfaces and shelving, flat even light, no decorative material.",
  storage: "Plain hard surfaces and shelving, flat even light, no decorative material.",
  balcony: "Full outdoor daylight, weathered outdoor materials, planting.",
  garage: "Sealed floor and plain walls, flat even light, no domestic material.",
};

/** Basic colour anchors for naming a custom hex. A bare hex is a weak signal to
 *  an image model's text encoder; a NAME plus the hex is the strongest form
 *  available, so a custom palette gets both rather than six characters. */
const COLOUR_ANCHORS: { name: string; r: number; g: number; b: number }[] = [
  { name: "white", r: 255, g: 255, b: 255 },
  { name: "off-white", r: 240, g: 236, b: 227 },
  { name: "cream", r: 245, g: 232, b: 200 },
  { name: "beige", r: 214, g: 196, b: 162 },
  { name: "warm sand", r: 205, g: 178, b: 132 },
  { name: "light grey", r: 200, g: 200, b: 202 },
  { name: "mid grey", r: 140, g: 140, b: 145 },
  { name: "charcoal", r: 62, g: 62, b: 66 },
  { name: "black", r: 20, g: 20, b: 22 },
  { name: "brown", r: 120, g: 82, b: 52 },
  { name: "terracotta", r: 178, g: 88, b: 52 },
  { name: "red", r: 190, g: 44, b: 44 },
  { name: "pink", r: 232, g: 140, b: 170 },
  { name: "magenta", r: 197, g: 32, b: 175 },
  { name: "purple", r: 118, g: 58, b: 150 },
  { name: "indigo", r: 58, g: 47, b: 94 },
  { name: "blue", r: 48, g: 92, b: 178 },
  { name: "teal", r: 60, g: 140, b: 140 },
  { name: "sage green", r: 127, g: 160, b: 138 },
  { name: "green", r: 66, g: 130, b: 74 },
  { name: "olive", r: 110, g: 110, b: 62 },
  { name: "mustard", r: 198, g: 158, b: 52 },
  { name: "gold", r: 202, g: 166, b: 74 },
  { name: "orange", r: 224, g: 130, b: 46 },
];

/** Nearest anchor by squared RGB distance. Returns "name #hex", or "" for an unparseable value. */
export function nameHexColour(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  let best = COLOUR_ANCHORS[0];
  let bestD = Infinity;
  for (const a of COLOUR_ANCHORS) {
    const d = (a.r - r) ** 2 + (a.g - g) ** 2 + (a.b - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return `${best.name} #${m[1].toLowerCase()}`;
}

/** The style brief for this style and tier, or a composed fallback naming the style verbatim. */
function styleBriefFor(style: string, luxury: LuxuryLevel): string {
  const exact = STYLE_BRIEFS[style]?.[luxury];
  if (exact) return exact;
  const named = style.trim();
  return named ? `${named}. ${LUXURY_FALLBACK[luxury]}` : LUXURY_FALLBACK[luxury];
}

function tokensFor(style: string, luxury: LuxuryLevel): MaterialTokens {
  return STYLE_TOKENS[style]?.[luxury] ?? FALLBACK_TOKENS[luxury];
}

/**
 * The wall colour, resolved in priority order:
 *   1. an explicit preset palette's own `wallColour` (data.ts)
 *   2. the first custom hex, named — slot one IS the wall, which is the whole
 *      point of the change (see this file's header on the ivory-walls bug)
 *   3. the first comma-separated segment of a free-text palette, which is what
 *      a design-reference upload produces ("Bubblegum pink #F5A9C4, cream …")
 * Returns "" when nothing is resolvable, and prompt-builder then omits the
 * colour phrase entirely rather than stating a guess.
 */
export function wallColourFor(opts: {
  paletteId?: string;
  customHexes?: string[];
  colourPaletteText: string;
}): string {
  const preset = COLOUR_PALETTES.find((p) => p.id === opts.paletteId);
  if (preset?.wallColour) return clamp(preset.wallColour, WALL_COLOUR_MAX);

  const firstHex = opts.customHexes?.[0];
  if (firstHex) {
    const named = nameHexColour(firstHex);
    if (named) return clamp(named, WALL_COLOUR_MAX);
  }

  const firstSegment = opts.colourPaletteText.split(/[,;]/)[0]?.trim() ?? "";
  // Strip a leading preset label like "Warm White (cream and warm white walls"
  // down to what is inside the bracket, so the phrase reads as a colour rather
  // than as a palette name plus a dangling parenthesis.
  const unwrapped = firstSegment.includes("(") ? firstSegment.slice(firstSegment.indexOf("(") + 1) : firstSegment;
  return clamp(stripWallFinishes(unwrapped), WALL_COLOUR_MAX);
}

/** The accents: everything in the palette that is not the wall. */
function accentsFor(opts: { paletteId?: string; customHexes?: string[]; colourPaletteText: string }): string {
  const preset = COLOUR_PALETTES.find((p) => p.id === opts.paletteId);
  if (preset?.accentColours) return preset.accentColours;
  if (opts.customHexes && opts.customHexes.length > 1) {
    return opts.customHexes
      .slice(1)
      .map(nameHexColour)
      .filter(Boolean)
      .join(" and ");
  }
  const segments = opts.colourPaletteText.split(/[,;]/).slice(1);
  return stripWallFinishes(segments.join(",").replace(/\)\s*$/, "").trim());
}

/**
 * Builds the Design Specification from tables alone. Pure, synchronous, and
 * cheap enough to run per request — no cache, no AI call, no failure mode.
 *
 * Returns the SAME `DesignSpecification` shape `runDesignPlanning` returns, so
 * nothing downstream changes: prompt-builder, both flows, every budget and
 * every existing dev-check keep working against it unchanged.
 *
 * The six verbose fields are filled with short, honest values rather than left
 * empty. They have no reader in src/ (that is one of the reasons this file
 * exists), but they are part of the published type and a future Design page
 * that surfaces the spec should find something true there, not "".
 */
export function buildDesignSpec(
  input: UniversalInput,
  palette?: { paletteId?: string; customHexes?: string[] },
): DesignSpecification {
  const style = input.design.style.trim();
  const luxury = input.design.luxury_level;
  const brief = styleBriefFor(style, luxury);
  const tokens = tokensFor(style, luxury);

  const colourOpts = {
    paletteId: palette?.paletteId,
    customHexes: palette?.customHexes,
    colourPaletteText: input.design.colour_palette ?? "",
  };
  const wallColour = wallColourFor(colourOpts);
  const accents = accentsFor(colourOpts);

  // The palette does NOT go in compactBrief. prompt-builder slices the brief
  // section (label + brief + guidance) as a whole, so anything added there
  // costs the per-room guidance first — measured at ~343 chars against a
  // 300-char budget, which silently dropped the guidance entirely. wallColour
  // and accentColours ride in the never-trimmed medium line instead, which is
  // also where they belong: they are two halves of one statement about which
  // colour goes where, and the whole point of this file is that the user's
  // palette choice reaches the model intact.
  const compactBrief = clamp(stripWallFinishes(brief), BRIEF_MAX);

  return {
    // Verbose fields: no reader in src/, kept truthful and short rather than
    // padded out. See this file's header.
    designLanguage: `${style || "Contemporary"}, ${luxury.toLowerCase()} tier.`,
    materialPalette: `${tokens.wood}, ${tokens.soft}, ${tokens.stone}.`,
    lightingStrategy: "Natural daylight from the room's own openings as the dominant source.",
    colourStrategy: wallColour
      ? `${cap(wallColour)} walls${accents ? `, ${accents} accents` : ""}.`
      : "Palette applied to walls and soft furnishing.",
    furnitureLanguage: brief,
    cameraGuidelines: "Fixed by the greybox reference; not restated in the prompt.",
    negativeConstraints: "",
    compactBrief,
    wallColour,
    accentColours: accents,
    materialTokens: tokens,
    roomGuidelines: input.layout.rooms.map((room) => {
      const guidance = roomGuidanceFor(room);
      return { room: room.name, guidance, compactGuidance: guidance };
    }),
  };
}

function roomGuidanceFor(room: UniversalInputRoom): string {
  const key = (room.type ?? "").trim().toLowerCase();
  return clamp(ROOM_GUIDANCE[key] ?? "", GUIDANCE_MAX);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Exported for dev-check: every style in data.ts must have all three tiers. */
export function styleBriefCoverage(): { style: string; missing: LuxuryLevel[] }[] {
  const tiers: LuxuryLevel[] = ["Standard", "Premium", "Ultra Luxury"];
  return STYLES.map((s) => ({
    style: s.name,
    missing: tiers.filter((t) => !STYLE_BRIEFS[s.name]?.[t] || !STYLE_TOKENS[s.name]?.[t]),
  })).filter((r) => r.missing.length > 0);
}

export const DESIGN_SPEC_TABLE_BUDGETS = { BRIEF_MAX, GUIDANCE_MAX, WALL_COLOUR_MAX } as const;
