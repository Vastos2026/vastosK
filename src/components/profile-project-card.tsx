"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { projectHref } from "@/lib/nav";
import { useExportProjectPdf } from "@/hooks/use-export-project-pdf";
import { StatusBadge } from "./ui/badge";
import { FloorPlanThumbOrEmpty } from "./floor-plan-thumb-or-empty";
import { ProjectTypeMeta } from "./project-type-meta";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { RetryImg } from "./ui/retry-img";

/**
 * Wide, horizontal project summary card for the Profile page (distinct from
 * the small vertical grid `ProjectCard` used on the `/projects` dashboard —
 * that component is left untouched, this is a separate layout for this page
 * only). Left: the floor-plan thumbnail (or empty state). Right: every
 * generated image across all rooms plus the walkthrough video (if any),
 * clubbed into one compact grid. The whole card resumes the project wherever
 * it was left, via the same `projectHref`/`resumePhase` logic the dashboard
 * card already uses.
 */
export function ProfileProjectCard({ project }: { project: Project }) {
  const generations = project.roomCards
    .flatMap((c) => c.generations)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const wt = project.walkthrough;
  const walkthroughCompleted = wt?.status === "completed";
  // Counted as a render alongside every room image (see project-card.tsx's
  // renderCount for the equivalent dashboard-card calc).
  const renderCount = generations.length + (walkthroughCompleted ? 1 : 0);

  const [showWalkthrough, setShowWalkthrough] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const pdfExport = useExportProjectPdf(project);

  // Clicks inside this card can open the walkthrough modal or trigger a PDF
  // export/download — neither should also follow the card's own resume
  // link, since both are nested inside it.
  const stopLinkNav = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Link
      href={projectHref(project)}
      className="group hover-lift block animate-fade-up rounded-2xl border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium leading-tight">{project.name}</h3>
          <ProjectTypeMeta project={project} />
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="flex flex-col gap-4 p-5 sm:flex-row">
        {/* Left: floor-plan thumbnail, or the same empty state project-card.tsx uses. */}
        <div className="relative aspect-square w-full shrink-0 overflow-hidden rounded-xl border border-border bg-grid bg-bg sm:size-40">
          <FloorPlanThumbOrEmpty plan={project.floorPlan} padding="p-4" iconSize="size-6" />
        </div>

        {/* Right: every generated image across every room, plus the
            walkthrough video if there is one, clubbed together. */}
        <div className="min-w-0 flex-1">
          {renderCount === 0 ? (
            <div className="grid h-full min-h-24 place-items-center rounded-xl border border-dashed border-border text-center">
              <div>
                <Icon name="Image" className="mx-auto size-6 text-faint" />
                <p className="mt-2 text-xs text-muted">No renders yet</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap content-start gap-2">
                {generations.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={(e) => {
                      stopLinkNav(e);
                      setLightboxImage(g.imageUrl);
                    }}
                    className="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-2 sm:size-20"
                    aria-label="View render"
                  >
                    <RetryImg src={g.imageUrl} alt="" className="size-full object-cover" />
                  </button>
                ))}
                {wt?.videoUrl && (
                  <button
                    type="button"
                    onClick={(e) => {
                      stopLinkNav(e);
                      setShowWalkthrough(true);
                    }}
                    className="group/wt relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-2 sm:size-20"
                    aria-label="Play walkthrough"
                  >
                    <video
                      src={wt.videoUrl}
                      preload="metadata"
                      muted
                      playsInline
                      className="size-full object-cover"
                    />
                    <div className="absolute inset-0 grid place-items-center bg-black/40 opacity-100 transition-opacity group-hover/wt:opacity-70">
                      <Icon name="Clapperboard" className="size-5 text-white" />
                    </div>
                  </button>
                )}
              </div>

              {walkthroughCompleted && (
                <div onClick={stopLinkNav} className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    icon="FileUp"
                    loading={pdfExport.busy}
                    onClick={pdfExport.exportPdf}
                  >
                    Export PDF
                  </Button>
                  {pdfExport.feedback && (
                    <span className="text-xs text-muted">{pdfExport.feedback}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {wt?.videoUrl && (
        <div onClick={stopLinkNav}>
          <Modal
            open={showWalkthrough}
            onClose={() => setShowWalkthrough(false)}
            title="Walkthrough"
            className="max-w-2xl"
          >
            <div className="p-5">
              <video src={wt.videoUrl} controls autoPlay className="w-full rounded-xl border border-border" />
            </div>
          </Modal>
        </div>
      )}

      {lightboxImage && (
        <div onClick={stopLinkNav}>
          <Modal open={!!lightboxImage} onClose={() => setLightboxImage(null)} className="max-w-2xl">
            <div className="p-5">
              {/* Fixed-height box, not an intrinsic-size <img> — RetryImg's
                  inner <img> is always position:absolute + inset-0 (see that
                  component's own doc comment), so it needs a sized ancestor
                  to fill; a plain height-auto box would collapse to nothing. */}
              <div className="relative h-[70vh] w-full">
                <RetryImg
                  src={lightboxImage}
                  alt="Render"
                  loading="eager"
                  className="h-full w-full rounded-xl border border-border object-contain"
                />
              </div>
              <div className="mt-4 flex justify-end">
                <Link href={projectHref(project)}>
                  <Button icon="ArrowRight">Go to project</Button>
                </Link>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </Link>
  );
}
