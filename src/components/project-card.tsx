"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { projectHref } from "@/lib/nav";
import { useVasto } from "@/lib/store";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./ui/badge";
import { FloorPlanThumbOrEmpty } from "./floor-plan-thumb-or-empty";
import { ProjectTypeMeta } from "./project-type-meta";
import { Icon } from "./ui/icon";

export function ProjectCard({ project }: { project: Project }) {
  const deleteProject = useVasto((s) => s.deleteProject);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renderCount = project.roomCards.reduce((sum, c) => sum + c.generations.length, 0);

  // Close on an outside click rather than on blur+timeout — a blur-based
  // dismiss races the very click on a menu item it's meant to let through:
  // clicking "Delete project" first shifts focus away from the trigger
  // button (firing its blur) before the click itself registers, and if the
  // deferred setTimeout close beats that click, the menu unmounts before
  // "Delete project"'s own onClick ever fires — it just silently does
  // nothing. Listening for mousedown outside this menu's own ref sidesteps
  // that race entirely: a click ON the menu is never treated as "outside."
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menu]);

  return (
    <div
      className={cn(
        "group hover-lift relative animate-fade-up rounded-2xl border border-border bg-surface",
        menu && "z-30",
      )}
    >
      <Link href={projectHref(project)} className="block">
        <div className="relative aspect-[16/10] overflow-hidden rounded-t-2xl border-b border-border bg-grid bg-bg">
          <FloorPlanThumbOrEmpty plan={project.floorPlan} padding="p-3" iconSize="size-5" />
          <div className="absolute left-2 top-2">
            <StatusBadge status={project.status} />
          </div>
          {renderCount > 0 && (
            <div className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-foreground backdrop-blur">
              <Icon name="Image" className="size-3 text-accent" />
              {renderCount}
            </div>
          )}
        </div>
      </Link>

      <div className="flex items-center justify-between gap-2 p-2.5">
        <Link href={projectHref(project)} className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium leading-tight">{project.name}</h3>
          <ProjectTypeMeta project={project} />
        </Link>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            className="grid size-7 place-items-center rounded-lg text-muted opacity-0 transition hover:bg-surface-2 hover:text-foreground group-hover:opacity-100 cursor-pointer"
            aria-label="Project options"
          >
            <Icon name="MoreVertical" className="size-4" />
          </button>
          {menu && (
            <div className="absolute bottom-8 right-0 z-20 w-40 overflow-hidden rounded-xl border border-border bg-surface-3 py-1 shadow-2xl">
              <button
                type="button"
                onClick={() => {
                  setMenu(false);
                  deleteProject(project.id);
                }}
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
