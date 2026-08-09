/**
 * Section 5. Users cannot relocate openings, but Gemini-placed and
 * user-dragged geometry still needs checking.
 *
 * Fails CLOSED and never auto-repairs. Silently moving an opening to make a
 * render succeed breaks the one guarantee this whole product rests on — that
 * the output's doors and windows are where the user put them.
 */
// PERF: imported from opening-heights.ts, not build-scene.ts — build-scene.ts
// pulls in three.js at module scope, and this file is reachable from the
// Plan editor route, which never renders 3D. See opening-heights.ts's doc
// comment for the measured before/after.
import { CEILING_H, DOOR_HEAD, WINDOW_HEAD } from "./opening-heights";
import type { GreyboxWall } from "./types";
import type { PlacedOpening } from "@/lib/types";

export interface OpeningViolation {
  openingIds: string[];
  wall: GreyboxWall;
  message: string;
}

/** Section 5.2 — solid wall required between adjacent openings. */
const MIN_SEPARATION_FT = 0.5;
/** Section 5.3 — corner posts are 0.22ft; an opening flush to a corner reads as a missing wall. */
const CORNER_CLEARANCE_FT = 0.75;
/** Section 5.6 — narrower than this reads as a niche, not an opening. */
const MIN_SPAN_FT = 2.0;

export function validateOpenings(
  openings: PlacedOpening[],
  widthFt: number,
  depthFt: number,
): OpeningViolation[] {
  const out: OpeningViolation[] = [];

  // Section 5.5 — assert rather than check, so a future CEILING_H change
  // cannot silently produce a wall-less opening.
  if (DOOR_HEAD >= CEILING_H || WINDOW_HEAD >= CEILING_H) {
    throw new Error(`Opening head height (${Math.max(DOOR_HEAD, WINDOW_HEAD)}ft) is not below CEILING_H (${CEILING_H}ft)`);
  }

  const wallLen = (wall: GreyboxWall) => (wall === "north" || wall === "south" ? widthFt : depthFt);
  const byWall = new Map<GreyboxWall, PlacedOpening[]>();
  for (const o of openings) {
    const list = byWall.get(o.wall);
    if (list) list.push(o);
    else byWall.set(o.wall, [o]);
  }

  for (const [wall, list] of byWall) {
    const L = wallLen(wall);
    const spans = list
      .map((o) => {
        // o.widthFt is absolute feet; halve and divide by the wall's length
        // to get the same normalised half-width fraction `lo`/`hi` need.
        const halfFrac = o.widthFt / (2 * L);
        return { o, lo: o.t - halfFrac, hi: o.t + halfFrac };
      })
      .sort((a, b) => a.lo - b.lo);

    for (const s of spans) {
      const spanFt = s.o.widthFt;
      if (spanFt < MIN_SPAN_FT) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} is only ${spanFt.toFixed(1)}ft wide — it reads as a niche, not an opening. Widen it to at least ${MIN_SPAN_FT}ft.`,
        });
      }
      if (s.lo < 0 || s.hi > 1) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} runs past the end of the ${wall} wall.`,
        });
        continue;
      }
      const clearance = CORNER_CLEARANCE_FT / L;
      if (s.lo < clearance || s.hi > 1 - clearance) {
        out.push({
          openingIds: [s.o.id],
          wall,
          message: `This ${s.o.type} sits closer than ${CORNER_CLEARANCE_FT}ft to a corner of the ${wall} wall — it will read as a missing wall.`,
        });
      }
    }

    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (cur.lo < prev.hi) {
        out.push({
          openingIds: [prev.o.id, cur.o.id],
          wall,
          message: `A ${prev.o.type} and a ${cur.o.type} overlap on the ${wall} wall.`,
        });
      } else if ((cur.lo - prev.hi) * L < MIN_SEPARATION_FT) {
        out.push({
          openingIds: [prev.o.id, cur.o.id],
          wall,
          message: `Only ${((cur.lo - prev.hi) * L).toFixed(2)}ft of solid wall between a ${prev.o.type} and a ${cur.o.type} on the ${wall} wall — at least ${MIN_SEPARATION_FT}ft is required.`,
        });
      }
    }
  }

  return out;
}
