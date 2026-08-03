"use client";

import { renderGreyboxBundle } from "./render-mask";
import { greyboxHashFor } from "./greybox-hash";
import { toWorldFurniture } from "./furniture-layout";
import { seedPlacedOpenings } from "@/lib/plan-editor/geometry";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { Room } from "@/lib/types";

export type GreyboxResult = Pick<Room, "greyboxKey" | "greyboxMaskKey" | "greyboxHash" | "greyboxLedger">;

/**
 * Returns this room's greybox reference, rendering and uploading a fresh one
 * whenever the cached hash no longer matches the room's current geometry.
 *
 * The hash check replaces a plain `if (room.greyboxKey) return it` short
 * circuit. Nothing in src/ ever cleared greyboxKey, so editing a door in the
 * Plan editor after generating silently reused the stale reference image.
 *
 * Deliberately does NOT write to the store — that's the caller's job (every
 * call site already has the store in scope), so this stays a plain, easily
 * followed I/O function: render, upload, return.
 */
export async function ensureGreybox(projectId: string, room: Room): Promise<GreyboxResult | undefined> {
  const openings = room.placedOpenings?.length
    ? room.placedOpenings
    : // A manually-entered room never passed through the Plan editor, so it has
      // door/window counts per side but no positions. Spreading them evenly along
      // their walls gives real opening conditioning instead of falling back to
      // text-only. room.shape is NOT required: it is the rectangle on the plan
      // IMAGE, which the greybox never reads.
      seedPlacedOpenings(room.openings ?? [], room.width, room.height);

  const hash = greyboxHashFor({ ...room, placedOpenings: openings });
  if (room.greyboxKey && room.greyboxHash === hash) {
    return {
      greyboxKey: room.greyboxKey,
      greyboxMaskKey: room.greyboxMaskKey,
      greyboxHash: room.greyboxHash,
      greyboxLedger: room.greyboxLedger,
    };
  }

  // See layoutSize's own doc comment: it must not be used to build an AI
  // prompt or display a size as fact. This doesn't — the greybox's contract is
  // camera + openings only, never a claim about the room's real size — so an
  // internal rendering proportion is a deliberate narrow exception.
  const { width, height } = layoutSize(room);
  const { dataUri, maskDataUri, projected } = renderGreyboxBundle({
    width,
    depth: height,
    openings,
    furniture: toWorldFurniture(room.furniture ?? [], width, height),
  });

  const res = await fetch("/api/upload-greybox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, dataUri, maskDataUri, projected }),
  });
  if (!res.ok) throw new Error(`Greybox upload failed (${res.status})`);
  const { key, maskKey, ledger } = (await res.json()) as {
    key: string;
    maskKey: string;
    ledger: { doors: number; windows: number };
  };
  return { greyboxKey: key, greyboxMaskKey: maskKey, greyboxHash: hash, greyboxLedger: ledger };
}
