import residential from "../../../config/project-types/residential.json";
import apartment from "../../../config/project-types/apartment.json";
import commercial from "../../../config/project-types/commercial.json";
import custom from "../../../config/project-types/custom.json";
import type { PropertyType } from "../types";

/**
 * Config-driven project types (revamp Workstream 6). Adding a new vertical —
 * e.g. a new Custom category like "Dental Clinic" — is a JSON file plus a
 * planning persona, not new code: the Universal Input Schema and Design
 * Specification schema (src/lib/ai/prompting/types.ts) never change per
 * category, only which config drives the frontend's room-type suggestions
 * and default walkthrough order.
 *
 * `planningPersona` names the `prompt_templates` row to use — it matches
 * `UniversalInput.project.category`, which `design-planning.ts` passes
 * straight to `getPlanningTemplate()`. Keep these in sync: a project-type
 * config's `category` and `planningPersona` should normally be identical
 * (they're separate fields only because a future category could reuse
 * another category's persona instead of having its own).
 */
export interface ProjectTypeConfig {
  category: string;
  label: string;
  planningPersona: string;
  subcategories: string[];
  roomTypes: string[];
  walkthroughOrder: string[];
}

const CONFIGS: ProjectTypeConfig[] = [residential, apartment, commercial, custom];

const BY_CATEGORY: Record<string, ProjectTypeConfig> = Object.fromEntries(
  CONFIGS.map((c) => [c.category, c]),
);

export function listProjectTypes(): ProjectTypeConfig[] {
  return CONFIGS;
}

export function getProjectTypeConfig(category: string): ProjectTypeConfig | null {
  return BY_CATEGORY[category] ?? null;
}

/**
 * Maps the welcome screen's PropertyType (the local-first store's category
 * field, predating the config-driven project types) onto a project-type
 * config category — the Universal Input Schema's `project.category`. Matches
 * the welcome screen's cards: villa → Individual home, office → Commercial
 * office, commercial → Custom (see custom.json's note on why).
 */
export function categoryForPropertyType(propertyType: PropertyType): string {
  switch (propertyType) {
    case "villa":
      return "Residential";
    case "apartment":
      return "Apartment";
    case "office":
      return "Commercial";
    case "commercial":
      return "Custom";
  }
}

/**
 * Orders a project's included room names for the walkthrough video, per the
 * category's default order (e.g. living room before bedroom). Rooms not
 * found in the config's order (or a Custom project, whose order is []) keep
 * their original relative order, appended after any that did match.
 */
export function orderRoomsForWalkthrough(category: string, roomNames: string[]): string[] {
  const order = getProjectTypeConfig(category)?.walkthroughOrder ?? [];
  if (order.length === 0) return roomNames;

  const rank = new Map(order.map((name, i) => [name, i]));
  return [...roomNames].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0; // neither in the config's order — keep their relative order (stable sort)
  });
}
