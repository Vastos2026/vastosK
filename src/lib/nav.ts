import type { Phase, Project } from "./types";

// The 3D Studio phase was removed: 2D Review carries the exact room data
// (dimensions, furniture sizes + placements, openings) straight into Rooms.
export const PHASES: { id: Phase; label: string; icon: string }[] = [
  { id: "upload", label: "Upload", icon: "FileUp" },
  { id: "review", label: "2D Review", icon: "Ruler" },
  { id: "design", label: "Design", icon: "Palette" },
  { id: "rooms", label: "Rooms", icon: "LayoutGrid" },
  { id: "renders", label: "Renders", icon: "Image" },
];

/** The phase a project should resume at, based on its status. */
export function resumePhase(project: Project): Phase {
  switch (project.status) {
    case "draft":
      return "upload";
    case "parsing":
    case "parsed":
      return "review";
    case "designing":
      return "rooms";
    case "rendered":
      return "renders";
    default:
      return "upload";
  }
}

export function projectHref(project: Project) {
  return `/projects/${project.id}/${resumePhase(project)}`;
}
