"use client";

import { useMemo, useState } from "react";
import { useVasto, useHydrated } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ProjectCard } from "@/components/project-card";
import { NewProjectModal } from "@/components/new-project-modal";

export default function DashboardPage() {
  const hydrated = useHydrated();
  const projects = useVasto((s) => s.projects);
  const [modal, setModal] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );

  const stats = useMemo(() => {
    const renders = projects.reduce((n, p) => n + p.renders.length, 0);
    const designing = projects.filter((p) => p.status === "designing" || p.status === "rendered").length;
    return { total: projects.length, renders, designing };
  }, [projects]);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b border-border px-8 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted">Welcome back — let&apos;s design something beautiful.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              className="h-10 w-56 rounded-lg border border-border bg-surface pl-9 pr-3 text-sm outline-none placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
            />
          </div>
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <Icon name="Bell" className="size-5" />
          </Button>
          <Button icon="Plus" onClick={() => setModal(true)}>
            New Project
          </Button>
        </div>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        {/* Stats */}
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard icon="PanelsTopLeft" label="Projects" value={hydrated ? stats.total : "—"} />
          <StatCard icon="Wand2" label="In design" value={hydrated ? stats.designing : "—"} accent />
          <StatCard icon="Image" label="Renders created" value={hydrated ? stats.renders : "—"} />
        </div>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Your projects</h2>
        </div>

        {!hydrated ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="shimmer aspect-[16/10] rounded-2xl border border-border bg-surface" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onNew={() => setModal(true)} hasProjects={projects.length > 0} />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>

      <NewProjectModal open={modal} onClose={() => setModal(false)} />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: string;
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-muted">
        <Icon name={icon} className={accent ? "size-4 text-accent" : "size-4"} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function EmptyState({ onNew, hasProjects }: { onNew: () => void; hasProjects: boolean }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-surface/40 py-20 text-center">
      <div className="mx-auto max-w-sm">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Icon name={hasProjects ? "Search" : "Plus"} className="size-7" />
        </div>
        <h3 className="mt-4 text-lg font-medium">
          {hasProjects ? "No matching projects" : "Create your first project"}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {hasProjects
            ? "Try a different search term."
            : "Upload a floor plan and let Vasto build a 3D interior for you."}
        </p>
        {!hasProjects && (
          <Button className="mt-5" icon="Plus" onClick={onNew}>
            New Project
          </Button>
        )}
      </div>
    </div>
  );
}
