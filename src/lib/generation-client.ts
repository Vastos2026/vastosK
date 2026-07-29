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

export function editRoomImage(input: {
  projectId: string;
  baseImageKey: string;
  styleId?: string;
  regions: { mask: string; prompt: string }[];
}): Promise<{ imageUrl: string; key: string }> {
  return postJson("/api/edit-room-image", input);
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
  existingToken?: string;
}): Promise<{ token: string | null; persisted: boolean }> {
  return postJson("/api/share-link", input);
}

interface ExportProjectPdfInput {
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
