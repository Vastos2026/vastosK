"use client";

import { renderGreyboxBundle, type ProjectedOpening } from "./render-mask";
import { greyboxHashFor } from "./greybox-hash";
import { toWorldFurniture } from "./furniture-layout";
import { greyboxCamera, projectOpenings } from "./camera";
import { GREYBOX_ASPECT } from "./dimensions";
import { seedPlacedOpenings } from "@/lib/plan-editor/geometry";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import type { GreyboxRoomSpec } from "./types";
import type { Room } from "@/lib/types";

/**
 * `projected` is NOT one of Room's own persisted fields (nothing about a
 * locked camera's pixel projection belongs in the store) — it's derived fresh
 * on every call (see below) so callers always have it, cache hit or miss.
 */
export type GreyboxResult = Pick<Room, "greyboxKey" | "greyboxMaskKey" | "greyboxHash" | "greyboxLedger"> & {
  projected: ProjectedOpening[];
};

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
 *
 * `projected` — each opening's pixel position through the locked camera —
 * used to be available only on a cache MISS, because it was a byproduct of
 * `renderGreyboxBundle`'s own WebGL render pass. That was a real bug, not a
 * missing nice-to-have: `/api/generate-room-image` (Task 13) deliberately
 * ignores any client-sent opening count and re-derives the ledger itself via
 * `countOpenings(mask, projected)` — with no `projected`, `countOpenings`'s
 * `typeByLabel` map stays empty and the ledger silently comes back
 * `{doors: 0, windows: 0}` even though the mask shows real openings, telling
 * the model every wall is solid. Since a cache HIT is the common path (save,
 * then generate without touching geometry), this would have fired on nearly
 * every generation. The fix: `projectOpenings` is pure camera math (build the
 * same locked camera, project each opening's centre through it) — not a
 * render — so it's cheap enough to run on BOTH branches without defeating the
 * cache's actual purpose, which is skipping the expensive WebGL render pass
 * and the R2 upload, never this.
 */
export async function ensureGreybox(projectId: string, room: Room): Promise<GreyboxResult | undefined> {
  const openings = room.placedOpenings?.length
    ? room.placedOpenings
    : // A manually-entered room never passed through the Plan editor, so it has
      // door/window counts per side but no positions. Spreading them evenly along
      // their walls gives real opening conditioning instead of falling back to
      // text-only. room.shape is NOT required: it is the rectangle on the plan
      // IMAGE, which the greybox never reads.
      seedPlacedOpenings(room.openings ?? []);

  // See layoutSize's own doc comment: it must not be used to build an AI
  // prompt or display a size as fact. This doesn't — the greybox's contract is
  // camera + openings only, never a claim about the room's real size — so an
  // internal rendering proportion is a deliberate narrow exception.
  const { width, height } = layoutSize(room);
  // Built once, before the cache-hit branch returns, so both branches can
  // derive `projected` from the identical spec a fresh render would use.
  const spec: GreyboxRoomSpec = {
    width,
    depth: height,
    openings,
    furniture: toWorldFurniture(room.furniture ?? [], width, height),
    // Undefined here means "auto", which is greyboxCamera's own default, so a
    // room that never chose an angle renders exactly as it always did.
    cameraView: room.cameraView,
  };

  const hash = greyboxHashFor({ ...room, placedOpenings: openings });
  if (room.greyboxKey && room.greyboxHash === hash) {
    return {
      greyboxKey: room.greyboxKey,
      greyboxMaskKey: room.greyboxMaskKey,
      greyboxHash: room.greyboxHash,
      greyboxLedger: room.greyboxLedger,
      // Same camera construction renderGreyboxBundle would use (greyboxCamera
      // is a deterministic pure function of spec+aspect — Task 14's dev-check
      // fixture proves the same (spec, aspect) always yields an identical
      // camera) — so this matches what a fresh render's own projectOpenings
      // call would have produced, without paying for the render itself.
      projected: projectOpenings(spec, greyboxCamera(spec, GREYBOX_ASPECT)),
    };
  }

  const { dataUri, maskDataUri, projected } = renderGreyboxBundle(spec);

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
  // `projected` here is renderGreyboxBundle's own return value, not a second
  // call to projectOpenings — it already used the exact camera instance that
  // produced the render and the mask, which render-mask.ts's own doc comment
  // requires ("They MUST share a camera instance — a ledger derived from a
  // different viewpoint than the reference image is worse than no ledger at
  // all"). Recomputing it here would still be mathematically identical
  // (greyboxCamera is deterministic — same spec, same aspect, same camera —
  // and projectOpenings has no other input), but there's no reason to pay for
  // a second call when the first one's result is already in hand.
  return { greyboxKey: key, greyboxMaskKey: maskKey, greyboxHash: hash, greyboxLedger: ledger, projected };
}
