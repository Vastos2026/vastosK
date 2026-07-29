import type { Project } from "@/lib/types";
import { PROPERTY_TYPES } from "@/lib/data";
import { timeAgo } from "@/lib/utils";
import { Icon } from "./ui/icon";

/**
 * Property-type icon + label + "Updated Nx ago" row — shared by
 * project-card.tsx (dashboard grid) and profile-project-card.tsx (Profile
 * page's wide cards), which otherwise each hand-rolled the identical row.
 */
export function ProjectTypeMeta({ project }: { project: Project }) {
  const propType = PROPERTY_TYPES.find((p) => p.id === project.propertyType);
  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
      <Icon name={propType?.icon ?? "Box"} className="size-3.5" />
      {propType?.label}
      <span className="text-faint">·</span>
      Updated {timeAgo(project.updatedAt)}
    </p>
  );
}
