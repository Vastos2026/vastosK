import type { CatalogItem, DesignStyle, PropertyType } from "./types";

export const PROPERTY_TYPES: {
  id: PropertyType;
  label: string;
  description: string;
  icon: string;
}[] = [
  { id: "apartment", label: "Apartment", description: "Flats & multi-unit homes", icon: "Building2" },
  { id: "villa", label: "Villa", description: "Independent houses & bungalows", icon: "Home" },
  { id: "office", label: "Office", description: "Workspaces & cabins", icon: "Briefcase" },
  // Maps to the welcome screen's "Custom" category (config/project-types/custom.json)
  // — clinics, restaurants, retail, temples, anything that isn't an office.
  { id: "commercial", label: "Custom", description: "Clinics, restaurants, retail & more", icon: "Sparkles" },
];

/** Design styles with an Indian-interior focus (per the product spec). */
export const STYLES: DesignStyle[] = [
  {
    id: "modern-indian",
    name: "Modern Indian",
    tagline: "Clean lines with warm Indian warmth",
    palette: ["#1f1b16", "#c8a06a", "#e8ddcb", "#8c5a3b"],
    wallColor: "#e8ddcb",
    floorColor: "#7a5236",
    accentColor: "#c8a06a",
  },
  {
    id: "luxury-indian",
    name: "Luxury Indian",
    tagline: "Marble, brass & deep jewel tones",
    palette: ["#14110d", "#caa64a", "#3a2f5e", "#f3ead3"],
    wallColor: "#f3ead3",
    floorColor: "#d8cdb4",
    accentColor: "#caa64a",
  },
  {
    id: "south-indian",
    name: "Traditional South Indian",
    tagline: "Teak, terracotta & temple craft",
    palette: ["#3a1d12", "#a8431f", "#d99b54", "#e9d6b0"],
    wallColor: "#ead9b8",
    floorColor: "#8a3c20",
    accentColor: "#a8431f",
  },
  {
    id: "north-indian",
    name: "Traditional North Indian",
    tagline: "Carved wood, jaali & rich reds",
    palette: ["#2a0f12", "#9c2a2f", "#caa24a", "#efe2c6"],
    wallColor: "#efe2c6",
    floorColor: "#6e4327",
    accentColor: "#9c2a2f",
  },
  {
    id: "contemporary",
    name: "Contemporary Indian",
    tagline: "Soft neutrals with bold accents",
    palette: ["#1a1a1d", "#5b8c8c", "#d98c6a", "#ece7e1"],
    wallColor: "#ece7e1",
    floorColor: "#9c8c7c",
    accentColor: "#d98c6a",
  },
  {
    id: "minimalist",
    name: "Minimalist Indian",
    tagline: "Quiet, light & uncluttered",
    palette: ["#161616", "#b9b1a6", "#e9e6e1", "#cdb89a"],
    wallColor: "#f1efea",
    floorColor: "#cdbfa9",
    accentColor: "#b9a37c",
  },
  {
    id: "scandinavian",
    name: "Scandinavian",
    tagline: "Pale woods & airy whites",
    palette: ["#1d1d1f", "#cfd6d3", "#e9e4dc", "#b98a5e"],
    wallColor: "#f4f1ec",
    floorColor: "#d9c3a3",
    accentColor: "#7fa0a0",
  },
  {
    id: "pooja",
    name: "Temple / Pooja",
    tagline: "Sacred warmth in brass & gold",
    palette: ["#2a1606", "#d4972a", "#a13b1e", "#f0dcab"],
    wallColor: "#f0dcab",
    floorColor: "#7a4a1e",
    accentColor: "#d4972a",
  },
];

export const CATALOG: CatalogItem[] = [
  { id: "sofa-3", name: "3-Seater Sofa", category: "seating", w: 7, d: 3, h: 2.8, color: "#7c5a3f", icon: "Armchair" },
  { id: "armchair", name: "Accent Chair", category: "seating", w: 2.8, d: 2.8, h: 2.8, color: "#8a6b4a", icon: "Armchair" },
  { id: "coffee-table", name: "Coffee Table", category: "tables", w: 3.5, d: 2, h: 1.4, color: "#5c4633", icon: "Table" },
  { id: "dining-table", name: "Dining Table (6)", category: "tables", w: 6, d: 3.5, h: 2.5, color: "#6b4f37", icon: "Table" },
  { id: "dining-chair", name: "Dining Chair", category: "seating", w: 1.6, d: 1.6, h: 3, color: "#5c4633", icon: "Armchair" },
  { id: "bed-queen", name: "Queen Bed", category: "beds", w: 6, d: 7, h: 2, color: "#9a7b58", icon: "BedDouble" },
  { id: "wardrobe", name: "Wardrobe", category: "storage", w: 5, d: 2, h: 7, color: "#4f3b29", icon: "DoorClosed" },
  { id: "tv-unit", name: "TV Unit", category: "storage", w: 5.5, d: 1.4, h: 1.6, color: "#3a2d20", icon: "Tv" },
  { id: "bookshelf", name: "Bookshelf", category: "storage", w: 3, d: 1.2, h: 6, color: "#5c4633", icon: "BookOpen" },
  { id: "floor-lamp", name: "Floor Lamp", category: "lighting", w: 1.2, d: 1.2, h: 5, color: "#c8a06a", icon: "Lamp" },
  { id: "pendant", name: "Pendant Light", category: "lighting", w: 1.5, d: 1.5, h: 1, color: "#caa64a", icon: "Lightbulb" },
  { id: "rug", name: "Area Rug", category: "decor", w: 8, d: 5, h: 0.1, color: "#9c2a2f", icon: "Frame" },
  { id: "plant", name: "Indoor Plant", category: "decor", w: 1.6, d: 1.6, h: 3.5, color: "#4f7a4f", icon: "Sprout" },
  { id: "pooja-unit", name: "Pooja Mandir", category: "decor", w: 3, d: 1.6, h: 5, color: "#d4972a", icon: "Flame" },
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

export const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));
export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));

export const FURNITURE_CATEGORIES: { id: CatalogItem["category"]; label: string }[] = [
  { id: "seating", label: "Seating" },
  { id: "tables", label: "Tables" },
  { id: "beds", label: "Beds" },
  { id: "storage", label: "Storage" },
  { id: "lighting", label: "Lighting" },
  { id: "decor", label: "Decor" },
];
