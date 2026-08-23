"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
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
    // Same premature-done bug the `review` entry below documents, and the
    // same shape of fix. `rooms.some(r => r.shape)` is true straight out of
    // extraction: extract-plan.ts's toRoom populates `shape` itself from
    // Gemini's box_2d reading, so the Plan pill ticked green before the user
    // had opened the Plan Editor. Confirming rooms means passing THROUGH
    // Plan (Review's only entrance is Plan's Continue), so roomsConfirmedAt
    // is evidence for this phase too, and generated output covers projects
    // predating the field.
    // planConfirmedAt (set by plan/page.tsx's proceed(), the page's single
    // exit) is now this phase's OWN signal. Before it, the only evidence here
    // was roomsConfirmedAt — set one step LATER, on Room Confirmation — so
    // finishing the Plan page ticked nothing and the pill went green only
    // once Review was also confirmed (reported bug). The two older checks
    // stay as fallbacks for projects predating the field.
    plan:
      !!project?.planConfirmedAt ||
      !!project?.roomsConfirmedAt ||
      (project?.roomCards ?? []).some((c) => c.generations.length > 0),
    // Real signal is Project.roomsConfirmedAt, set only when the user clicks
    // Continue on Room Confirmation (review/page.tsx's goToFurnish, via the
    // store's confirmRooms) — NOT `rooms.length > 0`, which is true the
    // instant Gemini extraction finishes creating rooms, before the user has
    // opened Review at all (reported bug: the Review pill showed done while
    // still on the Plan page, pre-navigation). Projects created before this
    // field existed never got it retroactively, so also treat any project
    // with at least one generated image as having been through Review: you
    // cannot reach Generate without Room Confirmation having sent you to
    // Furnish first (goToFurnish is the only door out of Review), so
    // generated output is equally solid evidence for those older projects.
    review:
      !!project?.roomsConfirmedAt ||
      (project?.roomCards ?? []).some((c) => c.generations.length > 0),
    // `room.furniture.length > 0` used to be the signal here, on the theory
    // that greyboxKey couldn't be used (it's set by the Generate flow as a
    // side effect, regardless of whether anyone furnished anything — see the
    // comment that used to sit here). But `room.furniture` has the exact same
    // problem: the Furnish gallery's own mount effect
    // (furnish/page.tsx's FurnishGalleryContent) auto-seeds a default
    // arrangement into every never-furnished room's `furniture` field the
    // moment `/furnish` is visited — "every room starts with a default
    // arrangement automatically" is a deliberate feature, not a bug, but it
    // means `furniture.length > 0` becomes true from merely opening the
    // gallery, not from the user doing anything. That produced exactly the
    // reported bug: skip dimensions, visit Furnish (render fails so nothing
    // furnished on purpose), go back to Room Confirmation, and the Furnish
    // pill is already ticked green. The only signals in this project that
    // cannot be set by a mere page visit are `designSpec` (requires an
    // explicit Design-step submission) and a real generation — both already
    // used by `plan`/`review` above for the identical "older project, no
    // roomsConfirmedAt" fallback. Reusing them here means the Furnish pill
    // reads as "you are past Furnish", true whether the user rearranged
    // anything or deliberately skipped every room — which matches this app's
    // own stated policy that furnishing is optional.
    furnish: !!project?.designSpec || (project?.roomCards ?? []).some((c) => c.generations.length > 0),
    design: !!project?.designSpec,
    generate: (project?.roomCards ?? []).some((c) => c.generations.length > 0),
    approve: (project?.roomCards ?? []).some((c) => !!c.approvedByUser),
    walkthrough: project?.walkthrough?.status === "completed",
  };
}

/**
 * The phase list this project actually has. Identical to PHASES except on a
 * project whose Plan step was skipped (`Project.planSkipped`): there is no
 * greybox for any room, so the Furnish phase has nothing to show and no way
 * to produce anything the rest of the flow reads.
 *
 * Returned as a list rather than handled at the render site because the
 * stepper is not the only consumer of phase ORDER — `backHref` below walks
 * the same list to find the previous step, so dropping Furnish from the pills
 * alone would leave the back arrow on Design pointing at a route that now
 * refuses to render (see furnish/page.tsx's own guard). `phaseFor` and
 * `pathFallbackPhase` deliberately keep using the FULL list: they answer
 * "what phase is this URL", which is a fact about the route, not about this
 * project's flow, and a furnish URL must still resolve to "furnish" for the
 * pill-highlighting logic even while the pill itself is hidden.
 */
