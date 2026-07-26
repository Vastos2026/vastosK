/**
 * Client-safe empty-plan helper — deliberately has NO dependency on
 * `@/lib/ai/provider` (which starts with `import "server-only"` and
 * transitively pulls in `sharp`). Client components (the Upload page's
 * "no floor plan yet" path, the Floor Plan "No" choice) import `emptyPlan`
 * directly from here rather than from `extract-plan.ts`, so their bundle
 * never drags in server-only code. `extract-plan.ts` (server-only itself)
 * also imports from here for its own low-confidence/unreadable fallback.
 */

import type { FloorPlan } from "@/lib/types";

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
