"use client";

import { useVasto, useHydrated } from "@/lib/store";
import { ProjectCard } from "@/components/project-card";
import { Icon } from "@/components/ui/icon";

/**
 * Reads from the same local-first store `/projects` uses — the app's projects
 * aren't wired onto the real `projects` table yet (see CLAUDE.md, "Project
 * lifecycle state machine"), so a DB-backed usage query would just read zeros.
 * This gets a real, working project list/count today; swap to a `projects`
 * table query once the frontend is rebuilt onto it (Workstream 8) and
 * `generations` exists (Workstream 11) for a proper generation count.
 */
export function ProfileProjects() {
  const hydrated = useHydrated();
  const projects = useVasto((s) => s.projects);
  const rendered = projects.filter((p) => p.roomCards.some((c) => c.generations.length > 0)).length;

  return (
    <div className="mt-6">
      <div className="glass flex divide-x divide-white/[0.06] overflow-hidden rounded-2xl">
        <div className="flex-1 px-5 py-4">
          <p className="text-2xl font-semibold text-foreground">{hydrated ? projects.length : "–"}</p>
          <p className="text-sm text-muted">Projects</p>
        </div>
        <div className="flex-1 px-5 py-4">
          <p className="text-2xl font-semibold text-foreground">{hydrated ? rendered : "–"}</p>
          <p className="text-sm text-muted">With renders</p>
        </div>
      </div>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted">Your projects</h2>
      {!hydrated ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="shimmer aspect-[16/10] rounded-2xl border border-border bg-surface" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-center">
          <div>
            <Icon name="PanelsTopLeft" className="mx-auto size-8 text-faint" />
            <p className="mt-3 text-sm text-muted">No projects yet.</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
