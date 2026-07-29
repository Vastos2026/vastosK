import { cn } from "@/lib/utils";
import type { FloorPlan } from "@/lib/types";
import { PlanThumb } from "./plan-thumb";
import { Icon } from "./ui/icon";

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
