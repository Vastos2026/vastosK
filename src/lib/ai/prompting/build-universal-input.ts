import { ProviderError } from "@/lib/ai/errors";
import type { LuxuryLevel, UniversalInput, UniversalInputOpening } from "./types";

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
  /** the room's semantic category (e.g. "Bedroom") — see UniversalInputRoom.type */
  type?: string;
  /** Undefined when the room's dimensions weren't given (not printed on the plan, not filled in on Room Confirmation) — no longer rejected, see UniversalInputRoom.size. */
  widthFt?: number;
  heightFt?: number;
  additionalNotes?: string;
  openings?: UniversalInputOpening[];
}

export interface DesignSelection {
  style: string;
  luxuryLevel: LuxuryLevel;
  colourPalette: string;
}

/**
 * Room-size string for a generation payload's `size` field — 1-decimal
 * rounding, or undefined when either dimension is missing (never a
 * fabricated size). Exported so every call site that builds a room payload
 * (this function below, and the Design page's auto-fire loop / Generate
 * page's `generateMore`, which build `UniversalInputRoom` payloads directly
 * without going through `buildUniversalInput`) uses the same convention
 * instead of each re-deriving its own guard and its own rounding.
 */
export function formatRoomSize(widthFt: number | undefined, heightFt: number | undefined): string | undefined {
  if (widthFt === undefined || !(widthFt > 0) || heightFt === undefined || !(heightFt > 0)) return undefined;
  return `${formatFt(widthFt)} x ${formatFt(heightFt)} ft`;
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
        // Missing dimensions are no longer rejected — a room Gemini couldn't
        // read a printed size for (or that the user hasn't filled in yet) is
        // a real, expected state now, not a validation failure. `size` is
        // just omitted below so the room prompt doesn't state a wrong size.
        const size = formatRoomSize(r.widthFt, r.heightFt);
        const notes = r.additionalNotes?.trim();
        if (notes && notes.length > NOTES_MAX_LEN) {
          throw new ProviderError(
            "ValidationError",
            `additional requirements for "${r.name}" exceed ${NOTES_MAX_LEN} characters`,
          );
        }
        return {
          name: r.name.trim(),
          ...(size ? { size } : {}),
          ...(r.type?.trim() ? { type: r.type.trim() } : {}),
          ...(notes ? { additional_notes: notes } : {}),
          ...(r.openings?.length ? { openings: r.openings } : {}),
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
