/**
 * Client helpers for the Design Planning + room image generation APIs — the
 * frontend's only touchpoints for the Universal JSON Architecture (revamp
 * plan). The frontend never constructs a prompt; it sends structured
 * selections and gets back structured JSON (or a final image URL).
 */

import type { DesignSelection, RoomSelection } from "./ai/prompting/build-universal-input";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "./ai/prompting/types";
import type { ProjectedOpening } from "./greybox/render-mask";
import type { GreyboxCameraView } from "./greybox/types";
import type { PlacedFurniture, PlacedOpening } from "./types";

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function runDesignPlan(input: {
  projectId: string;
  category: string;
  subcategory: string;
  rooms: RoomSelection[];
  design: DesignSelection;
}): Promise<{ universalInput: UniversalInput; designSpec: DesignSpecification }> {
  return postJson("/api/design-plan", input);
}

export function generateRoomImage(input: {
  projectId: string;
  universalInput: UniversalInput;
  room: UniversalInputRoom;
  designSpec: DesignSpecification;
  /** This room's rendered greybox reference key, if it was placed in the Plan Editor — see ensure-greybox-key.ts. */
  greyboxKey?: string;
  /** The Pass B opening mask stored beside greyboxKey — see upload-greybox/route.ts. Required alongside greyboxKey for the server to re-derive the opening ledger itself rather than trust a client-sent count. */
  greyboxMaskKey?: string;
  /** Each opening's pixel projected through the locked camera (ensure-greybox-key.ts's ensureGreybox now returns this on both cache hit and miss) — types each mask component when the server re-derives the ledger from greyboxMaskKey. */
  projected?: ProjectedOpening[];
  /** Phase B furniture proxies placed in this room's greybox, if any — see furniture-layout.ts. */
  furniture?: PlacedFurniture[];
  /**
   * This room's greybox geometry. Lets the server tie each furniture piece to
   * the specific grey box it is in the reference image, instead of listing
   * materials with no mapping (prompt-builder.ts's mappedFurnitureFor).
   * Optional, and the prompt degrades to the old unmapped line without it.
   */
  roomSpec?: { width: number; depth: number; openings: PlacedOpening[]; cameraView?: GreyboxCameraView };
}): Promise<{ imageUrl: string; key: string; prompt: string }> {
  return postJson("/api/generate-room-image", input);
}
