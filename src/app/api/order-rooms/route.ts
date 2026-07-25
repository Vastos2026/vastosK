/**
 * Walkthrough room ordering — LLM fallback (revamp Workstream 8.5, flow step
 * 11). The static per-category `walkthroughOrder` (config/project-types/*.json)
 * is the free, deterministic default; this route is only called when a
 * project's room types aren't covered by that list (always true for Custom,
 * whose `walkthroughOrder` is intentionally empty) — one cheap call, not one
 * per project.
 *
 *   POST /api/order-rooms  { category, roomNames }  → { order: string[] }
 */

import { generateStructured } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCHEMA = {
  type: "OBJECT",
  properties: { order: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["order"],
} as const;

interface Body {
  category?: string;
  roomNames?: string[];
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { category, roomNames } = body;
  if (!category || !roomNames?.length) {
    return Response.json({ error: "category and roomNames are required" }, { status: 400 });
  }

  const prompt = `Order these rooms of a ${category} project into the sequence a visitor would naturally walk through them, starting near an entrance/public area and ending in more private rooms. Rooms: ${roomNames.join(", ")}. Return every room name exactly once, unchanged, in "order".`;

  try {
    const out = await generateStructured<{ order: string[] }>(prompt, SCHEMA);
    const valid = out.order.filter((n) => roomNames.includes(n));
    const missing = roomNames.filter((n) => !valid.includes(n));
    return Response.json({ order: [...valid, ...missing] });
  } catch (e) {
    if (e instanceof ProviderError) {
      // Ordering is a nice-to-have, not critical — fall back to the given
      // order rather than blocking the walkthrough on a planning-call failure.
      return Response.json({ order: roomNames, fellBack: true });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Ordering failed" },
      { status: 500 },
    );
  }
}
