"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { RetryImg } from "@/components/ui/retry-img";
import { formatDimensionsRounded } from "@/lib/units";
import type { Room } from "@/lib/types";

/**
 * Mirrors the queue slot this room's `enqueueGreyboxRender(() =>
 * ensureGreybox(...))` call is in — driven by the gallery page, not derived
 * locally, since only the page knows the queue's per-room outcome.
 * "unavailable" covers both `ensureGreybox` returning `undefined` (no
 * dimensions to render from) and a render/upload throwing — same fail-closed
 * empty state either way, matching furnish/[roomId]/page.tsx's own
 * readiness gate.
 */
export type FurnishCardStatus = "pending" | "ready" | "unavailable";

/**
 * One room's card in the Furnish gallery (Task 16). Whichever of `status`'s
 * three states applies decides the whole card's shape: "unavailable" routes
 * to Room Confirmation instead of the furniture editor (there's nothing to
 * furnish yet), the other two states route to `/furnish/<roomId>`. Kept as a
 * single interactive element per state (never a link nested inside the
 * card's own button) — the red violations badge is a separate, absolutely
 * positioned sibling on top, not nested either.
 */
export function FurnishRoomCard({
  projectId,
  room,
  status,
  hasOpeningViolation,
}: {
  projectId: string;
  room: Room;
  status: FurnishCardStatus;
  hasOpeningViolation: boolean;
}) {
  const router = useRouter();
  const pieces = room.furniture?.length ?? 0;

  const body = (
    <>
      <div className="aspect-video overflow-hidden bg-grid">
        {status === "ready" && room.greyboxKey ? (
          <RetryImg
            src={`/api/render?key=${encodeURIComponent(room.greyboxKey)}`}
            alt={room.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : status === "pending" ? (
          <div className="h-full w-full animate-pulse bg-surface-2" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center">
            <Icon name="Ruler" className="size-5 text-faint" />
            <p className="text-[11px] text-muted">Add dimensions in Room Confirmation</p>
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-foreground">{room.name}</p>
        <p className="mt-0.5 text-xs text-muted">{formatDimensionsRounded(room.width, room.height)}</p>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          {pieces > 0 ? (
            <>
              <span className="inline-block size-1.5 shrink-0 rounded-full bg-accent" />
              {pieces} {pieces === 1 ? "piece" : "pieces"}
            </>
          ) : (
            "Empty"
          )}
        </p>
      </div>
    </>
  );

  return (
    <div className="hover-lift group relative overflow-hidden rounded-2xl border border-border bg-surface">
      {status === "unavailable" ? (
        // Nothing renderable for this room yet (ensureGreybox came back
        // undefined, or threw) — send the whole card straight to the fix
        // rather than into an editor that can't do anything for it.
        <Link href={`/projects/${projectId}/review`} className="block w-full text-left">
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => router.push(`/projects/${projectId}/furnish/${room.id}`)}
          className="block w-full cursor-pointer text-left"
        >
          {body}
        </button>
      )}

      {/* A warning, not a blocker. The editor used to refuse to open a room
          with an opening violation; it no longer does (see that page's own
          comment on validateOpenings), so this badge reads as advisory and
          keeps its shortcut to the place the geometry can actually be fixed. */}
      {hasOpeningViolation && (
        <Link
          href={`/projects/${projectId}/plan`}
          className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm hover:bg-warning/90"
          title="Some doors or windows here may not render accurately. You can still furnish and generate this room."
        >
          <Icon name="CircleAlert" className="size-3" />
          Check openings
        </Link>
      )}
    </div>
  );
}
