/**
 * Furniture fit checks — a placed piece can never be arranged validly if it is
 * wider/deeper than the room or taller than the ceiling. Both the room design
 * page and the 2D Review inspector surface these so the user is told "exceeds
 * room width / depth / ceiling height" instead of the piece silently
 * overflowing the walls. Width→room width, Depth→room depth, Height→ceiling.
 */

export type Dim = "w" | "d" | "h";

export const DIM_META: Record<Dim, { full: string; against: string }> = {
  w: { full: "Width", against: "room width" },
  d: { full: "Depth", against: "room depth" },
  h: { full: "Height", against: "ceiling height" },
};

/** Default ceiling height (ft) when a room hasn't set one. */
export const DEFAULT_CEILING_FT = 9;

/** ignore sub-inch rounding noise so 8.0-in-an-8-ft-room doesn't false-alarm */
const EPS = 0.05;

export const roundFt = (n: number) => Math.round(n * 10) / 10;

export interface FitViolation {
  dim: Dim;
  value: number;
  limit: number;
  full: string;
  against: string;
}

/** Dimensions of `item` that exceed the room footprint / ceiling. */
export function fitViolations(
  item: { w: number; d: number; h: number },
  room: { width: number; height: number; ceilingFt?: number },
): FitViolation[] {
  const limits: Record<Dim, number> = {
    w: room.width,
    d: room.height,
    h: room.ceilingFt ?? DEFAULT_CEILING_FT,
  };
  return (["w", "d", "h"] as const)
    .filter((dim) => item[dim] > limits[dim] + EPS)
    .map((dim) => ({ dim, value: item[dim], limit: limits[dim], ...DIM_META[dim] }));
}
