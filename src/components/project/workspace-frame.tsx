"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useVasto, useHydrated } from "@/lib/store";
import { useVideoReconcile } from "@/lib/use-video-reconcile";
import { PHASES } from "@/lib/nav";
import { PROPERTY_TYPES } from "@/lib/data";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Phase } from "@/lib/types";

export function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const project = useVasto((s) => s.projects.find((p) => p.id === params.id));
  // Reclaim walkthrough clips that finished server-side while no tab was
  // listening (reload / crash / sync race mid-generation).
  useVideoReconcile(hydrated ? project?.id : undefined);

  // Match the phase whose segment appears in the path (so /rooms/<id> and
  // /renders/<id> still highlight their phase, not the trailing id).
  const currentPhase = (PHASES.find((p) => pathname.includes(`/${p.id}`))?.id ?? "upload") as Phase;

  if (hydrated && !project) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-2 text-muted">
            <Icon name="CircleAlert" className="size-7" />
          </div>
          <h2 className="mt-4 text-lg font-medium">Project not found</h2>
          <p className="mt-1 text-sm text-muted">It may have been deleted.</p>
          <Link href="/">
            <Button className="mt-4" variant="outline" icon="ArrowLeft">
              Back to dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const propType = project && PROPERTY_TYPES.find((p) => p.id === project.propertyType);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-5 py-3">
        <Link
          href="/"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"
          aria-label="Back to dashboard"
        >
          <Icon name="ArrowLeft" className="size-5" />
        </Link>

        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">
              {project?.name ?? "Loading…"}
            </h1>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              {propType && (
                <>
                  <Icon name={propType.icon} className="size-3" />
                  {propType.label}
                </>
              )}
            </div>
          </div>
          {project && <StatusBadge status={project.status} />}
        </div>

        <div className="mx-auto">
          <PhaseStepper projectId={params.id} current={currentPhase} disabled={!project?.floorPlan} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-faint md:flex">
            <Icon name="CircleCheck" className="size-3.5 text-success" />
            Saved
          </span>
          <Button variant="outline" size="sm" icon="Download" className="hidden sm:inline-flex">
            Export
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function PhaseStepper({
  projectId,
  current,
  disabled,
}: {
  projectId: string;
  current: Phase;
  disabled?: boolean;
}) {
  const currentIdx = PHASES.findIndex((p) => p.id === current);

  return (
    <nav className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
      {PHASES.map((phase, i) => {
        const active = phase.id === current;
        const done = i < currentIdx;
        // Upload is always reachable; later phases need a parsed plan.
        const locked = disabled && phase.id !== "upload";

        const content = (
          <span
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-accent/15 text-accent"
                : locked
                  ? "text-faint"
                  : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full text-[10px]",
                active
                  ? "bg-accent text-accent-foreground"
                  : done
                    ? "bg-success/20 text-success"
                    : "bg-surface-3 text-faint",
              )}
            >
              {done ? <Icon name="Check" className="size-3" /> : i + 1}
            </span>
            <span className="hidden lg:inline">{phase.label}</span>
          </span>
        );

        return (
          <div key={phase.id} className="flex items-center">
            {locked ? (
              <span className="cursor-not-allowed">{content}</span>
            ) : (
              <Link href={`/projects/${projectId}/${phase.id}`}>{content}</Link>
            )}
            {i < PHASES.length - 1 && (
              <Icon name="ChevronRight" className="size-3.5 text-faint" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
