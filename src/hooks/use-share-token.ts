"use client";

import { useVasto } from "@/lib/store";
import { createShareLink } from "@/lib/generation-client";
import type { Project, Walkthrough } from "@/lib/types";

/**
 * Mints (or reuses) a project's walkthrough share token. Shared by the
 * Walkthrough page's "Get shareable link" button and `useExportProjectPdf`
 * (the PDF's video link needs the same public `/s/[token]` URL, not the raw
 * authenticated storage URL — see that hook's comment for why).
 *
 * Takes `Project | undefined` (not just `Project`) because callers need to
 * call this hook unconditionally, before whatever "no project yet" early
 * return their page has — same reason `useProject(id)` itself can return
 * undefined. `ensureShareToken` is only ever actually invoked from a button
 * that only renders once a project exists, so the undefined case here is a
 * type-safety formality, not a real runtime path.
 */
export function useShareToken(project: Project | undefined) {
  const setWalkthrough = useVasto((s) => s.setWalkthrough);

  const ensureShareToken = async (
    wt: Walkthrough,
  ): Promise<{ token: string | undefined; persisted: boolean }> => {
    if (!project) return { token: undefined, persisted: false };
    if (wt.shareToken) return { token: wt.shareToken, persisted: true };
    const result = await createShareLink({ projectId: project.id });
    const token = result.token ?? undefined;
    if (token) setWalkthrough(project.id, { ...wt, shareToken: token });
    return { token, persisted: result.persisted };
  };

  return { ensureShareToken };
}
