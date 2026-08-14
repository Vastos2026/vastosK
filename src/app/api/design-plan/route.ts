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
import { runDesignPlanning } from "@/lib/ai/prompting/design-planning";
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

  const { projectId, category, subcategory, rooms, design, designReference } = body;
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
    const designSpec = await runDesignPlanning(universalInput, { projectId, userId: guard.id });
    return Response.json({ universalInput, designSpec });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Design planning");
    return Response.json(body, { status });
  }
}
