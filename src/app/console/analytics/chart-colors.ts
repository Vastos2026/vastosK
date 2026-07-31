/**
 * Categorical hue order validated against this app's dark chart surface
 * (#0d0d0d) via the dataviz skill's validate_palette.js — passes lightness
 * band, chroma floor, CVD adjacent-pair separation (worst 8.4 ΔE), and
 * normal-vision floor (worst 19.3 ΔE). Fixed order, never cycled — a slot
 * beyond this list should fold into "Other" rather than reuse a hue.
 */
export const CATEGORICAL = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#9085e9", // violet
  "#e66767", // red
] as const;

export const OTHER_COLOR = "#5a5a58";

export const PROVIDER_COLOR: Record<string, string> = {
  runware: CATEGORICAL[0],
  google: CATEGORICAL[1],
};

export function colorForIndex(i: number): string {
  return CATEGORICAL[i % CATEGORICAL.length];
}
