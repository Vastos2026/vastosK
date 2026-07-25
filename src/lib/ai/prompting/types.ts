/**
 * The Universal JSON Architecture (revamp plan, locked):
 *   Frontend Input → Universal Input JSON → Planning Layer →
 *   Design Specification JSON → Prompt Builder → Gemini
 *
 * The frontend only ever produces a UniversalInput. It never sees a prompt
 * string or a template. Only the Prompt Builder (prompt-builder.ts) turns
 * structured JSON into natural-language text, and only right before the
 * provider call.
 */

export interface UniversalInputOpening {
  type: "door" | "window";
  side: "north" | "south" | "east" | "west";
  /** another room's name, "exterior", or null */
  connectsTo: string | null;
}

export interface UniversalInputRoom {
  name: string;
  /** formatted for the schema boundary, e.g. "18 x 16 ft" — internally rooms use numeric width/height */
  size: string;
  /** free-text, per room — e.g. "Need lots of natural light.", "Include a pooja room." */
  additional_notes?: string;
  /**
   * Deterministically assigned post-merge (pipeline/assign-openings.ts) —
   * best-effort, so an empty/absent array means "none detected", never
   * "this room has no doors or windows". Never surfaced to the AI provider
   * before the Prompt Builder translates it to natural language.
   */
  openings?: UniversalInputOpening[];
}

export type LuxuryLevel = "Standard" | "Premium" | "Ultra Luxury";

export interface UniversalInput {
  project: {
    /** "Residential" | "Apartment" | "Commercial" | "Custom" */
    category: string;
    /** e.g. "Independent House", "2BHK Apartment", "Dental Clinic" */
    subcategory: string;
  };
  layout: {
    rooms: UniversalInputRoom[];
  };
  design: {
    style: string;
    luxury_level: LuxuryLevel;
    colour_palette: string;
  };
}

/** One room's slice of the Design Planning Layer's output. */
export interface RoomGuideline {
  /** matches a UniversalInputRoom.name */
  room: string;
  /** dense guidance for this room: furniture, layout, focal point, materials */
  guidance: string;
}

/**
 * The Design Specification — the Design Planning Layer's entire output.
 * Project-type-agnostic: the same shape for Residential, Apartment,
 * Commercial and Custom projects. Cached on projects.manifest so it's
 * produced once per project and reused for every room and every
 * "generate more", not regenerated per room.
 */
export interface DesignSpecification {
  designLanguage: string;
  materialPalette: string;
  lightingStrategy: string;
  colourStrategy: string;
  furnitureLanguage: string;
  cameraGuidelines: string;
  negativeConstraints: string;
  roomGuidelines: RoomGuideline[];
}
