"use client";

import { useState } from "react";
import { useVasto, useHydrated } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/project-card";
import { NewProjectModal } from "@/components/new-project-modal";
import { DeleteAllProjectsButton } from "@/components/delete-all-projects-button";
import { Icon } from "@/components/ui/icon";

export default function ProjectsPage() {
  const hydrated = useHydrated();
  const projects = useVasto((s) => s.projects);
  const [modal, setModal] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-8 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted">All your interior design projects in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          {hydrated && <DeleteAllProjectsButton count={projects.length} />}
          <Button icon="Plus" onClick={() => setModal(true)}>New Project</Button>
        </div>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        {!hydrated ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="shimmer aspect-[16/10] rounded-2xl border border-border bg-surface" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border py-20 text-center">
            <div>
              <Icon name="PanelsTopLeft" className="mx-auto size-8 text-faint" />
              <p className="mt-3 text-sm text-muted">No projects yet.</p>
              <Button className="mt-4" icon="Plus" onClick={() => setModal(true)}>New Project</Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>

      <NewProjectModal open={modal} onClose={() => setModal(false)} />
    </div>
  );
}
