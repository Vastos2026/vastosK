import type { Phase, Project } from "./types";

// Workstream 8.5 rebuild: the old 3D-studio "Rooms"/multi-view "Renders"
// phases are gone (see docs/VASTOS_REVAMP_PLAN.md "What's kept vs. what's
// destroyed"). "Generate" is the new per-room card gallery; "Approve" is
// Final Image Selection; "Walkthrough" is the simplified 3-second-clip video.
export const PHASES: { id: Phase; label: string; icon: string }[] = [
  { id: "upload", label: "Upload", icon: "FileUp" },
  { id: "plan", label: "Plan", icon: "DoorClosed" },
  { id: "review", label: "Review", icon: "Ruler" },
  { id: "furnish", label: "Furnish", icon: "Sofa" },
  { id: "design", label: "Design", icon: "Palette" },
  { id: "generate", label: "Generate", icon: "Image" },
  { id: "approve", label: "Approve", icon: "ListChecks" },
  { id: "walkthrough", label: "Walkthrough", icon: "Clapperboard" },
];

/**
 * The phase a project should resume at, based on its status.
 *
 * Deliberately skips "plan" even for a freshly-parsed project — a returning
 * user resumes at Review, the more common continuation point. "Plan" is
 * still reachable any time via the stepper for anyone who wants to place or
 * adjust openings; only the FIRST forward pass through Upload routes there
 * (see upload/page.tsx).
 */
export function resumePhase(project: Project): Phase {
  switch (project.status) {
    case "draft":
      return "upload";
    case "parsing":
    case "parsed":
      return "review";
    case "designing":
      return "generate";
    case "rendered":
      return "walkthrough";
    default:
      return "upload";
  }
}

export function projectHref(project: Project) {
  return `/projects/${project.id}/${resumePhase(project)}`;
}
