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

/**
 * Every storage key this project's own data actually references (its floor
 * plan upload + every approved room's image) — used to verify a
 * client-resolved key actually belongs to the project it's claimed for,
 * rather than trusting it outright. `/api/export-pdf` accepts client-resolved
 * `imageKey`/`floorPlanImageKey` values in its request body; without this
 * check, an authenticated caller could submit ANY other project's storage
 * key and have it embedded in their own PDF (found in review — storage keys
 * are a predictable `renders/<projectId>/<uuid>.<ext>` / `plans/<uuid>/<name>`
 * shape, and nothing validated the request body's keys against the project
 * they were claimed to belong to).
 */
export function allowedProjectStorageKeys(project: Project): Set<string> {
  const keys = new Set<string>();
  if (project.floorPlan?.meta?.storageKey) keys.add(project.floorPlan.meta.storageKey);
  for (const { imageKey } of resolveApprovedRooms(project)) keys.add(imageKey);
  return keys;
}

/**
 * Every storage key this project's own data has EVER referenced — the floor
 * plan upload, every generation of every room (not just the approved one),
 * and the walkthrough video. Broader than `allowedProjectStorageKeys` on
 * purpose: routes that operate on "whatever the client is currently looking
 * at" (GET /api/render serving any gallery thumbnail/version, or
 * POST /api/edit-room-image editing the specific version the user has open,
 * which isn't necessarily the room's approved one) need to recognize any
 * key the project has ever produced, not just its final picks. Routes whose
 * own semantics are genuinely "approved rooms only" (export-pdf,
 * generate-walkthrough) should keep using `allowedProjectStorageKeys`
 * instead — using this broader set there would let a caller smuggle in an
 * unapproved/stale image under the guise of "it's still technically mine."
 */
export function allProjectStorageKeys(project: Project): Set<string> {
  const keys = new Set<string>();
  if (project.floorPlan?.meta?.storageKey) keys.add(project.floorPlan.meta.storageKey);
  for (const card of project.roomCards) {
    for (const generation of card.generations) keys.add(generation.imageKey);
  }
  if (project.walkthrough?.videoKey) keys.add(project.walkthrough.videoKey);
  return keys;
}
