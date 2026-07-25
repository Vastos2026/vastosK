import { ProviderError } from "@/lib/ai/errors";
import type { LuxuryLevel, UniversalInput } from "./types";

/**
 * Universal Input Schema builder — turns the frontend's room/style selections
 * into the one JSON shape every project category shares. This is the ONLY
 * place a UniversalInput gets constructed; the rest of the app (Design
 * Planning Layer, Prompt Builder) only ever consumes one, never builds one.
 * Also the input-validation boundary for this data (per the plan's Security
 * section: cap free-text length, reject an empty room list) — this runs
 * server-side even though the frontend should already enforce the same caps.
 */

const NOTES_MAX_LEN = 500;
const LUXURY_LEVELS: LuxuryLevel[] = ["Standard", "Premium", "Ultra Luxury"];

export interface RoomSelection {
  name: string;
  widthFt: number;
  heightFt: number;
  additionalNotes?: string;
}

export interface DesignSelection {
  style: string;
  luxuryLevel: LuxuryLevel;
  colourPalette: string;
}

export function buildUniversalInput(
  category: string,
  subcategory: string,
  rooms: RoomSelection[],
  design: DesignSelection,
): UniversalInput {
  if (!category.trim() || !subcategory.trim()) {
    throw new ProviderError("ValidationError", "project category/subcategory is required");
  }
  if (rooms.length === 0) {
    throw new ProviderError("ValidationError", "at least one room is required");
  }
  if (!LUXURY_LEVELS.includes(design.luxuryLevel)) {
    throw new ProviderError("ValidationError", `invalid luxury level: ${design.luxuryLevel}`);
  }
  if (!design.style.trim() || !design.colourPalette.trim()) {
    throw new ProviderError("ValidationError", "style and colour palette are required");
  }

  return {
    project: { category: category.trim(), subcategory: subcategory.trim() },
    layout: {
      rooms: rooms.map((r) => {
        if (!r.name.trim()) throw new ProviderError("ValidationError", "room name is required");
        if (!(r.widthFt > 0) || !(r.heightFt > 0)) {
          throw new ProviderError("ValidationError", `invalid dimensions for room "${r.name}"`);
        }
        const notes = r.additionalNotes?.trim();
        if (notes && notes.length > NOTES_MAX_LEN) {
          throw new ProviderError(
            "ValidationError",
            `additional requirements for "${r.name}" exceed ${NOTES_MAX_LEN} characters`,
          );
        }
        return {
          name: r.name.trim(),
          size: `${formatFt(r.widthFt)} x ${formatFt(r.heightFt)} ft`,
          ...(notes ? { additional_notes: notes } : {}),
        };
      }),
    },
    design: {
      style: design.style.trim(),
      luxury_level: design.luxuryLevel,
      colour_palette: design.colourPalette.trim(),
    },
  };
}

function formatFt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
