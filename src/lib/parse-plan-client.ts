/**
 * Client helper for floor-plan extraction. Posts the image to
 * `POST /api/parse-plan`, which returns the extracted plan in one call — no
 * polling, no staged progress (the old multi-stage pipeline this replaced
 * needed that; a single Gemini vision call doesn't).
 */

import type { FloorPlan } from "./types";

export interface ParseResult {
  plan: FloorPlan;
  /** false when the model couldn't read this as a floor plan at all */
  readable: boolean;
  confidence: number;
}

export interface ParseOptions {
  /** the active project category's room types, so extraction can classify into them */
  roomTypeHints?: string[];
}

export async function parsePlanViaApi(file: File, opts: ParseOptions = {}): Promise<ParseResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts.roomTypeHints?.length) form.append("roomTypeHints", opts.roomTypeHints.join(","));

  const res = await fetch("/api/parse-plan", { method: "POST", body: form });
  if (!res.ok) {
    let msg = `Extraction returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  return (await res.json()) as ParseResult;
}
