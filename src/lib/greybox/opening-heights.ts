/**
 * Opening head/sill/ceiling heights in feet — split out of build-scene.ts so
 * that consumers which only need these numbers (validate-openings.ts) don't
 * transitively pull in three.js. build-scene.ts re-exports these unchanged
 * (and still uses them internally), so every existing import site keeps
 * working exactly as before; this is a pure extraction, not a value change.
 *
 * PERF: measured via `.next/diagnostics/route-bundle-stats.json` after
 * `npm run build` (2026-08-10) — /projects/[id]/plan carried
 * firstLoadUncompressedJsBytes of 1051.0KB vs. ~840KB on routes that never
 * touch greybox, because validate-openings.ts imported these constants from
 * build-scene.ts, and build-scene.ts does `import * as THREE from "three"`
 * at module scope. Moving the constants here lets the Plan editor route
 * validate openings without loading three.js at all.
 */
export const CEILING_H = 10;
export const DOOR_HEAD = 7;
export const WINDOW_SILL = 3;
export const WINDOW_HEAD = 7;
