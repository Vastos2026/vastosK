import type { Unit } from "./types";

/**
 * Unit formatting for every dimension the user sees or edits (Workstream 8.5).
 * Canonical storage is ALWAYS decimal feet (`Room.width`/`Room.height` etc.) —
 * every function here is a pure input/display conversion at the UI boundary,
 * nothing downstream of the store ever sees a non-feet number.
 */

const FT_PER_M = 3.280839895;
const FT_PER_CM = FT_PER_M / 100;

/** Decimal feet -> a human display string in the given unit. */
export function formatLength(feet: number, unit: Unit): string {
  if (!Number.isFinite(feet)) return "—";
  switch (unit) {
    case "ft-in": {
      const totalInches = Math.round(feet * 12);
      const ft = Math.trunc(totalInches / 12);
      const inch = totalInches - ft * 12;
      return `${ft}′ ${inch}″`;
    }
    case "m":
      return `${(feet / FT_PER_M).toFixed(2)} m`;
    case "cm":
      return `${(feet / FT_PER_CM).toFixed(0)} cm`;
    case "ft":
    default:
      return `${feet.toFixed(1)} ft`;
  }
}

/** Decimal feet -> the compact "W x H unit" pair used in room summaries. */
export function formatDimensions(widthFt: number, heightFt: number, unit: Unit): string {
  if (unit === "ft-in") return `${formatLength(widthFt, unit)} × ${formatLength(heightFt, unit)}`;
  const suffix = unit === "m" ? "m" : unit === "cm" ? "cm" : "ft";
  const w = unit === "m" ? widthFt / FT_PER_M : unit === "cm" ? widthFt / FT_PER_CM : widthFt;
  const h = unit === "m" ? heightFt / FT_PER_M : unit === "cm" ? heightFt / FT_PER_CM : heightFt;
  const decimals = unit === "cm" ? 0 : unit === "ft" ? 1 : 2;
  return `${w.toFixed(decimals)} × ${h.toFixed(decimals)} ${suffix}`;
}

/** A single decimal value in `unit` -> decimal feet (canonical storage). */
export function toFeet(value: number, unit: Unit): number {
  switch (unit) {
    case "m":
      return value * FT_PER_M;
    case "cm":
      return value * FT_PER_CM;
    case "ft":
    case "ft-in":
    default:
      return value;
  }
}

/** Decimal feet -> a single decimal value in `unit` (for editable number inputs). */
export function fromFeet(feet: number, unit: Unit): number {
  switch (unit) {
    case "m":
      return Math.round((feet / FT_PER_M) * 100) / 100;
    case "cm":
      return Math.round(feet / FT_PER_CM);
    case "ft":
    case "ft-in":
    default:
      return Math.round(feet * 10) / 10;
  }
}

/** Feet + inches (the ft-in editor's two number fields) -> decimal feet. */
export function ftInToFeet(ft: number, inches: number): number {
  return Math.round((ft + inches / 12) * 100) / 100;
}

/** Decimal feet -> {ft, inches} for the ft-in editor's two number fields. */
export function feetToFtIn(feet: number): { ft: number; inches: number } {
  const totalInches = Math.round(feet * 12);
  return { ft: Math.trunc(totalInches / 12), inches: totalInches - Math.trunc(totalInches / 12) * 12 };
}
