import { cn } from "@/lib/utils";
import type { FloorPlan } from "@/lib/types";
import { PlanThumb } from "./plan-thumb";
import { Icon } from "./ui/icon";
import { RetryImg } from "./ui/retry-img";

/**
 * A floor-plan thumbnail, or a consistent "No floor plan yet" empty state
 * when a project doesn't have one — shared by project-card.tsx (dashboard
 * grid) and profile-project-card.tsx (Profile page's wide cards), which
 * otherwise each hand-rolled the identical empty state.
 */
export function FloorPlanThumbOrEmpty({
  plan,
  padding = "p-5",
  iconSize = "size-7",
}: {
  plan?: FloorPlan;
  padding?: string;
  iconSize?: string;
}) {
  // A real uploaded floor-plan photo (meta.storageKey, set by
  // /api/parse-plan/route.ts) takes priority over the schematic drawing —
  // manually-entered plans (no upload, see the no-floor-plan flow) have no
  // storageKey and fall through to the PlanThumb schematic below, which
  // doubles as this case's placeholder illustration.
  if (plan?.meta?.storageKey) {
    return (
      <div className="absolute inset-0 overflow-hidden transition-transform duration-300 group-hover:scale-[1.03]">
        {/* Was a bare <img> with no retry — this is the dashboard/profile
            project-card thumbnail, the very first image surface most users
            see, and a transient storage/ownership read (see /api/render's
            requireOwnedKey) left it permanently blank with no way to recover
            short of a manual reload. RetryImg gives it the same
            retry-then-icon behavior every other stored image in the app
            already has (generate/page.tsx, furnish-room-card.tsx, etc). */}
        <RetryImg
          src={`/api/render?key=${encodeURIComponent(plan.meta.storageKey)}`}
          alt=""
          className="size-full object-cover"
        />
      </div>
    );
  }
  if (plan) {
    return (
      <div className={cn("absolute inset-0 transition-transform duration-300 group-hover:scale-[1.03]", padding)}>
        <PlanThumb plan={plan} />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid place-items-center text-faint">
      <div className="flex flex-col items-center gap-2">
        <Icon name="FileUp" className={iconSize} />
        <span className="text-xs">No floor plan yet</span>
      </div>
    </div>
  );
}
