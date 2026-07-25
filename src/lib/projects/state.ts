import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Project lifecycle state machine (revamp Workstream 3).
 *
 * `projects.status` (supabase/schema.sql) is the single source of truth for a
 * project's stage. The frontend (Workstream 8) reads this field instead of
 * maintaining separate boolean flags (isUploaded/isParsing/etc) — that
 * mismatch between "what booleans say happened" and "what the backend
 * actually did" is what produced the undefined-shaped-data crash fixed in
 * Workstream 1.
 *
 * Named `ProjectState` (not `ProjectStatus`) to avoid colliding with the
 * unrelated, pre-existing `ProjectStatus` in src/lib/types.ts, which belongs
 * to the old local-first store (draft/parsing/parsed/designing/rendered) and
 * is out of scope for this revamp until Workstream 8 migrates that flow onto
 * the real `projects` table.
 */
export type ProjectState =
  | "created"
  | "floor_plan_uploaded"
  | "parsing"
  | "needs_review"
  | "ready_for_generation"
  | "generating_images"
  | "images_ready"
  | "editing"
  | "generating_walkthrough"
  | "completed"
  | "failed";

/**
 * Valid forward/lateral transitions per state. Deliberately permissive on the
 * "come back and redo something" edges (regenerate a room, edit after
 * completion, retry after failure) rather than strictly linear — the actual
 * screens that exercise these don't exist yet (Workstreams 6-8), and an
 * overly rigid graph now would just get relaxed later once real UX needs it.
 * `failed` is reachable from every non-terminal state (see isValidTransition)
 * rather than listed on each row.
 */
const TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  created: ["floor_plan_uploaded"],
  floor_plan_uploaded: ["parsing"],
  parsing: ["needs_review"],
  needs_review: ["ready_for_generation"],
  ready_for_generation: ["generating_images"],
  generating_images: ["images_ready"],
  images_ready: ["editing", "generating_images", "generating_walkthrough"],
  editing: ["images_ready"],
  generating_walkthrough: ["completed"],
  completed: ["editing", "generating_images", "generating_walkthrough"],
  failed: ["floor_plan_uploaded", "parsing", "ready_for_generation", "generating_images"],
};

export function isValidTransition(from: ProjectState, to: ProjectState): boolean {
  if (from === to) return true;
  if (to === "failed") return from !== "completed";
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly from: ProjectState,
    public readonly to: ProjectState,
  ) {
    super(`Project ${projectId}: cannot transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Moves a project to a new lifecycle state, validating the transition first.
 * Caller supplies the Supabase client (RLS-scoped for a user-initiated
 * transition, service-role for a background job) — this module makes no
 * assumption about which is appropriate for a given caller.
 */
export async function transitionProject(
  supabase: SupabaseClient,
  projectId: string,
  to: ProjectState,
): Promise<ProjectState> {
  const { data: current, error: readError } = await supabase
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .single();
  if (readError || !current) {
    throw new Error(`Project ${projectId} not found: ${readError?.message ?? "no row"}`);
  }

  const from = current.status as ProjectState;
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(projectId, from, to);
  }

  const { error: writeError } = await supabase
    .from("projects")
    .update({ status: to })
    .eq("id", projectId);
  if (writeError) {
    throw new Error(`Failed to set project ${projectId} status to ${to}: ${writeError.message}`);
  }

  return to;
}

/**
 * The project manifest shape is intentionally loose right now — its
 * producers (the Universal Input Schema builder, the Design Planning Layer)
 * are built in Workstream 5, and the room-editing screens that populate
 * `rooms` are built in Workstream 8. This type documents the agreed top-level
 * sections (see "Database model" / "AI prompting architecture" in
 * docs/VASTOS_REVAMP_PLAN.md) without over-specifying fields those
 * not-yet-built systems own.
 */
export interface ProjectManifest {
  universalInput?: Record<string, unknown>;
  rooms?: Record<string, unknown>[];
  designSpec?: Record<string, unknown>;
  generationSettings?: Record<string, unknown>;
  /** room key -> selected `generations` row id (Workstream 11, version history) */
  selectedGenerations?: Record<string, string>;
}

export async function getProjectManifest(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectManifest> {
  const { data, error } = await supabase
    .from("projects")
    .select("manifest")
    .eq("id", projectId)
    .single();
  if (error || !data) {
    throw new Error(`Project ${projectId} not found: ${error?.message ?? "no row"}`);
  }
  return (data.manifest as ProjectManifest) ?? {};
}

/** Shallow-merges `patch` into the existing manifest at the top level and saves it. */
export async function updateProjectManifest(
  supabase: SupabaseClient,
  projectId: string,
  patch: Partial<ProjectManifest>,
): Promise<ProjectManifest> {
  const current = await getProjectManifest(supabase, projectId);
  const next: ProjectManifest = { ...current, ...patch };

  const { error } = await supabase.from("projects").update({ manifest: next }).eq("id", projectId);
  if (error) {
    throw new Error(`Failed to update project ${projectId} manifest: ${error.message}`);
  }
  return next;
}
