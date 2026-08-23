/**
 * Client helpers for View & Edit, the Walkthrough screen's room ordering, and
 * walkthrough generation (revamp Workstream 8.5).
 */

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

export interface EditRegionInput {
  /** PNG data URI of the lasso mask for this region. */
  mask: string;
  /** What to do to the region. Always required — a reference photo never replaces it. */
  prompt: string;
  /**
   * Optional photo the user attached to THIS region as a visual guide ("change
   * to this dining table"). A data URI, already downscaled client-side to
   * <=1024px — see the View & Edit page. The server hands it to the image
   * model as a second reference image, described in the prompt as IMAGE 2: its
   * shape, colour and material are copied, its background and framing are not.
   */
  reference?: string;
}

/**
 * Applies up to MAX_LASSO_REGIONS numbered edits to a generated room image in
 * one combined call.
 *
 * This is the ONLY editRoomImage. A second copy briefly existed in
 * design-plan-client.ts — added there because that was the file being worked
 * in when `reference` landed — and was folded back here rather than left
 * standing alongside this one: two same-named clients for one endpoint,
 * differing only in whether they forward `reference`, is a trap. Importing
 * the wrong one drops the user's reference photo silently, with no type error
 * and no failed request.
 */
export function editRoomImage(input: {
  projectId: string;
  baseImageKey: string;
  styleId?: string;
  regions: EditRegionInput[];
}): Promise<{ imageUrl: string; key: string }> {
  return postJson("/api/edit-room-image", input);
}

/**
 * Whole-image re-render of an already-generated room image — the Enhance
 * button on View & Edit. Holds the camera, geometry, openings and existing
 * furniture placement fixed and improves only finish, lighting and the
 * dressing layer. Like editRoomImage it always lands as a NEW RoomGeneration,
 * never overwriting the image the user clicked Enhance from.
 */
export function enhanceRoomImage(input: {
  projectId: string;
  baseImageKey: string;
  styleId?: string;
}): Promise<{ imageUrl: string; key: string }> {
  return postJson("/api/enhance-room-image", input);
}

export function orderRoomsWithAI(input: {
  category: string;
  roomNames: string[];
}): Promise<{ order: string[]; fellBack?: boolean }> {
  return postJson("/api/order-rooms", input);
}

export function generateWalkthrough(input: {
  projectId: string;
  rooms: { id: string; name: string; imageKey: string }[];
}): Promise<{ videoUrl: string; key: string }> {
  return postJson("/api/generate-walkthrough", input);
}

export function createShareLink(input: {
  projectId: string;
}): Promise<{ token: string | null; persisted: boolean }> {
  return postJson("/api/share-link", input);
}

/**
 * Kill this project's share link, optionally replacing it in the same call.
 *
 * `regenerate: true` rotates — the old link dies and a new one is returned,
 * which is what a leaked link needs. Without it the project simply stops
 * being shared and `token` comes back null.
 *
 * Unlike `createShareLink`, this REJECTS on failure rather than degrading:
 * telling an owner their leaked link is dead while it still resolves would
 * be worse than an error, so the route returns a non-2xx on every failure
 * path and `postJson` throws it. Callers must surface that, not swallow it.
 */
export async function revokeShareLink(input: {
  projectId: string;
  regenerate?: boolean;
}): Promise<{ token: string | null; revoked: boolean }> {
  const res = await fetch("/api/share-link", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let msg = `Could not revoke the share link (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { token: string | null; revoked: boolean };
}

interface ExportProjectPdfInput {
  /** Required so the server can verify the caller owns this project and that every key below actually belongs to it — see export-pdf/route.ts's ownership check. */
  projectId: string;
  projectName: string;
  propertyTypeLabel: string;
  subcategory?: string;
  styleLabel?: string;
  luxuryLevel?: string;
  colourPaletteLabel?: string;
  colourSwatch?: string[];
  rooms: { name: string; imageKey: string }[];
  walkthroughVideoUrl?: string;
  /** Storage key of the original uploaded floor-plan image, when one exists — not every project has one (e.g. Sketch-tool projects). Optional/additive: see route.ts's ExportRequest. */
  floorPlanImageKey?: string;
}

/** POSTs the resolved project data to /api/export-pdf and returns the PDF bytes. */
export async function exportProjectPdf(input: ExportProjectPdfInput): Promise<Blob> {
  const res = await fetch("/api/export-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
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
  return res.blob();
}
