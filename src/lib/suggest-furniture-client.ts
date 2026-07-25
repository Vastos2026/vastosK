/**
 * Client helper for AI furniture suggestions (`POST /api/suggest-furniture`).
 *
 * Asks Gemini to place catalog furniture into the parsed rooms, then resolves
 * each placement into a ghost `PlacedItem` (clamped inside its room, with the
 * catalog's real footprint/colour). Returns null on any failure so the caller
 * can fall back to the rule-based suggestion.
 */

import type { FloorPlan, PlacedItem } from "./types";
import { CATALOG, CATALOG_BY_ID } from "./data";
import { uid } from "./utils";

interface Placement {
  roomId: string;
  catalogId: string;
  xFt: number;
  yFt: number;
  rotationDeg: number;
}

export async function suggestFurnitureAI(
  plan: FloorPlan,
  styleName: string,
): Promise<PlacedItem[] | null> {
  const res = await fetch("/api/suggest-furniture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      styleName,
      rooms: plan.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })),
      catalog: CATALOG.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        w: c.w,
        d: c.d,
      })),
    }),
  });

  if (!res.ok) return null;

  let placements: Placement[];
  try {
    placements = ((await res.json()) as { placements?: Placement[] }).placements ?? [];
  } catch {
    return null;
  }
  if (!placements.length) return null;

  const ghosts: PlacedItem[] = [];
  for (const p of placements) {
    const c = CATALOG_BY_ID[p.catalogId];
    const room = plan.rooms.find((r) => r.id === p.roomId);
    if (!c || !room) continue; // ignore hallucinated ids
    // Clamp the item fully inside its room.
    const x = clamp(p.xFt, room.x, Math.max(room.x, room.x + room.width - c.w));
    const y = clamp(p.yFt, room.y, Math.max(room.y, room.y + room.height - c.d));
    ghosts.push({
      id: uid("ghost"),
      catalogId: p.catalogId,
      name: c.name,
      roomId: room.id,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      rotation: [0, 90, 180, 270].includes(p.rotationDeg) ? p.rotationDeg : 0,
      w: c.w,
      d: c.d,
      h: c.h,
      color: c.color,
      ghost: true,
    });
  }
  return ghosts.length ? ghosts : null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
