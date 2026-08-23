"use client";

import { useVasto } from "@/lib/store";
import { createShareLink, revokeShareLink } from "@/lib/generation-client";
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
    // Short-circuit ONLY on a token known to have reached the server. A
    // cached but unpersisted token resolves for nobody — /s/<token> looks it
    // up in project_snapshots — so returning it as `persisted: true` (which
    // this did unconditionally) told the owner a dead link was safe to send,
    // and never retried. Retrying is cheap and idempotent: the route reuses
    // whatever token is already on the row, so this converges on the real
    // one instead of churning a new token per click.
    if (wt.shareToken && wt.shareTokenPersisted) {
      return { token: wt.shareToken, persisted: true };
    }
    const result = await createShareLink({ projectId: project.id });
    const token = result.token ?? undefined;
    if (token) {
      setWalkthrough(project.id, { ...wt, shareToken: token, shareTokenPersisted: result.persisted });
    }
    return { token, persisted: result.persisted };
  };

  /**
   * Kills this project's share link. `regenerate` rotates instead — the old
   * link dies and a new one replaces it, which is what a leaked link needs.
   *
   * Clears the local cache on success so the UI stops offering a token the
   * server no longer honours. Rethrows on failure rather than swallowing:
   * telling an owner a leaked link is dead while it still resolves is worse
   * than showing them an error.
   */
  const revokeToken = async (
    wt: Walkthrough,
    opts: { regenerate?: boolean } = {},
  ): Promise<{ token: string | undefined }> => {
    if (!project) return { token: undefined };
    const result = await revokeShareLink({ projectId: project.id, regenerate: opts.regenerate });
    const token = result.token ?? undefined;
    setWalkthrough(project.id, { ...wt, shareToken: token, shareTokenPersisted: token ? true : undefined });
    return { token };
  };

  return { ensureShareToken, revokeToken };
}
