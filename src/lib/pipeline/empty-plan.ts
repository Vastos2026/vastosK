/**
 * Client-safe empty-plan helper — deliberately has NO dependency on
 * `@/lib/ai/provider` (which starts with `import "server-only"` and
 * transitively pulls in `sharp`). Client components (the Upload page's
 * "no floor plan yet" path, the Floor Plan "No" choice) import `emptyPlan`
 * directly from here rather than from `extract-plan.ts`, so their bundle
 * never drags in server-only code. `extract-plan.ts` (server-only itself)
 * also imports from here for its own low-confidence/unreadable fallback.
 */

import type { FloorPlan, Room } from "@/lib/types";

/**
 * Default extent for a brand new empty plan, and the fallback box size for
 * purely cosmetic layout math (grid packing, SVG preview boxes) when a room's
 * real width/height is unknown. NOT a stand-in for a room's actual dimensions
 * anymore (see Room.width/height's doc comment) — nothing here is shown to
 * the user as if it were a real reading or sent to the AI provider.
 */
export const DEFAULT_ROOM_SIZE_FT = 10;

/** An empty plan for the no-floor-plan path and the low-confidence fallback — both land here, then the user adds rooms manually. */
export function emptyPlan(fileName = ""): FloorPlan {
  return {
    fileName,
    planWidth: DEFAULT_ROOM_SIZE_FT,
    planHeight: DEFAULT_ROOM_SIZE_FT,
    rooms: [],
    doors: [],
    windows: [],
    meta: { source: "manual" },
  };
}

/**
 * Width/height for pure layout math only — grid packing (extract-plan.ts) and
 * SVG box sizing (plan-thumb.tsx/plan-blueprint.tsx) all need SOME number to
 * position/size a box on screen, even for a room whose real dimensions are
 * still unknown. Never use this to display a size as fact or to build an AI
 * prompt — those call sites must handle the missing case honestly instead.
 */
export function layoutSize(room: Pick<Room, "width" | "height">): { width: number; height: number } {
  return { width: room.width ?? DEFAULT_ROOM_SIZE_FT, height: room.height ?? DEFAULT_ROOM_SIZE_FT };
}
