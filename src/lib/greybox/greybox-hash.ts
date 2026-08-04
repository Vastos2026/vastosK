/**
 * Content hash of everything renderGreyboxToDataUri reads, so a cached
 * greyboxKey can be invalidated the moment any of it changes.
 *
 * Before this existed, ensure-greybox-key.ts short-circuited on
 * `if (room.greyboxKey) return room.greyboxKey` and nothing anywhere in src/
 * ever cleared that field — so editing a door in the Plan editor after
 * generating silently reused the stale reference image.
 *
 * Deliberately NOT a crypto hash: this runs in the browser on every gallery
 * mount and only needs to detect change, not resist forgery. FNV-1a over a
 * canonical JSON string is stable across reloads and machines, which
 * Object.entries ordering alone would not be.
 */
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

/**
 * Bump to invalidate every cached greybox at once. Incremented when the
 * render's own output changes (value ladder, camera, resolution) rather than
 * when a room's data changes.
 *
 * 2 — 2026-08-03: section 3 value ladder, level camera, supersampled render.
 */
export const GREYBOX_RENDER_VERSION = 2;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * General-purpose non-crypto string hash (FNV-1a) — not greybox-specific.
 * Exported so other modules that just need "detect if this string changed",
 * not cryptographic resistance, can reuse it instead of redeclaring the same
 * ~7-line function (prompt-builder.ts's per-generation prompt-change log
 * line is the first other caller).
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function greyboxHashFor(
  room: Pick<Room, "width" | "height" | "placedOpenings" | "furniture">,
): string {
  const { width, height } = layoutSize(room);
  const openings = [...(room.placedOpenings ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => [o.type, o.wall, round(o.t, 4), round(o.widthFt, 4)]);
  const furniture = [...(room.furniture ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => [f.kind, round(f.x, 4), round(f.z, 4), round(f.rotation, 4)]);
  return fnv1a(
    JSON.stringify({ w: round(width, 3), d: round(height, 3), o: openings, f: furniture, v: GREYBOX_RENDER_VERSION }),
  );
}
