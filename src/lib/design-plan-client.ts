/**
 * Client helpers for the Design Planning + room image generation APIs — the
 * frontend's only touchpoints for the Universal JSON Architecture (revamp
 * plan). The frontend never constructs a prompt; it sends structured
 * selections and gets back structured JSON (or a final image URL).
 */

import type { DesignSelection, RoomSelection } from "./ai/prompting/build-universal-input";
import type {
  DesignReferenceAttributes,
  DesignSpecification,
  UniversalInput,
  UniversalInputRoom,
} from "./ai/prompting/types";
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
  /**
   * The attributes read off an uploaded design reference. When present the
   * route ignores `design` entirely and composes the design selections from
   * these instead (see /api/design-plan) — `design` is still sent so an
   * older/other caller keeps working unchanged.
   */
  designReference?: DesignReferenceAttributes;
  /**
   * The colour palette as structured data, alongside `design.colourPalette`'s
   * formatted prose. The server needs to know which slot is the WALL, and the
   * prose form cannot say — "Custom (#c520af, #e363d2, #760585)" is three
   * colours with no roles attached. Omitted when a design reference is active,
   * since that palette is free text with no preset behind it.
   */
  paletteId?: string;
  customHexes?: string[];
}): Promise<{ universalInput: UniversalInput; designSpec: DesignSpecification }> {
  return postJson("/api/design-plan", input);
}

export interface DesignReferenceResult {
  attributes: DesignReferenceAttributes;
  /** small JPEG data URI, or absent if the upload couldn't be re-encoded — see the route */
  thumbnail?: string;
  /** short sha256 prefix of the uploaded bytes, for the Design page's designSignature */
  hash: string;
}

/**
 * Posts a design reference photo to `POST /api/design-reference` and gets
 * back the six design-look attributes read off it. Multipart, not JSON: the
 * upload is a raw image up to 20MB, same as parse-plan-client's own call.
 *
 * Fires ONCE per uploaded image — the caller caches the result on the project
 * (Project.designReference), and the design plan re-sends only the derived
 * attributes, never the image.
 */
export async function analyseDesignReferenceViaApi(
  file: File,
  projectId: string,
): Promise<DesignReferenceResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("projectId", projectId);

  const res = await fetch("/api/design-reference", { method: "POST", body: form });
  if (!res.ok) {
    let msg = `Reference analysis returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  return (await res.json()) as DesignReferenceResult;
}

// editRoomImage / enhanceRoomImage / EditRegionInput deliberately do NOT live
// here. They were briefly duplicated into this file while the reference-photo
// and Enhance work was in flight, which left two same-named clients for the
// same endpoint differing only in whether they forward `reference` — importing
// the wrong one would drop the user's reference photo with no type error and
// no failed request. Both now live in generation-client.ts, beside the other
// generation-flow clients.

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
  /**
   * The numbered annotation render. Forwarded as a second reference image for
   * the Gemini image model only; the server drops it for FLUX.2. See the
   * route's own note on why FLUX must never see numerals.
   */
  greyboxAnnotatedKey?: string;
}): Promise<{ imageUrl: string; key: string; prompt: string }> {
  return postJson("/api/generate-room-image", input);
}