function phasesFor(project?: Project): typeof PHASES {
  return project?.planSkipped ? PHASES.filter((p) => p.id !== "furnish") : PHASES;
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

  // The phase this path belongs to, ignoring the ?from entry-point override
  // that only furnish/[roomId] needs (see phaseFor / StepperSlot below).
  const pathPhase = pathFallbackPhase(pathname);
  const phases = phasesFor(project);

  const backHref = (() => {
    if (step === "floor-plan") return "/";
    if (step === "upload") return `/projects/${params.id}/floor-plan`;
    if (step === "plan") return `/projects/${params.id}/upload`;
    if (step === "review") return `/projects/${params.id}/plan`;
    // Both of these sub-routes render their own in-flow back link, so
    // hasOwnBackNav hides the floating button and this branch never actually
    // renders for them. Kept correct anyway rather than left stale.
    if (step === "generate" && subSegment) return `/projects/${params.id}/generate`;
    if (step === "furnish" && subSegment) return `/projects/${params.id}/furnish`;
    // `phases`, not PHASES: on a plan-skipped project the step before Design
    // is Review, and walking the full list would send the back arrow into
    // Furnish, which that project can no longer open.
    const idx = phases.findIndex((p) => p.id === step);
    return idx > 0 ? `/projects/${params.id}/${phases[idx - 1].id}` : "/";
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
          <Suspense
            fallback={
              <PhaseStepper
                projectId={params.id}
                current={pathPhase}
                phases={phases}
                disabled={!project?.floorPlan}
                hasRoomsToLose={hasRoomsToLose}
                doneMap={computeDoneMap(project)}
                onNeedsConfirm={() => setConfirmOpen(true)}
              />
            }
          >
            <StepperSlot
              projectId={params.id}
              pathname={pathname}
              step={step}
              subSegment={subSegment}
              phases={phases}
              disabled={!project?.floorPlan}
              hasRoomsToLose={hasRoomsToLose}
              doneMap={computeDoneMap(project)}
              onNeedsConfirm={() => setConfirmOpen(true)}
            />
          </Suspense>
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

/** The phase a path belongs to on its own, with no query string involved. */
function pathFallbackPhase(pathname: string): Phase {
  return (PHASES.find((p) => pathname.includes(`/${p.id}`))?.id ?? "upload") as Phase;
}

/**
 * Resolves which stepper pill lights up, including the one route where the
 * path alone is not enough.
 *
 * `furnish/[roomId]` is a single editor with two entry points: the Furnish
 * gallery (an arrangement step) and the Generate gallery's "Adjust with 3D"
 * (an iteration step). `?from=generate` is the only thing distinguishing
 * them, and it is the same switch the page itself uses for its back link and
 * for whether it offers a Generate button, so all three agree by
 * construction.
 *
 * This used to hardcode "generate" for every furnish/[roomId] visit, which
 * meant opening a room from the Furnish gallery highlighted Generate — a
 * phase the user had not reached yet (reported bug).
 */
function phaseFor(pathname: string, step: string | undefined, subSegment: string | undefined, from: string | null): Phase {
  if (step === "furnish" && subSegment) return from === "generate" ? "generate" : "furnish";
  return pathFallbackPhase(pathname);
}

/**
 * Wraps PhaseStepper purely to read `?from`. Next requires useSearchParams to
 * sit inside a Suspense boundary, and confining it to this leaf keeps the
 * boundary off the whole frame — the same pattern furnish/[roomId]/page.tsx
 * and login-form.tsx already use.
 */
function StepperSlot({
  projectId,
  pathname,
  step,
  subSegment,
  phases,
  disabled,
  hasRoomsToLose,
  doneMap,
  onNeedsConfirm,
}: {
  projectId: string;
  pathname: string;
  step: string | undefined;
  subSegment: string | undefined;
  phases: typeof PHASES;
  disabled?: boolean;
  hasRoomsToLose: boolean;
  doneMap: Record<Phase, boolean>;
  onNeedsConfirm: () => void;
}) {
  const from = useSearchParams().get("from");
  return (
    <PhaseStepper
      projectId={projectId}
      current={phaseFor(pathname, step, subSegment, from)}
      phases={phases}
      disabled={disabled}
      hasRoomsToLose={hasRoomsToLose}
      doneMap={doneMap}
      onNeedsConfirm={onNeedsConfirm}
    />
  );
}

function PhaseStepper({
  projectId,
  current,
  phases,
  disabled,
  hasRoomsToLose,
  doneMap,
  onNeedsConfirm,
}: {
  projectId: string;
  current: Phase;
  /** This project's phases — PHASES, minus Furnish when the Plan step was skipped. See phasesFor. */
  phases: typeof PHASES;
  disabled?: boolean;
  hasRoomsToLose: boolean;
  doneMap: Record<Phase, boolean>;
  onNeedsConfirm: () => void;
}) {
  return (
    <nav className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
      {phases.map((phase, i) => {
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
            {i < phases.length - 1 && (
              <Icon name="ChevronRight" className="size-3.5 text-faint" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
