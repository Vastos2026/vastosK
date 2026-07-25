"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { PROPERTY_TYPES } from "@/lib/data";
import { projectHref } from "@/lib/nav";
import { timeAgo } from "@/lib/utils";
import { useVasto } from "@/lib/store";
import { StatusBadge } from "./ui/badge";
import { PlanThumb } from "./plan-thumb";
import { Icon } from "./ui/icon";

export function ProjectCard({ project }: { project: Project }) {
  const deleteProject = useVasto((s) => s.deleteProject);
  const [menu, setMenu] = useState(false);
  const propType = PROPERTY_TYPES.find((p) => p.id === project.propertyType);
  const renderCount = project.renders.length;

  return (
    <div className="group hover-lift relative animate-fade-up rounded-2xl border border-border bg-surface">
      <Link href={projectHref(project)} className="block">
        <div className="relative aspect-[16/10] overflow-hidden rounded-t-2xl border-b border-border bg-grid bg-bg">
          {project.floorPlan ? (
            <div className="absolute inset-0 p-5 transition-transform duration-300 group-hover:scale-[1.03]">
              <PlanThumb plan={project.floorPlan} />
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center text-faint">
              <div className="flex flex-col items-center gap-2">
                <Icon name="FileUp" className="size-7" />
                <span className="text-xs">No floor plan yet</span>
              </div>
            </div>
          )}
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
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <Icon name={propType?.icon ?? "Box"} className="size-3.5" />
            {propType?.label}
            <span className="text-faint">·</span>
            Updated {timeAgo(project.updatedAt)}
          </p>
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
