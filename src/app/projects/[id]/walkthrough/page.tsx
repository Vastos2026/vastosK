"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { categoryForPropertyType, getProjectTypeConfig, orderRoomsForWalkthrough } from "@/lib/project-types/config";
import { generateWalkthrough, orderRoomsWithAI } from "@/lib/generation-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GeneratingProgressRing } from "@/components/ui/generating-progress-ring";
import { useAsyncFeedback } from "@/hooks/use-async-feedback";
import { useShareToken } from "@/hooks/use-share-token";
import { useExportProjectPdf } from "@/hooks/use-export-project-pdf";
import { RoomReorderModal, type ReorderableRoom } from "@/components/project/room-reorder-modal";
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
  const [reorderOpen, setReorderOpen] = useState(false);
  const share = useAsyncFeedback();
  const { ensureShareToken } = useShareToken(project);
  const pdfExport = useExportProjectPdf(project);

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
    const remaining = [...included];
    const ordered: Room[] = [];

    for (const name of orderedNames) {
      const index = remaining.findIndex((r) => (r.type || r.name) === name);
      if (index !== -1) {
        ordered.push(remaining.splice(index, 1)[0]);
      } else if (remaining.length > 0) {
        ordered.push(remaining.shift()!);
      }
    }

    return [...ordered, ...remaining];
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

  // These room-count guards only block getting to a NEW walkthrough — if one
  // already completed, its video/download/share/PDF/regenerate stay reachable
  // even if the room selection later drops below 2 (e.g. a room got
  // unchecked on Approve, or deleted). Without this exception, the page hid
  // an already-generated video with no way back to it from here (found in
  // review) — the video itself is untouched in storage, only this page's
  // access to it was broken.
  const hasCompletedWalkthrough = project.walkthrough?.status === "completed";

  if (included.length === 0 && !hasCompletedWalkthrough) {
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

  if (included.length === 1 && !hasCompletedWalkthrough) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="Clapperboard" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">Add at least 2 approved rooms to build a walkthrough.</p>
          <Link href={`/projects/${id}/approve`}>
            <Button className="mt-4" variant="outline">Go to Approve</Button>
          </Link>
        </div>
      </div>
    );
  }

  const generate = async () => {
    // The page's early-return guards above only block reaching a NEW
    // walkthrough with fewer than 2 rooms — they let an already-completed
    // walkthrough's Regenerate button stay reachable regardless of the
    // CURRENT room count. Re-check the minimum here too, so Regenerate can't
    // silently produce a 1-room walkthrough if the room selection dropped
    // below 2 after the original walkthrough was generated.
    if (busy || effectiveOrder.length < 2) {
      if (effectiveOrder.length < 2) setError("Add at least 2 approved rooms to build a walkthrough.");
      return;
    }
    setBusy(true);
    setError(null);
    // shareToken carries over across every state write below, not just the
    // completed one — it's only ever minted via getShareLink() (on demand),
    // and a regenerate/failure shouldn't invalidate a link already shared
    // with the client. Captured once, up front: setWalkthrough fully
    // replaces the walkthrough object (no merge with the previous value), so
    // any write that omits it would silently drop an already-shared token
    // even on a transient "processing"/"failed" state, not just on success.
    const shareToken = project.walkthrough?.shareToken;
    const roomOrder = effectiveOrder.map((r) => r.id);
    setWalkthrough(id, { status: "processing", createdAt: new Date().toISOString(), shareToken, roomOrder });
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
        shareToken,
        roomOrder,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Walkthrough generation failed";
      setError(msg);
      setWalkthrough(id, { status: "failed", createdAt: new Date().toISOString(), shareToken, roomOrder, error: msg });
    } finally {
      setBusy(false);
    }
  };

  const wt = project.walkthrough;

  const getShareLink = () =>
    share.run(async () => {
      if (!wt) return;
      const { token, persisted } = await ensureShareToken(wt);
      if (!token) return "Couldn't create a share link";

      await navigator.clipboard.writeText(`${window.location.origin}/s/${token}`);
      return persisted ? "Link copied" : "Link copied (saved on this device for now)";
    });

  // One Veo clip per room is the dominant cost — a flat floor plus a per-room
  // increment approximates it well enough for a progress ring, without
  // needing the server to report real progress.
  const walkthroughEstimatedMs = Math.max(30000, effectiveOrder.length * 20000);

  const reorderItems: ReorderableRoom[] = effectiveOrder.map((room) => {
    const card = project.roomCards.find((c) => c.roomId === room.id);
    const approved = card?.generations.find((g) => g.id === card.approvedId);
    return { room, imageUrl: approved?.imageUrl };
  });

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Walkthrough</h2>
            <p className="mt-1 text-sm text-muted">
              One 3-second cinematic zoom per room, stitched in this order.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            icon="GripVertical"
            onClick={() => setReorderOpen(true)}
            disabled={orderingBusy}
          >
            Reorder rooms
          </Button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Sizes can appear a little larger or smaller than expected. Confirm with the sq ft
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
              </div>
            ))
          )}
        </div>

        <RoomReorderModal
          open={reorderOpen}
          onClose={() => setReorderOpen(false)}
          items={reorderItems}
          onConfirm={(next) => setOrder(next)}
        />

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {wt?.status === "completed" && wt.videoUrl ? (
          <div className="mt-6">
            {busy ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface p-8">
                <GeneratingProgressRing active={busy} estimatedMs={walkthroughEstimatedMs} />
                <p className="text-xs text-muted">Regenerating walkthrough…</p>
              </div>
            ) : (
              <video src={wt.videoUrl} controls className="w-full rounded-2xl border border-border" />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={wt.videoUrl} download>
                <Button variant="outline" icon="Download" disabled={busy}>Download</Button>
              </a>
              <Button variant="outline" icon="Copy" onClick={getShareLink} loading={share.busy} disabled={busy}>
                Get shareable link
              </Button>
              <Button variant="outline" icon="FileUp" onClick={pdfExport.exportPdf} loading={pdfExport.busy} disabled={busy}>
                Export PDF
              </Button>
              <Button variant="ghost" icon="RefreshCw" onClick={generate} loading={busy}>
                Regenerate
              </Button>
            </div>
            {share.feedback && (
              <p className="mt-2 text-xs text-muted">{share.feedback}</p>
            )}
            {pdfExport.feedback && (
              <p className="mt-2 text-xs text-muted">{pdfExport.feedback}</p>
            )}
          </div>
        ) : busy ? (
          <div className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface p-8">
            <GeneratingProgressRing active={busy} estimatedMs={walkthroughEstimatedMs} />
            <p className="text-xs text-muted">Generating walkthrough…</p>
          </div>
        ) : (
          <Button className="mt-6 w-full" icon="Clapperboard" disabled={orderingBusy} onClick={generate}>
            Generate walkthrough
          </Button>
        )}
      </div>
    </div>
  );
}
