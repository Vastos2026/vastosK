/**
 * Design Planning API — the live wiring for the Universal JSON Architecture's
 * step 5a (revamp plan). Turns the frontend's global design selections + room
 * list into a UniversalInput (build-universal-input.ts) and runs the one
 * Design Planning Layer call (design-planning.ts) that produces the cached
 * DesignSpecification every room's render prompt is built from.
 *
 *   POST /api/design-plan  { projectId, category, subcategory, rooms, design }
 *     → { universalInput, designSpec }
 */

import { buildUniversalInput, type DesignSelection, type RoomSelection } from "@/lib/ai/prompting/build-universal-input";
import { buildDesignSpec } from "@/lib/ai/prompting/design-spec-tables";
import { referenceDesignSelection } from "@/lib/ai/prompting/design-reference";
import { toErrorResponse } from "@/lib/ai/errors";
import { assertAllowed } from "@/lib/api-guard";
import type { DesignReferenceAttributes } from "@/lib/ai/prompting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  projectId?: string;
  category?: string;
  subcategory?: string;
  rooms?: RoomSelection[];
  design?: DesignSelection;
  /**
   * Present when the user uploaded a design reference instead of using the
   * Style / Luxury level / Colour palette pickers (which the Design page
   * hides in that case). Overrides `design` below — see the call site.
   */
  designReference?: DesignReferenceAttributes;
  /**
   * The colour palette as STRUCTURED data, alongside `design.colourPalette`'s
   * formatted prose. `buildDesignSpec` needs to know which slot is the wall,
   * and the prose form cannot say: "Custom (#c520af, #e363d2, #760585)" is
   * three colours with no stated roles, which is precisely how the old
   * planning call ended up assigning them itself and painting the walls a
   * neutral the user never picked. Absent for a design-reference upload, where
   * the palette is free text and slot one is read off the text instead.
   */
  paletteId?: string;
  customHexes?: string[];
}

export async function POST(request: Request) {
  // One Gemini structured-generation call per design plan.
  const guard = await assertAllowed(request, {
    rateLimit: { key: "design-plan", limit: 10, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId, category, subcategory, rooms, design, designReference, paletteId, customHexes } = body;
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  try {
    // A reference REPLACES the three picker values rather than sitting beside
    // them: the Design page hides those pickers while one is active, so
    // whatever they still hold client-side is stale defaults, not a choice
    // the user made. Composed here, server-side, rather than by the page —
    // `referenceDesignSelection` re-sanitises (clamp + stripWallFinishes)
    // attributes that have round-tripped through the client's cached project
    // since the analysis call, on the same principle build-universal-input.ts
    // re-checks caps the frontend should already enforce.
    const selection = designReference
      ? referenceDesignSelection(designReference)
      : (design ?? { style: "", luxuryLevel: "Standard" as const, colourPalette: "" });
    const universalInput = buildUniversalInput(
      category ?? "",
      subcategory ?? "",
      rooms ?? [],
      selection,
    );
    // Table lookup, not an AI call. Every input to the four fields that
    // actually reach an image model (compactBrief, wallColour,
    // compactGuidance, materialTokens) is a value the user picked from a fixed
    // list, so a model was being paid — and waited on for ~50 seconds — to
    // read a table. See design-spec-tables.ts's header for the full argument,
    // including why the old call was not just slow but LOSSY: the palette
    // never reached prompt-builder at all, so a chosen colour had no
    // guaranteed path to the model.
    //
    // `runDesignPlanning` and its Gemini schema are intentionally left in the
    // tree, unreferenced by this route, so the previous behaviour can be
    // restored by swapping this one line back.
    const designSpec = buildDesignSpec(universalInput, { paletteId, customHexes });
    return Response.json({ universalInput, designSpec });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Design planning");
    return Response.json(body, { status });
  }
}
