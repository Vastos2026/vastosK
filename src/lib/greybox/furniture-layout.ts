/**
 * Room-local [0,1] furniture placement (Room.furniture, src/lib/types.ts) <-> world-feet
 * coordinates (GreyboxRoomSpec.furniture, build-scene.ts) — the same relationship
 * plan-editor/geometry.ts's opening math has to the room's shape, just for furniture instead of
 * wall openings. Framework-free, like that file.
 */

import { catalogueEntry, FURNITURE_CATALOGUE, furnitureForRoomType } from "./furniture-catalogue";
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

let seq = 0;
/** Timestamp+counter id, same shape as the Plan Editor's opening ids (plan-editor-canvas.tsx). */
function furnitureId(): string {
  return `f-${Date.now()}-${(seq++).toString(36)}`;
}

export interface MaterialTokens {
  wood: string;
  soft: string;
  stone: string;
}

/**
 * Section 4.3. The furniture prompt line, derived from the SET OF TYPES
 * PRESENT — never from a hand-maintained string, and never from position.
 * Add a plant or remove a wardrobe and this line changes because the
 * derivation re-runs.
 *
 * Ordering is stable catalogue order, not insertion order: moving a piece in
 * the editor must not change the prompt text, or caches bust and A/B
 * comparisons stop being comparable.
 */
export function buildFurnitureMaterials(
  furniture: PlacedFurniture[],
  tokens: MaterialTokens,
  budget = 200,
): string {
  const present = new Map<string, number>();
  for (const f of furniture) {
    if (!catalogueEntry(f.kind)) continue;
    present.set(f.kind, (present.get(f.kind) ?? 0) + 1);
  }
  // Section 4.3: an empty array omits the line ENTIRELY, never "zero furniture pieces".
  if (present.size === 0) return "";

  let entries = FURNITURE_CATALOGUE.filter((e) => present.has(e.kind));
  const render = (list: typeof entries) =>
    `The dark massing volumes are furniture: ${joinList(list.map((e) => interpolate(e.materialPhrase, tokens)))}.`;

  // Drop lowest promptPriority first. Never truncate mid-phrase.
  while (render(entries).length > budget && entries.length > 1) {
    let worst = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].promptPriority < entries[worst].promptPriority) worst = i;
    }
    entries = entries.filter((_, i) => i !== worst);
  }

  return render(entries);
}

function interpolate(phrase: string, t: MaterialTokens): string {
  return phrase.replace(/\{wood\}/g, t.wood).replace(/\{soft\}/g, t.soft).replace(/\{stone\}/g, t.stone);
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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
