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
import type { Phase, Project } from "@/lib/types";

/**
 * A phase is "done" based on whether the project actually HAS that phase's
 * output, not on whether the current page is past it — the old
 * `i < currentIdx` comparison made a completed phase's tick disappear the
 * moment you navigated backward to look at an earlier step, only to
 * reappear once you scrolled back past it (reported bug, 2026-07-30).
 */
function computeDoneMap(project?: Project): Record<Phase, boolean> {
  return {
    upload: !!project?.floorPlan,
    plan: (project?.floorPlan?.rooms ?? []).some((r) => !!r.shape),
    review: (project?.floorPlan?.rooms?.length ?? 0) > 0,
    // furnish is done when at least one room has furniture. greyboxKey is not the signal
    // because it's set by the Generate flow as a side effect (via ensureGreybox),
    // regardless of whether anyone actually furnished the room.
    furnish: (project?.floorPlan?.rooms ?? []).some((r) => (r.furniture?.length ?? 0) > 0),
    design: !!project?.designSpec,
    generate: (project?.roomCards ?? []).some((c) => c.generations.length > 0),
    approve: (project?.roomCards ?? []).some((c) => !!c.approvedByUser),
    walkthrough: project?.walkthrough?.status === "completed",
  };
}

export function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const hydrated = useHydrated();
  const project = useVasto((s) => s.projects.find((p) => p.id === params.id));
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Route segments after the project id: ["floor-plan"] / ["upload"] /
  // ["generate", roomId] / etc — used for both currentPhase and the
  // back-step arrow, which need to distinguish routes PHASES doesn't know
  // about (floor-plan isn't a tracked phase; generate/[roomId] and
  // furnish/[roomId] are per-room sub-routes reached FROM "generate", so
  // both should read/behave as "generate", not fall through to the "upload"
  // default just because "furnish" isn't a phase id substring of the path).
  const segments = pathname.split("/").filter(Boolean);
  const step = segments[2];
  const subSegment = segments[3];
  const hasRoomsToLose = (project?.floorPlan?.rooms?.length ?? 0) > 0;

  // generate/[roomId] (View & Edit) and furnish/[roomId] each render their own
  // in-flow back link in a header at the same top-left spot — the floating
  // button below would stack directly on top of it, hiding the room name
  // (reported bug). Those two are the only sub-routes with their own header.
  const hasOwnBackNav = (step === "generate" || step === "furnish") && !!subSegment;

  // Match the phase whose segment appears in the path — "furnish" maps to
  // "generate" (see comment above) rather than being matched generically.
  const currentPhase = (
    step === "furnish" ? "generate" : (PHASES.find((p) => pathname.includes(`/${p.id}`))?.id ?? "upload")
  ) as Phase;

  const backHref = (() => {
    if (step === "floor-plan") return "/";
    if (step === "upload") return `/projects/${params.id}/floor-plan`;
    if (step === "plan") return `/projects/${params.id}/upload`;
    if (step === "review") return `/projects/${params.id}/plan`;
    if ((step === "generate" || step === "furnish") && subSegment) return `/projects/${params.id}/generate`;
    const idx = PHASES.findIndex((p) => p.id === step);
    return idx > 0 ? `/projects/${params.id}/${PHASES[idx - 1].id}` : "/";
  })();

  const onBackClick = () => {
    // Going back from Review effectively re-enters Upload, which wipes
    // downstream work once rooms exist — same confirmation the phase-pill's
    // own Upload jump already shows, reused here rather than duplicated.
    if (step === "review" && hasRoomsToLose) {
      setConfirmOpen(true);
      return;
    }
    router.push(backHref);
  };

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
      <header className="relative z-20 flex items-center gap-4 border-b border-border px-5 py-3">
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href="/"
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"
            aria-label="Back to dashboard"
            title="Dashboard"
          >
            <Icon name="Home" className="size-4" />
          </Link>
        </div>

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
            hasRoomsToLose={hasRoomsToLose}
            doneMap={computeDoneMap(project)}
            onNeedsConfirm={() => setConfirmOpen(true)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-faint md:flex">
            <Icon name="CircleCheck" className="size-3.5 text-success" />
            Saved
          </span>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {!hasOwnBackNav && (
          <button
            type="button"
            onClick={onBackClick}
            className="absolute left-4 top-4 z-10 grid size-9 place-items-center rounded-lg border border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
            aria-label="Back one step"
            title="Back"
          >
            <Icon name="ArrowLeft" className="size-5" />
          </button>
        )}
        {children}
      </div>

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
              router.push(`/projects/${params.id}/upload`);
              setConfirmOpen(false);
            }}
          >
            Yes, upload new plan
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function PhaseStepper({
  projectId,
  current,
  disabled,
  hasRoomsToLose,
  doneMap,
  onNeedsConfirm,
}: {
  projectId: string;
  current: Phase;
  disabled?: boolean;
  hasRoomsToLose: boolean;
  doneMap: Record<Phase, boolean>;
  onNeedsConfirm: () => void;
}) {
  return (
    <nav className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
      {PHASES.map((phase, i) => {
        const active = phase.id === current;
        const done = !active && doneMap[phase.id];
        // Upload is always reachable; later phases need a parsed plan.
        const locked = disabled && phase.id !== "upload";
        // Re-uploading once rooms exist wipes generated work downstream, so
        // that one tab needs a confirmation step instead of a plain link.
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
              <button type="button" onClick={onNeedsConfirm} className="cursor-pointer">
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
  );
}
