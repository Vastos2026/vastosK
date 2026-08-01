"use client";

import { renderGreyboxToDataUri } from "./render-to-data-uri";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

/**
 * Returns this room's greybox reference storage key, rendering + uploading
 * one now if it doesn't have one yet. A room with no `shape` (never placed
 * in the Plan Editor) has nothing to render and returns undefined, so the
 * caller falls back to the text-only openings clause exactly as it did
 * before this feature existed.
 *
 * Deliberately does NOT write the key onto the store itself — that's the
 * caller's job (it already has the store in scope at every call site), so
 * this stays a plain, easily-followed I/O function: render, upload, return.
 */
export async function ensureGreyboxKey(projectId: string, room: Room): Promise<string | undefined> {
  if (room.greyboxKey) return room.greyboxKey;
  if (!room.shape) return undefined;

  // `room.shape` is a rect NORMALISED TO THE PLAN IMAGE, not feet — its
  // absolute magnitude (e.g. 0.2) carries no real-world size, only the
  // positions/spans of openings placed on it (already unitless 0..1
  // fractions of each wall, unaffected by this). The greybox's ceiling
  // height and camera eye height are fixed FEET-scale constants
  // (build-scene.ts/camera.ts), so the room footprint handed to it must be
  // feet-scale too — layoutSize gives the room's real printed/entered
  // dimensions when known, or the same flat default every other geometry
  // fallback in this app already uses when they aren't. layoutSize's own
  // doc comment warns not to use it to build an AI prompt or display a size
  // as fact — this doesn't: the greybox's contract is camera + openings
  // only (see the design spec), never a claim about the room's real size,
  // so an internal rendering proportion is a deliberate narrow exception,
  // not an oversight of that warning.
  const { width, height } = layoutSize(room);
  const dataUri = renderGreyboxToDataUri({
    width,
    depth: height,
    openings: room.placedOpenings ?? [],
  });

  const res = await fetch("/api/upload-greybox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, dataUri }),
  });
  if (!res.ok) throw new Error(`Greybox upload failed (${res.status})`);
  const { key } = (await res.json()) as { key: string };
  return key;
}
