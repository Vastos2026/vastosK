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
import { toErrorResponse } from "@/lib/ai/errors";
import { assertAllowed } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  projectId?: string;
  category?: string;
  subcategory?: string;
  rooms?: RoomSelection[];
  design?: DesignSelection;
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

  const { projectId, category, subcategory, rooms, design } = body;
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  try {
    const universalInput = buildUniversalInput(
      category ?? "",
      subcategory ?? "",
      rooms ?? [],
      design ?? { style: "", luxuryLevel: "Standard", colourPalette: "" },
    );
    const designSpec = await runDesignPlanning(universalInput, { projectId, userId: guard.id });
    return Response.json({ universalInput, designSpec });
  } catch (e) {
    const { status, body } = toErrorResponse(e, "Design planning");
    return Response.json(body, { status });
  }
}
