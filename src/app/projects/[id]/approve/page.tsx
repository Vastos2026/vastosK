"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RetryImg } from "@/components/ui/retry-img";
import { cn } from "@/lib/utils";

/**
 * Final Image Selection (revamp Workstream 8.5, flow step 10) — one approved
 * version per room, plus include/exclude for the walkthrough.
 */
export default function ApprovePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setApproved = useVasto((s) => s.setApproved);
  const setIncluded = useVasto((s) => s.setIncluded);

  // "Build walkthrough" below is a router.push, not a <Link>, so it isn't
  // covered by Next's automatic viewport prefetch. It's the only route this
  // page ever navigates forward to.
  useEffect(() => {
    router.prefetch(`/projects/${id}/walkthrough`);
  }, [router, id]);

  if (!project) return null;
  const rooms = project.floorPlan?.rooms ?? [];

  if (rooms.length === 0 || project.roomCards.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="ListChecks" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">Generate at least one room image first.</p>
          <Link href={`/projects/${id}/generate`}>
            <Button className="mt-4" variant="outline">Go to Generate</Button>
          </Link>
        </div>
      </div>
    );
  }

  const includedReady = rooms.every((r) => {
    const card = project.roomCards.find((c) => c.roomId === r.id);
    return !card || !card.included || !!card.approvedId;
  });
  const anyIncluded = rooms.some((r) => project.roomCards.find((c) => c.roomId === r.id)?.included);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Approve</h2>
            <p className="mt-1 text-sm text-muted">Pick one final image per room for the walkthrough.</p>
          </div>
          <Button
            iconRight="ArrowRight"
            disabled={!includedReady || !anyIncluded}
            onClick={() => router.push(`/projects/${id}/walkthrough`)}
          >
            Build walkthrough
          </Button>
        </div>

        <div className="space-y-6">
          {rooms.map((room) => {
            const card = project.roomCards.find((c) => c.roomId === room.id);
            if (!card || card.generations.length === 0) {
              return (
                <div key={room.id} className="rounded-2xl border border-dashed border-border p-4 text-sm text-faint">
                  {room.name}. Not generated yet.
                </div>
              );
            }
            return (
              <div key={room.id} className="rounded-2xl border border-border bg-surface p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 rounded-sm" style={{ background: room.color }} />
                    <h3 className="font-medium">{room.name}</h3>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={card.included}
                      onChange={(e) => setIncluded(id, room.id, e.target.checked)}
                      className="cursor-pointer"
                    />
                    Include in walkthrough
                  </label>
                </div>
                <div className="flex flex-wrap gap-3">
                  {card.generations.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => setApproved(id, room.id, g.id)}
                      className={cn(
                        "hover-lift relative h-24 w-32 shrink-0 overflow-hidden rounded-xl border-2 cursor-pointer",
                        g.id === card.approvedId
                          ? "border-accent"
                          : "border-transparent opacity-75 hover:opacity-100",
                      )}
                    >
                      <RetryImg src={g.imageUrl} alt="" className="h-full w-full object-cover" />
                      {g.id === card.approvedId && (
                        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-accent text-accent-foreground">
                          <Icon name="Check" className="size-3" />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
