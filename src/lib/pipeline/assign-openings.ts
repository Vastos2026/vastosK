/**
 * Shared opening types. The deterministic point-to-room-edge assignment
 * algorithm that used to live here is retired — the new extraction pipeline
 * (src/lib/pipeline/extract-plan.ts) gets door/window side + connection
 * directly from Gemini vision instead of computing it from pixel geometry.
 */

export type OpeningSide = "north" | "south" | "east" | "west";

export interface RoomOpening {
  type: "door" | "window";
  side: OpeningSide;
  /** another room's name, "exterior", or null if not confidently determined */
  connectsTo: string | null;
}
