"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { categoryForPropertyType, getProjectTypeConfig, orderRoomsForWalkthrough } from "@/lib/project-types/config";
import { generateWalkthrough, orderRoomsWithAI } from "@/lib/generation-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Room } from "@/lib/types";

/**
 * Walkthrough (revamp Workstream 8.5, flow step 11) — simplified per the
 * 2026-07-26 alignment review: one 3-second cinematic-zoom-in clip per
 * approved room image, concatenated in order. No orbit, no consistency
 * checks — that machinery was destroyed with the old render pipeline.
 */
export default function WalkthroughPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const setWalkthrough = useVasto((s) => s.setWalkthrough);

  // Manual reorder (or a resolved AI order) overrides the derived default once set.
  const [order, setOrder] = useState<Room[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rooms = project?.floorPlan?.rooms ?? [];
  const included = rooms.filter((r) => project?.roomCards.find((c) => c.roomId === r.id)?.included);
  const includedKey = included.map((r) => r.id).join(",");

  const category = project ? categoryForPropertyType(project.propertyType) : "";
  const config = project ? getProjectTypeConfig(category) : null;
  const tokens = included.map((r) => r.type || r.name);
  const covered = (config?.walkthroughOrder.length ?? 0) > 0 && tokens.every((t) => config!.walkthroughOrder.includes(t));

  // Static per-category order — purely derived, no effect needed.
  const staticOrder = useMemo(() => {
    if (!covered) return null;
    const orderedNames = orderRoomsForWalkthrough(category, tokens);
    return orderedNames.map((t, i) => included.find((r) => (r.type || r.name) === t) ?? included[i]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered, category, includedKey]);

  const effectiveOrder = order ?? staticOrder ?? included;
  // Derived, not stateful: true exactly while the AI fallback's request is in
  // flight (nothing has resolved a manual/AI order yet, and there's no static one).
  const orderingBusy = !covered && order === null && included.length > 0;

  // Only the AI fallback (Custom / unrecognized room types) needs an effect —
  // an actual async call to an external system, not a synchronous derivation.
  useEffect(() => {
    if (!project || included.length === 0 || covered) return;
    orderRoomsWithAI({ category, roomNames: included.map((r) => r.name) })
      .then(({ order: names }) => {
        setOrder(names.map((n) => included.find((r) => r.name === n)).filter((r): r is Room => !!r));
      })
      .catch(() => setOrder(included));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, includedKey, covered]);

  if (!project) return null;

  if (included.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="Clapperboard" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">Approve at least one room to build a walkthrough.</p>
          <Link href={`/projects/${id}/approve`}>
            <Button className="mt-4" variant="outline">Go to Approve</Button>
          </Link>
        </div>
      </div>
    );
  }

  const move = (i: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const base = prev ?? effectiveOrder;
      const j = i + dir;
      if (j < 0 || j >= base.length) return base;
      const next = [...base];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const generate = async () => {
    if (busy || effectiveOrder.length === 0) return;
    setBusy(true);
    setError(null);
    setWalkthrough(id, { status: "processing", createdAt: new Date().toISOString(), roomOrder: effectiveOrder.map((r) => r.id) });
    try {
      const payload = effectiveOrder.map((r) => {
        const card = project.roomCards.find((c) => c.roomId === r.id)!;
        const approved = card.generations.find((g) => g.id === card.approvedId) ?? card.generations.at(-1)!;
        return { id: r.id, name: r.name, imageKey: approved.imageKey };
      });
      const result = await generateWalkthrough({ projectId: id, rooms: payload });
      setWalkthrough(id, {
        status: "completed",
        createdAt: new Date().toISOString(),
        videoUrl: result.videoUrl,
        videoKey: result.key,
        shareToken: crypto.randomUUID(),
        roomOrder: effectiveOrder.map((r) => r.id),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Walkthrough generation failed";
      setError(msg);
      setWalkthrough(id, { status: "failed", createdAt: new Date().toISOString(), roomOrder: effectiveOrder.map((r) => r.id), error: msg });
    } finally {
      setBusy(false);
    }
  };

  const wt = project.walkthrough;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h2 className="text-2xl font-bold tracking-tight">Walkthrough</h2>
        <p className="mt-1 text-sm text-muted">
          One 3-second cinematic zoom per room, stitched in this order.
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Sizes can appear a little larger or smaller than expected — confirm with the sq ft
          figure for accuracy.
        </p>

        <div className="mt-6 space-y-2">
          {orderingBusy ? (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
              <Icon name="Loader2" className="size-4 animate-spin text-accent" /> Working out the best order…
            </div>
          ) : (
            effectiveOrder.map((room, i) => (
              <div key={room.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-xs font-medium text-muted">
                  {i + 1}
                </span>
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: room.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{room.name}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" icon="ChevronLeft" onClick={() => move(i, -1)} disabled={i === 0} />
                  <Button size="sm" variant="ghost" icon="ChevronRight" onClick={() => move(i, 1)} disabled={i === effectiveOrder.length - 1} />
                </div>
              </div>
            ))
          )}
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {wt?.status === "completed" && wt.videoUrl ? (
          <div className="mt-6">
            <video src={wt.videoUrl} controls className="w-full rounded-2xl border border-border" />
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={wt.videoUrl} download>
                <Button variant="outline" icon="Download">Download</Button>
              </a>
              <Button
                variant="outline"
                icon="Copy"
                onClick={() => navigator.clipboard.writeText(`${window.location.origin}${wt.videoUrl}`)}
              >
                Get shareable link
              </Button>
              <Button variant="ghost" icon="RefreshCw" onClick={generate} loading={busy}>
                Regenerate
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-6 w-full" icon="Clapperboard" loading={busy} disabled={busy || orderingBusy} onClick={generate}>
            {busy ? "Generating walkthrough…" : "Generate walkthrough"}
          </Button>
        )}
      </div>
    </div>
  );
}
