/**
 * Furniture suggestion API — workflow step 10 ("AI Furniture Suggestions").
 *
 * Given the parsed rooms (in feet) + the chosen style + the furniture catalog,
 * Gemini picks suitable items per room and positions them inside the room
 * bounds. Returns `{ placements: [...] }`. On any failure it returns an honest
 * error so the client can fall back to its rule-based suggestion — never a
 * fabricated layout.
 */

import { generateJson, geminiConfigured } from "@/lib/pipeline/gemini-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RoomIn {
  id: string;
  name: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CatalogIn {
  id: string;
  name: string;
  category: string;
  w: number;
  d: number;
}
interface Body {
  styleName?: string;
  rooms?: RoomIn[];
  catalog?: CatalogIn[];
}

export interface Placement {
  roomId: string;
  catalogId: string;
  xFt: number;
  yFt: number;
  rotationDeg: number;
}

export async function POST(request: Request) {
  if (!geminiConfigured()) {
    return Response.json(
      { error: "Gemini isn't configured. Set GEMINI_API_KEY to enable AI furniture." },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rooms = body.rooms ?? [];
  const catalog = body.catalog ?? [];
  if (!rooms.length || !catalog.length) {
    return Response.json({ error: "rooms and catalog are required" }, { status: 400 });
  }

  const prompt = `You are an interior designer furnishing an Indian "${body.styleName ?? "Modern"}" interior.
Given ROOMS (feet coordinates, top-left origin) and a furniture CATALOG, choose suitable
items for each room and place them so each item fits fully inside its room without
overlapping other items, leaving sensible walking space.

Return JSON: { "placements": [ { "roomId": string, "catalogId": string, "xFt": number, "yFt": number, "rotationDeg": number } ] }

Rules:
- "xFt"/"yFt" = the item's TOP-LEFT corner in absolute plan feet. It MUST satisfy
  room.x <= xFt and xFt + item.w <= room.x + room.width (same for Y with item.d and room.height).
- Only use "catalogId" values that exist in CATALOG.
- Match furniture to the room: beds in bedrooms; sofa/coffee-table/tv-unit/armchair in living/hall;
  dining-table/dining-chair in dining; pooja-unit in pooja; desks/seating in office/cabins.
  Bathrooms/utility/store usually get 0–1 items.
- 2–5 items in main rooms, fewer in small ones. "rotationDeg" must be one of 0, 90, 180, 270.
- Never invent items or place anything outside its room.

ROOMS:
${JSON.stringify(rooms)}

CATALOG (footprint w×d in feet):
${JSON.stringify(catalog)}`;

  const raw = await generateJson<{ placements?: Placement[] }>([{ text: prompt }], {
    temperature: 0.3,
    thinkingBudget: 0,
  });

  if (!raw?.placements?.length) {
    return Response.json(
      { error: "Gemini returned no furniture suggestions." },
      { status: 502 },
    );
  }

  // Keep only well-formed placements; the client validates against the catalog.
  const placements = raw.placements.filter(
    (p) =>
      p &&
      typeof p.roomId === "string" &&
      typeof p.catalogId === "string" &&
      Number.isFinite(p.xFt) &&
      Number.isFinite(p.yFt),
  );

  return Response.json({ placements });
}
