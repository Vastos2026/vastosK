"use client";

import { renderGreyboxBundle, type ProjectedOpening } from "./render-mask";
import { greyboxHashFor } from "./greybox-hash";
import { toWorldFurniture } from "./furniture-layout";
import { greyboxCamera, projectOpenings } from "./camera";
import { GREYBOX_ASPECT } from "./dimensions";
import { roomSpecFor } from "./room-spec";
import type { GreyboxRoomSpec } from "./types";
import type { Room } from "@/lib/types";

/**
 * `projected` is NOT one of Room's own persisted fields (nothing about a
 * locked camera's pixel projection belongs in the store) — it's derived fresh
 * on every call (see below) so callers always have it, cache hit or miss.
 */
export type GreyboxResult = Pick<
  Room,
  "greyboxKey" | "greyboxMaskKey" | "greyboxAnnotatedKey" | "greyboxHash" | "greyboxLedger"
> & {
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
  // roomSpecFor is the ONE place width/depth/openings/cameraView are derived
  // from a Room — the server now reconstructs the same locked camera from
  // this exact payload (see room-spec.ts's own doc comment) to describe
  // which grey box in the annotated reference image is which piece of
  // furniture, so this file must not keep a second, parallel derivation that
  // could drift from it. It covers the same two rules the inlined version
  // here used to: openings fall back to seedPlacedOpenings(room.openings)
  // for a manually-entered room that never passed through the Plan editor
  // (door/window counts per side but no positions), and sizes come from
  // layoutSize rather than room.width/room.height directly, since those are
  // undefined for a room whose dimensions were never legible on the plan.
  const { width, depth, openings, cameraView } = roomSpecFor(room);

  // Built once, before the cache-hit branch returns, so both branches can
  // derive `projected` from the identical spec a fresh render would use.
  const spec: GreyboxRoomSpec = {
    width,
    depth,
    openings,
    furniture: toWorldFurniture(room.furniture ?? [], width, depth),
    // Undefined here means "auto", which is greyboxCamera's own default, so a
    // room that never chose an angle renders exactly as it always did.
    cameraView,
  };

  const hash = greyboxHashFor({ ...room, placedOpenings: openings });
  if (room.greyboxKey && room.greyboxHash === hash) {
    return {
      greyboxKey: room.greyboxKey,
      greyboxMaskKey: room.greyboxMaskKey,
      greyboxAnnotatedKey: room.greyboxAnnotatedKey,
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

  const { dataUri, maskDataUri, annotatedDataUri, projected } = await renderGreyboxBundle(spec);

  const res = await fetch("/api/upload-greybox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // JSON.stringify drops `annotatedDataUri` entirely when it's undefined
    // (a furniture-free room, or one with nothing in this camera's frame —
    // see renderGreyboxBundle's own doc comment), so /api/upload-greybox
    // sees exactly the same shape it always did for such a room.
    body: JSON.stringify({ projectId, dataUri, maskDataUri, annotatedDataUri, projected }),
  });
  if (!res.ok) throw new Error(`Greybox upload failed (${res.status})`);
  const { key, maskKey, annotatedKey, ledger } = (await res.json()) as {
    key: string;
    maskKey: string;
    annotatedKey?: string;
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
  return {
    greyboxKey: key,
    greyboxMaskKey: maskKey,
    greyboxAnnotatedKey: annotatedKey,
    greyboxHash: hash,
    greyboxLedger: ledger,
    projected,
  };
}
