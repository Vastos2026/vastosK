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
  { id: "commercial", label: "Custom", description: "Clinics, restaurants, retail & more", icon: "Sparkles" },
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

/** Colour palette presets for the Design step's global colour picker. */
export const COLOUR_PALETTES: { id: string; label: string; swatch: string[] }[] = [
  { id: "Warm White", label: "Warm White", swatch: ["#f3ead3", "#c8a06a", "#7a5236"] },
  { id: "Cool Grey", label: "Cool Grey", swatch: ["#e9e6e1", "#9c8c7c", "#3a3a3d"] },
  { id: "Earthy Terracotta", label: "Earthy Terracotta", swatch: ["#e9d6b0", "#a8431f", "#3a1d12"] },
  { id: "Deep Jewel", label: "Deep Jewel", swatch: ["#caa64a", "#3a2f5e", "#14110d"] },
  { id: "Sage & Sand", label: "Sage & Sand", swatch: ["#e6e3d6", "#7fa08a", "#4f4a3a"] },
  { id: "Charcoal & Brass", label: "Charcoal & Brass", swatch: ["#d4972a", "#4f4f52", "#161616"] },
];

/** Unit systems for the dimension selector — ft/in is the default everywhere. */
export const UNITS: { id: import("./types").Unit; label: string }[] = [
  { id: "ft-in", label: "ft & in" },
  { id: "ft", label: "ft (decimal)" },
  { id: "m", label: "metres" },
  { id: "cm", label: "centimetres" },
];

export const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));
