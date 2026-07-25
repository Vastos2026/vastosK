/**
 * Reconstruction validation.
 *
 * Sanity-checks the merged plan so the upload UI can WARN (never fabricate)
 * before a questionable layout reaches 2D Review / 3D. Reuses `analyzePlan`
 * (overlaps, out-of-bounds, coverage) from the 2D editor so the checks match
 * what the reviewer sees. Checks are advisory: a failed check is shown, not a
 * blocker — consistent with the no-dummy-data rule (surface the truth).
 */

import { analyzePlan } from "@/lib/plan-geometry";
import type { FloorPlan } from "@/lib/types";
import type { PlanCheck, PlanValidation, SemanticPlan } from "./types";

export function validatePlan(
  plan: FloorPlan,
  semantic: SemanticPlan,
  /** detected building footprint (pixels) — ground truth for the plan's shape */
  buildingBox?: { w: number; h: number },
): PlanValidation {
  const issues = analyzePlan(plan);
  const checks: PlanCheck[] = [];

  // Room count: most rooms Gemini named should make it into the reconstruction.
  // Optional-chained so rehydrated/partial plans never throw here.
  const semRooms = semantic?.rooms?.length ?? 0;
  if (semRooms > 0) {
    checks.push({
      label: "Room count",
      ok: plan.rooms.length >= Math.ceil(semRooms * 0.75),
      detail: `${plan.rooms.length} reconstructed · ${semRooms} read`,
    });
  }

  // Coverage: named rooms should fill a believable share of the envelope without
  // overflowing it (>100% implies overlaps / off-plan rooms). The floor is low so
  // open-plan commercial layouts (a big unlabeled hall + small rooms around it)
  // aren't flagged as inaccurate; only a near-empty (collapsed) reconstruction
  // fails. The high bound still catches overlap/overflow.
  checks.push({
    label: "Area coverage",
    ok: issues.coverage >= 12 && issues.coverage <= 115,
    detail: `${issues.coverage}% of envelope`,
  });

  // No overlapping rooms.
  checks.push({
    label: "No overlaps",
    ok: issues.overlapPairs === 0,
    detail: issues.overlapPairs === 0 ? "clean" : `${issues.overlapPairs} pair(s)`,
  });

  // Rooms inside the building envelope.
  checks.push({
    label: "Within bounds",
    ok: issues.outOfBoundsIds.size === 0,
    detail: issues.outOfBoundsIds.size === 0 ? "all inside" : `${issues.outOfBoundsIds.size} off-plan`,
  });

  // Aspect ratio vs the DETECTED footprint (ground truth for the plan's shape),
  // falling back to the dimensions Gemini read off the outer chain.
  const want =
    buildingBox && buildingBox.h > 0
      ? buildingBox.w / buildingBox.h
      : semantic?.overallWidthFt && semantic?.overallHeightFt && semantic.overallHeightFt > 0
        ? semantic.overallWidthFt / semantic.overallHeightFt
        : 0;
  if (want > 0) {
    const got = plan.planHeight > 0 ? plan.planWidth / plan.planHeight : 0;
    const err = Math.abs(got - want) / want;
    checks.push({
      label: "Aspect ratio",
      ok: err <= 0.12,
      detail: `${got.toFixed(2)} · ${want.toFixed(2)} expected`,
    });
  }

  // Openings present — informational. Real plans usually have them, but some
  // sketches genuinely don't, so this warns rather than fails hard.
  checks.push({ label: "Doors", ok: plan.doors.length > 0, detail: `${plan.doors.length} detected` });
  checks.push({
    label: "Windows",
    ok: (plan.windows?.length ?? 0) > 0,
    detail: `${plan.windows?.length ?? 0} detected`,
  });

  const score = checks.length ? checks.filter((c) => c.ok).length / checks.length : 1;
  return { checks, score };
}
