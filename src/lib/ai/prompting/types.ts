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

// Type-only: MaterialTokens is a plain `{wood,soft,stone}` shape declared in
// furniture-layout.ts, but that module transitively imports
// furniture-catalogue.ts, which imports three.js and builds meshes. This
// prompting-layer module is server-side and must not acquire a runtime
// three.js dependency — `import type` is erased at compile time, so only the
// type survives here, never the module's runtime code.
import type { MaterialTokens } from "@/lib/greybox/furniture-layout";

export interface UniversalInputOpening {
  type: "door" | "window";
  side: "north" | "south" | "east" | "west";
  /** another room's name, "exterior", or null */
  connectsTo: string | null;
}

export interface UniversalInputRoom {
  name: string;
  /**
   * The room's semantic category (e.g. "Bedroom", "Pooja Room", "Kitchen"),
   * chosen on Room Confirmation from the active project category's fixed
   * list (or free text for Custom) — distinct from `name`, which is often
   * unreliable as a signal on its own (a detected/user-typed label like
   * "Ananya's Room" or "Chotu's Room" says nothing about what KIND of room
   * it is). Optional only because a room can genuinely have no type set yet
   * (detection missed it, or the user hasn't picked one) — never omitted
   * when a real value exists.
   */
  type?: string;
  /**
   * Formatted for the schema boundary, e.g. "18 x 16 ft" — internally rooms
   * use numeric width/height. Omitted (not a guessed size) when a room's
   * dimensions weren't given, so the image-generation prompt simply doesn't
   * mention a size for that room rather than stating a wrong one.
   */
  size?: string;
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
  /**
   * Section 4.4: the image prompt's per-room share is small, and `guidance`
   * routinely runs several hundred characters. This is the same intent
   * compressed to what fits.
   */
  compactGuidance: string;
}

/**
 * The Design Specification — the Design Planning Layer's entire output.
 * Project-type-agnostic: the same shape for Residential, Apartment,
 * Commercial and Custom projects. Cached on projects.manifest so it's
 * produced once per project and reused for every room and every
 * "generate more", not regenerated per room.
 */
export interface DesignSpecification {
  // Verbose fields — what the Design page shows the user and what makes a
  // spec auditable. Deliberately NO LONGER pasted into the image prompt:
  // together they exceed the whole 1800-char cap on their own.
  designLanguage: string;
  materialPalette: string;
  lightingStrategy: string;
  colourStrategy: string;
  furnitureLanguage: string;
  cameraGuidelines: string;
  negativeConstraints: string;
  /** Section 4.4's 240-char room brief: palette, key materials, light quality. */
  compactBrief: string;
  /**
   * The wall paint COLOUR alone, at most 40 chars ("warm sand", "soft
   * off-white") — a colour name, never a finish or a technique.
   *
   * Exists because Design Planning used to fold wall treatment into
   * compactBrief and would free-associate a finish noun onto the palette's
   * colour: the Sage & Sand palette's own "warm sand base" (data.ts) came
   * back as "warm sand lime-wash walls". That is the reported oily/waxy wall
   * look — the model was being told a wall TREATMENT, and rendered one.
   * Splitting the colour into its own field lets prompt-builder state the
   * finish itself, as ordinary matte paint, so no wall treatment is ever
   * named to the model at all.
   *
   * Optional, and read defensively: the local-first store persists whole
   * DesignSpecifications to localStorage, so a project planned before this
   * field existed has a cached spec without it. prompt-builder omits the
   * colour phrase in that case rather than printing "undefined".
   */
  wallColour?: string;
  /** Interpolated into furniture material phrases (furniture-layout.ts). */
  materialTokens: MaterialTokens;
  roomGuidelines: RoomGuideline[];
}
