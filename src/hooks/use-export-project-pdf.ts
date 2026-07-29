"use client";

import { useAsyncFeedback } from "./use-async-feedback";
import { useShareToken } from "./use-share-token";
import { exportProjectPdf } from "@/lib/generation-client";
import { PROPERTY_TYPES, STYLES, COLOUR_PALETTES } from "@/lib/data";
import { resolveApprovedRooms } from "@/lib/projects/approved-rooms";
import type { Project } from "@/lib/types";

/**
 * Shared "Export PDF" flow for a project with a completed walkthrough — was
 * independently hand-rolled (almost verbatim) on both the Walkthrough page
 * and the Profile page's project cards. Consolidating here also fixes a real
 * inconsistency the duplication had let drift: the profile card's copy sent
 * the raw authenticated `/api/render?key=` video URL and never a floor-plan
 * image, while the walkthrough page's copy (fixed more recently) mints/reuses
 * a public share token so the PDF's video link actually opens for someone
 * without a Vastos login, and includes the floor plan when one exists. Both
 * call sites now get the same corrected behavior instead of two copies that
 * could silently diverge again.
 *
 * Takes `Project | undefined` for the same reason `useShareToken` does —
 * called unconditionally before a page's "no project yet" early return.
 */
export function useExportProjectPdf(project: Project | undefined) {
  const { ensureShareToken } = useShareToken(project);
  const pdfExport = useAsyncFeedback();

  const exportPdf = () =>
    pdfExport.run(async () => {
      const wt = project?.walkthrough;
      if (!project || !wt) return;

      const exportRooms = resolveApprovedRooms(project);
      const propertyTypeLabel =
        PROPERTY_TYPES.find((p) => p.id === project.propertyType)?.label ?? project.propertyType;
      const styleLabel = project.styleId ? STYLES.find((s) => s.id === project.styleId)?.name : undefined;
      const palette = project.colourPalette
        ? COLOUR_PALETTES.find((c) => c.id === project.colourPalette)
        : undefined;

      const { token } = await ensureShareToken(wt);
      const walkthroughLinkUrl = token ? `${window.location.origin}/s/${token}` : undefined;

      const blob = await exportProjectPdf({
        projectId: project.id,
        projectName: project.name,
        propertyTypeLabel,
        subcategory: project.subcategory,
        styleLabel,
        luxuryLevel: project.luxuryLevel,
        colourPaletteLabel: palette?.label,
        colourSwatch: palette?.swatch,
        rooms: exportRooms,
        walkthroughVideoUrl: walkthroughLinkUrl,
        floorPlanImageKey: project.floorPlan?.meta?.storageKey,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name || "project"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

  return { exportPdf, busy: pdfExport.busy, feedback: pdfExport.feedback };
}
