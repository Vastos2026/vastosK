"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useVasto, useHydrated } from "@/lib/store";
import { PHASES } from "@/lib/nav";
import { PROPERTY_TYPES } from "@/lib/data";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { Phase } from "@/lib/types";

export function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const project = useVasto((s) => s.projects.find((p) => p.id === params.id));

  // Match the phase whose segment appears in the path.
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
          <PhaseStepper
            projectId={params.id}
            current={currentPhase}
            disabled={!project?.floorPlan}
            floorPlanRoomCount={project?.floorPlan?.rooms?.length ?? 0}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-faint md:flex">
            <Icon name="CircleCheck" className="size-3.5 text-success" />
            Saved
          </span>
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
  floorPlanRoomCount,
}: {
  projectId: string;
  current: Phase;
  disabled?: boolean;
  floorPlanRoomCount: number;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const currentIdx = PHASES.findIndex((p) => p.id === current);
  // Re-uploading once rooms exist wipes generated work downstream, so that
  // one tab needs a confirmation step instead of a plain link.
  const hasRoomsToLose = floorPlanRoomCount > 0;

  return (
    <>
      <nav className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
        {PHASES.map((phase, i) => {
          const active = phase.id === current;
          const done = i < currentIdx;
          // Upload is always reachable; later phases need a parsed plan.
          const locked = disabled && phase.id !== "upload";
          const needsConfirm = phase.id === "upload" && hasRoomsToLose;

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
              ) : needsConfirm ? (
                <button type="button" onClick={() => setConfirmOpen(true)} className="cursor-pointer">
                  {content}
                </button>
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

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Upload a new plan?"
        description="This replaces your current rooms, design, and generated images."
      >
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              router.push(`/projects/${projectId}/upload`);
              setConfirmOpen(false);
            }}
          >
            Yes, upload new plan
          </Button>
        </div>
      </Modal>
    </>
  );
}
