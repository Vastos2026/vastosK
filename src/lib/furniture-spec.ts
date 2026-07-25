/**
 * How a DETECTED furniture/fixture becomes a placed item.
 *
 * Shared by the parse pipeline's merge stage and the per-room detection client
 * so both speak one vocabulary. Fixtures that have no catalog equivalent (WC,
 * wash basin, kitchen platform) use synthetic `det-*` ids — they're real things
 * drawn on the plan, so they must be representable even though you can't add
 * them from the catalog picker.
 */

export interface FurnitureSpec {
  name: string;
  catalogId: string;
  /** height in feet */
  h: number;
  color: string;
}

/** Detected furniture TYPE (the vision vocabulary) → display name, height, colour. */
export const FURNITURE_SPEC: Record<string, FurnitureSpec> = {
  sofa: { name: "Sofa", catalogId: "sofa-3", h: 2.8, color: "#7c5a3f" },
  chair: { name: "Chair", catalogId: "armchair", h: 2.8, color: "#8a6b4a" },
  bed: { name: "Bed", catalogId: "bed-queen", h: 2, color: "#9a7b58" },
  table: { name: "Table", catalogId: "coffee-table", h: 1.5, color: "#5c4633" },
  dining_table: { name: "Dining Table", catalogId: "dining-table", h: 2.5, color: "#6b4f37" },
  toilet: { name: "Toilet", catalogId: "det-toilet", h: 1.4, color: "#cdd2d8" },
  sink: { name: "Wash Basin", catalogId: "det-sink", h: 2.8, color: "#cdd2d8" },
  wardrobe: { name: "Wardrobe", catalogId: "wardrobe", h: 7, color: "#4f3b29" },
  tv: { name: "TV Unit", catalogId: "tv-unit", h: 1.6, color: "#3a2d20" },
  stove: { name: "Kitchen Platform", catalogId: "det-stove", h: 3, color: "#5c4633" },
  plant: { name: "Indoor Plant", catalogId: "plant", h: 3.5, color: "#4f7a4f" },
  other: { name: "Fixture", catalogId: "det-other", h: 2.4, color: "#7a6a55" },
};

/**
 * Resolve a FREE-TEXT label from vision ("WC", "Queen Bed", "L-Sofa",
 * "kitchen_platform") onto a spec. Ordered longest/most-specific first so
 * "dining table" doesn't match the bare "table" rule. Returns undefined when
 * nothing sensible matches, so the caller can report it instead of guessing.
 */
const RULES: { words: string[]; type: string }[] = [
  { words: ["dining table", "dining_table", "dining"], type: "dining_table" },
  { words: ["kitchen platform", "kitchen_platform", "counter", "platform", "stove", "hob", "cooktop"], type: "stove" },
  { words: ["wash basin", "wash_basin", "washbasin", "basin", "sink"], type: "sink" },
  { words: ["toilet", "wc", "water closet", "commode"], type: "toilet" },
  { words: ["wardrobe", "almirah", "closet"], type: "wardrobe" },
  { words: ["tv unit", "tv_unit", "television", "tv"], type: "tv" },
  { words: ["sofa", "settee", "couch"], type: "sofa" },
  { words: ["armchair", "accent chair", "chair"], type: "chair" },
  { words: ["bed"], type: "bed" },
  { words: ["plant"], type: "plant" },
  { words: ["table", "desk"], type: "table" },
];

export function specForLabel(label: string): FurnitureSpec | undefined {
  const n = (label || "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (!n) return undefined;
  for (const r of RULES) {
    if (r.words.some((w) => n.includes(w))) return FURNITURE_SPEC[r.type];
  }
  return undefined;
}
