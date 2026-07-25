"use client";

/**
 * Reclaim walkthrough results whose response never reached the client.
 *
 * The Veo clip takes ~100s to generate. If the awaiting tab reloads, crashes,
 * or its local state loses the race with a snapshot pull, the local "pano"
 * render record stays stuck on "processing" forever — even though the server
 * finished, stored the mp4 + stills, and recorded the outcome in the durable
 * job registry (video-jobs). This hook sweeps such records on every project
 * page and applies the registry's terminal outcome, so a paid generation is
 * recovered instead of silently lost.
 *
 * Two shapes of loss are covered:
 *   - records stuck "processing" (the awaiter died silently, e.g. tab crash);
 *   - records marked "failed" by the fetch ABORT racing page teardown — the
 *     client-side error says nothing about the server outcome, which often
 *     completes fine ~a minute later. If the registry says done, done wins.
 *
 * Guards against double-apply with a live in-tab run: "processing" records
 * younger than 60s are skipped (a live awaiter owns them; failed ones have no
 * awaiter and are probed immediately), only terminal job states are applied,
 * and the record's status is re-checked right before writing.
 */

import { useEffect, useRef } from "react";
import { useVasto } from "@/lib/store";
import { fetchVideoJob } from "@/lib/render-client";
import { uid } from "@/lib/utils";

const MIN_AGE_MS = 60_000;
const SWEEP_EVERY_MS = 45_000;
const SIDE_VIEWS = ["left", "right", "back"] as const;

export function useVideoReconcile(projectId: string | undefined) {
  const applied = useRef(new Set<string>());

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;

    // A record is reclaimable while it holds no result: still "processing"
    // (dead awaiter) or "failed" with no versions (abort-race false negative).
    const reclaimable = (status: string, versions: number) =>
      status === "processing" || (status === "failed" && versions === 0);

    const sweep = async () => {
      const project = useVasto.getState().getProject(projectId);
      if (!project) return;
      const stuck = project.renders.filter(
        (r) =>
          r.view === "pano" &&
          reclaimable(r.status, r.versions?.length ?? 0) &&
          !applied.current.has(r.id) &&
          (r.status === "failed" || Date.now() - Date.parse(r.createdAt) > MIN_AGE_MS),
      );

      for (const record of stuck) {
        const job = await fetchVideoJob(record.id);
        if (disposed) return;
        // No registry entry or still running → no information; leave the record.
        if (!job || job.status === "processing") continue;
        applied.current.add(record.id);

        const st = useVasto.getState();
        const fresh = st.getProject(projectId)?.renders.find((x) => x.id === record.id);
        if (!fresh || !reclaimable(fresh.status, fresh.versions?.length ?? 0)) continue;

        // Scope to THIS pano's sides via videoOf — never touch another attempt's
        // same-room side records. (Legacy sides written before videoOf existed
        // fall back to the room+view match so they can still be recovered.)
        const sides = (view: string) =>
          st
            .getProject(projectId)
            ?.renders.filter(
              (x) =>
                x.view === view &&
                reclaimable(x.status, x.versions?.length ?? 0) &&
                (x.videoOf ? x.videoOf === record.id : x.roomId === fresh.roomId && !x.videoOf),
            ) ?? [];

        if (job.status === "failed" || !job.result) {
          const error = job.error ?? "The walkthrough video failed.";
          st.updateRender(projectId, record.id, { status: "failed", error });
          for (const view of SIDE_VIEWS)
            for (const side of sides(view))
              st.updateRender(projectId, side.id, { status: "failed", error });
          continue;
        }

        const now = new Date().toISOString();
        st.addRenderVersion(projectId, record.id, {
          id: uid("v"),
          label: "v1",
          createdAt: now,
          note: "Walkthrough",
          styleId: fresh.styleId,
          imageUrl: job.result.videoUrl,
          imageKey: job.result.key,
          ...(job.result.warning ? { warning: job.result.warning } : {}),
        });
        st.updateRender(projectId, record.id, { status: "completed", progress: 100 });

        const byView = new Map(job.result.frames.map((f) => [f.view, f]));
        for (const view of SIDE_VIEWS) {
          const frame = byView.get(view);
          for (const side of sides(view)) {
            if (!frame) {
              st.updateRender(projectId, side.id, {
                status: "failed",
                error: "No frame extracted (is ffmpeg installed?)",
              });
              continue;
            }
            st.addRenderVersion(projectId, side.id, {
              id: uid("v"),
              label: "v1",
              createdAt: now,
              note: frame.label,
              styleId: side.styleId,
              imageUrl: frame.imageUrl,
              imageKey: frame.key,
            });
            st.updateRender(projectId, side.id, { status: "completed", progress: 100 });
          }
        }
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [projectId]);
}
