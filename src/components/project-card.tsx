"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { projectHref } from "@/lib/nav";
import { useVasto } from "@/lib/store";
import { StatusBadge } from "./ui/badge";
import { FloorPlanThumbOrEmpty } from "./floor-plan-thumb-or-empty";
import { ProjectTypeMeta } from "./project-type-meta";
import { Icon } from "./ui/icon";

export function ProjectCard({ project }: { project: Project }) {
  const deleteProject = useVasto((s) => s.deleteProject);
  const [menu, setMenu] = useState(false);
  const renderCount = project.roomCards.reduce((sum, c) => sum + c.generations.length, 0);

  return (
    <div className="group hover-lift relative animate-fade-up rounded-2xl border border-border bg-surface">
      <Link href={projectHref(project)} className="block">
        <div className="relative aspect-[16/10] overflow-hidden rounded-t-2xl border-b border-border bg-grid bg-bg">
          <FloorPlanThumbOrEmpty plan={project.floorPlan} />
          <div className="absolute left-3 top-3">
            <StatusBadge status={project.status} />
          </div>
          {renderCount > 0 && (
            <div className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs text-foreground backdrop-blur">
              <Icon name="Image" className="size-3 text-accent" />
              {renderCount}
            </div>
          )}
        </div>
      </Link>

      <div className="flex items-center justify-between gap-2 p-4">
        <Link href={projectHref(project)} className="min-w-0 flex-1">
          <h3 className="truncate font-medium leading-tight">{project.name}</h3>
          <ProjectTypeMeta project={project} />
        </Link>

        <div className="relative">
          <button
            onClick={() => setMenu((m) => !m)}
            onBlur={() => setTimeout(() => setMenu(false), 120)}
            className="grid size-8 place-items-center rounded-lg text-muted opacity-0 transition hover:bg-surface-2 hover:text-foreground group-hover:opacity-100 cursor-pointer"
            aria-label="Project options"
          >
            <Icon name="MoreVertical" className="size-4" />
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-xl border border-border bg-surface-3 py-1 shadow-2xl">
              <button
                onClick={() => deleteProject(project.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-surface-2 cursor-pointer"
              >
                <Icon name="Trash2" className="size-4" />
                Delete project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
