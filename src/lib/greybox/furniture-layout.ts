/**
 * Room-local [0,1] furniture placement (Room.furniture, src/lib/types.ts) <-> world-feet
 * coordinates (GreyboxRoomSpec.furniture, build-scene.ts) — the same relationship
 * plan-editor/geometry.ts's opening math has to the room's shape, just for furniture instead of
 * wall openings. Framework-free, like that file.
 */

import { catalogueEntry, furnitureForRoomType } from "./furniture-catalogue";
import type { GreyboxFurniturePlacement } from "./types";
import type { PlacedFurniture } from "@/lib/types";

/**
 * Converts a room's furniture list from normalised [0,1] room-local coordinates to the
 * world-feet, origin-centred coordinates build-scene.ts's buildGreyboxScene expects — the same
 * convention openingCentre already uses: x in [-width/2, width/2], z in [-depth/2, depth/2].
 * Unknown `kind`s (e.g. stale data after a catalogue edit) are silently dropped rather than
 * thrown on — a room shouldn't fail to render because one furniture item's catalogue entry
 * disappeared.
 */
export function toWorldFurniture(
  furniture: PlacedFurniture[],
  width: number,
  depth: number,
): GreyboxFurniturePlacement[] {
  return furniture
    .filter((f) => !!catalogueEntry(f.kind))
    .map((f) => ({
      kind: f.kind,
      x: (f.x - 0.5) * width,
      z: (f.z - 0.5) * depth,
      rotation: f.rotation,
    }));
}

/** Inverse of toWorldFurniture's position math, for the 3D editor reading a room-local rect. */
export function worldToLocal(x: number, z: number, width: number, depth: number): { x: number; z: number } {
  return { x: width > 0 ? x / width + 0.5 : 0.5, z: depth > 0 ? z / depth + 0.5 : 0.5 };
}

/**
 * A coarse, human-readable position from room-local [0,1] coordinates — "near the north wall",
 * "in the centre", etc. Same reading-order convention as openings' "side" (plan's up-is-north,
 * z=0 is north/-Z). Used to build the furniture prompt clause (prompt-builder.ts) — text support
 * for what the greybox reference image already shows, never a substitute for it.
 */
export function describeFurniturePosition(x: number, z: number): string {
  const ns = z < 0.33 ? "north" : z > 0.66 ? "south" : null;
  const ew = x < 0.33 ? "west" : x > 0.66 ? "east" : null;
  if (ns && ew) return `near the ${ns}${ew} corner`;
  if (ns) return `near the ${ns} wall`;
  if (ew) return `near the ${ew} wall`;
  return "in the centre of the room";
}

let seq = 0;
/** Timestamp+counter id, same shape as the Plan Editor's opening ids (plan-editor-canvas.tsx). */
function furnitureId(): string {
  return `f-${Date.now()}-${(seq++).toString(36)}`;
}

/**
 * Resolves a room's furniture list into the label+rough-position pairs the prompt clause needs
 * (UniversalInputFurniture, ai/prompting/types.ts) — the one place PlacedFurniture's catalogue
 * `kind` becomes a human-readable label. An unknown `kind` (stale data) is silently dropped,
 * same as toWorldFurniture.
 */
export function describeFurnitureForPrompt(
  furniture: PlacedFurniture[],
): { label: string; roughPosition: string }[] {
  return furniture
    .map((f) => {
      const entry = catalogueEntry(f.kind);
      if (!entry) return null;
      return { label: entry.label, roughPosition: describeFurniturePosition(f.x, f.z) };
    })
    .filter((x): x is { label: string; roughPosition: string } => x !== null);
}

/**
 * A starting arrangement for a room that has no furniture yet, so the 3D editor never opens to
 * an empty room — same "seed something to adjust, not a blank canvas" principle Phase A already
 * applied to openings (seedPlacedOpenings, plan-editor/geometry.ts). Picks the first 2-3 items
 * from this room type's catalogue slice and spreads them along the back wall (north, -Z) with
 * generous default spacing — a reasonable default, not a claim of interior-design competence;
 * the whole point of the editor is that the user can drag these anywhere.
 */
export function defaultFurnitureFor(roomType: string | undefined): PlacedFurniture[] {
  const items = furnitureForRoomType(roomType).slice(0, 3);
  if (items.length === 0) return [];
  return items.map((entry, i) => ({
    id: furnitureId(),
    kind: entry.kind,
    x: (i + 1) / (items.length + 1),
    z: 0.18,
    rotation: 0,
  }));
}
