import type { DesignStyle, PropertyType } from "./types";

export const PROPERTY_TYPES: {
  id: PropertyType;
  label: string;
  description: string;
  icon: string;
}[] = [
  { id: "apartment", label: "Apartment", description: "Flats & multi-unit homes", icon: "Building2" },
  { id: "villa", label: "Residential Home", description: "Independent houses & bungalows", icon: "Home" },
  { id: "office", label: "Office", description: "Workspaces & cabins", icon: "Briefcase" },
  // Maps to the welcome screen's "Custom" category (config/project-types/custom.json)
  // — clinics, restaurants, retail, temples, anything that isn't an office.
  { id: "commercial", label: "Custom", description: "Clinics, restaurants, retail & more", icon: "Store" },
];

/** Design styles with an Indian-interior focus (per the product spec). */
export const STYLES: DesignStyle[] = [
  { id: "modern-indian", name: "Modern Indian", tagline: "Clean lines with warm Indian warmth", palette: ["#1f1b16", "#c8a06a", "#e8ddcb", "#8c5a3b"] },
  { id: "luxury-indian", name: "Luxury Indian", tagline: "Marble, brass & deep jewel tones", palette: ["#14110d", "#caa64a", "#3a2f5e", "#f3ead3"] },
  { id: "south-indian", name: "Traditional South Indian", tagline: "Teak, terracotta & temple craft", palette: ["#3a1d12", "#a8431f", "#d99b54", "#e9d6b0"] },
  { id: "north-indian", name: "Traditional North Indian", tagline: "Carved wood, jaali & rich reds", palette: ["#2a0f12", "#9c2a2f", "#caa24a", "#efe2c6"] },
  { id: "contemporary", name: "Contemporary Indian", tagline: "Soft neutrals with bold accents", palette: ["#1a1a1d", "#5b8c8c", "#d98c6a", "#ece7e1"] },
  { id: "minimalist", name: "Minimalist Indian", tagline: "Quiet, light & uncluttered", palette: ["#161616", "#b9b1a6", "#e9e6e1", "#cdb89a"] },
  { id: "scandinavian", name: "Scandinavian", tagline: "Pale woods & airy whites", palette: ["#1d1d1f", "#cfd6d3", "#e9e4dc", "#b98a5e"] },
  { id: "pooja", name: "Temple / Pooja", tagline: "Sacred warmth in brass & gold", palette: ["#2a1606", "#d4972a", "#a13b1e", "#f0dcab"] },
];

/** Locked luxury-level presets (revamp plan) — a global Design-step field. */
export const LUXURY_LEVELS: { id: import("./ai/prompting/types").LuxuryLevel; label: string; tagline: string }[] = [
  { id: "Standard", label: "Standard", tagline: "Clean, functional, everyday-quality finishes" },
  { id: "Premium", label: "Premium", tagline: "Elevated materials, more detailing and craft" },
  { id: "Ultra Luxury", label: "Ultra Luxury", tagline: "Show-stopping materials, bespoke detailing" },
];

/**
 * Colour palette presets for the Design step's global colour picker.
 *
 * `wallColour` and `accentColours` split what `description` already said in
 * prose. That split is load-bearing, not cosmetic: the palette used to reach
 * the image model only after an LLM had read this description and decided for
 * itself which surface each colour belonged to. Handed three magentas it would
 * treat them as an accent scheme and paint the walls a safe neutral, which is
 * the reported "I chose pink and got ivory walls" bug. Naming the wall colour
 * as its own field means slot one IS the wall, with no interpretive step left
 * to overrule the user. `description` is unchanged and still goes to the
 * planner as the full palette statement.
 */
