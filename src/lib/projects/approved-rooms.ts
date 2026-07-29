import type { Project } from "@/lib/types";

/**
 * Every room that's included in the project AND has an approved generation —
 * the same "ready to export/walkthrough" predicate the Approve page enforces,
 * resolved here once instead of re-derived independently at each call site
 * (the Walkthrough page, the Profile page's project cards, and the public
 * /s/[token] share page all need exactly this).
 */
export function resolveApprovedRooms(project: Project): { name: string; imageKey: string }[] {
  const rooms = project.floorPlan?.rooms ?? [];
  return project.roomCards
    .filter((card) => card.included && card.approvedId)
    .map((card) => {
      const room = rooms.find((r) => r.id === card.roomId);
      const generation = card.generations.find((g) => g.id === card.approvedId);
      if (!room || !generation) return null;
      return { name: room.name, imageKey: generation.imageKey };
    })
    .filter((r): r is { name: string; imageKey: string } => !!r);
}