/**
 * The colour-palette text sent to the Design Planning call for a CUSTOM
 * palette: slot one is always the wall, the rest are accents — the user picks
 * them in that order (see the "Wall"/"Accent" swatch labels on the Design
 * page), so the string states the roles explicitly instead of handing the
 * model three unlabelled hexes and letting it guess. Guessing is what
 * produced the reported "I chose pink and got ivory walls" bug: the planner
 * read an unlabelled list as an accent scheme and picked a safe neutral for
 * the walls. Same fix as `wallColour` on the presets above, applied to the
 * one palette that has no preset row to carry it.
 *
 * Lives HERE rather than beside its call site in design/page.tsx, and this is
 * load-bearing: that page is `"use client"`, and a function exported from a
 * client module cannot be *called* from server code — Next throws
 * "Attempted to call buildCustomPaletteText() from the server" at runtime,
 * which a build passes straight over. /api/dev-check is a server route and
 * asserts this function's shape, so it has to sit in a plain shared module.
 * It cannot go in design-planning.ts either, which is "server-only" and so
 * unimportable from the client page in the other direction. data.ts already
 * holds COLOUR_PALETTES and is imported by both sides.
 *
 * Guards `colours.slice(1)` so an array shorter than 3 can never produce a
 * dangling " and " or an empty "; accent colours" clause: with no accents the
 * clause is omitted outright, and with exactly one it reads as that one
 * colour, no "and".
 */
export function buildCustomPaletteText(colours: string[]): string {
  const [wall, ...accents] = colours;
  const accentClause = accents.length > 0 ? `; accent colours ${accents.join(" and ")}` : "";
  return `Custom — wall colour ${wall}${accentClause}`;
}

export const COLOUR_PALETTES: {
  id: string;
  label: string;
  swatch: string[];
  description: string;
  /** The wall paint colour. A colour name only, never a finish or technique. */
  wallColour: string;
  /** Everything in the palette that is not the wall. */
  accentColours: string;
}[] = [
  { id: "Warm White", label: "Warm White", swatch: ["#f3ead3", "#c8a06a", "#7a5236"], description: "cream and warm white walls, honey oak tones, soft walnut brown accents", wallColour: "warm cream white", accentColours: "honey oak and soft walnut brown" },
  { id: "Cool Grey", label: "Cool Grey", swatch: ["#e9e6e1", "#9c8c7c", "#3a3a3d"], description: "soft greige and cool grey surfaces, warm taupe accents, charcoal detailing", wallColour: "soft cool greige", accentColours: "warm taupe and charcoal" },
  { id: "Earthy Terracotta", label: "Earthy Terracotta", swatch: ["#e9d6b0", "#a8431f", "#3a1d12"], description: "sandy cream base, burnt terracotta orange accents, deep umber brown", wallColour: "sandy cream", accentColours: "burnt terracotta orange and deep umber brown" },
  { id: "Deep Jewel", label: "Deep Jewel", swatch: ["#caa64a", "#3a2f5e", "#14110d"], description: "brushed gold accents, deep indigo-purple, near-black charcoal base", wallColour: "deep indigo purple", accentColours: "brushed gold and near-black charcoal" },
  { id: "Sage & Sand", label: "Sage & Sand", swatch: ["#e6e3d6", "#7fa08a", "#4f4a3a"], description: "warm sand base, muted sage green accents, deep olive-brown detailing", wallColour: "warm sand", accentColours: "muted sage green and deep olive brown" },
  { id: "Charcoal & Brass", label: "Charcoal & Brass", swatch: ["#d4972a", "#4f4f52", "#161616"], description: "near-black charcoal base, warm brass gold accents, mid-grey surfaces", wallColour: "near-black charcoal", accentColours: "warm brass gold and mid grey" },
];

/** Unit systems for the dimension selector — ft/in is the default everywhere. */
export const UNITS: { id: import("./types").Unit; label: string }[] = [
  { id: "ft-in", label: "ft & in" },
  { id: "ft", label: "ft (decimal)" },
  { id: "m", label: "metres" },
  { id: "cm", label: "centimetres" },
];

export const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));
