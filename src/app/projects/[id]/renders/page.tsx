"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject } from "@/lib/store";
import { STYLE_BY_ID, STYLES } from "@/lib/data";
import { RenderStatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, timeAgo } from "@/lib/utils";
import type { RenderJob } from "@/lib/types";

/** Views that are FRAMES of the one walkthrough clip — never regenerated alone. */
const WALKTHROUGH_VIEWS = new Set<RenderJob["view"]>(["left", "right", "back", "pano"]);

const VIEW_LABEL: Record<RenderJob["view"], string> = {
  corner: "Corner",
  "corner-back": "Back",
  front: "Front",
  side: "Side",
  left: "Left",
  right: "Right",
  back: "Back",
  top: "Top-down",
  pano: "Walkthrough",
};

/**
 * Combined render gallery — the "show as one" deliverable. Rendering happens
 * room-by-room in the Rooms step; here every render is grouped by its room so
 * the whole project reads as one set once each room is complete.
 */
export default function RendersPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  if (!project) return null;

  const style = STYLE_BY_ID[project.styleId ?? ""] ?? STYLES[0];
  const rooms = project.floorPlan?.rooms ?? [];
  const completed = project.renders.filter((r) => r.status === "completed").length;

  const roomGroups = rooms
    .map((room) => ({ room, renders: project.renders.filter((r) => r.roomId === room.id) }))
    .filter((g) => g.renders.length > 0);
  const roomless = project.renders.filter((r) => !r.roomId);

  // NOTE: there is deliberately no "retry" here. This gallery has no 3D scene, so
  // a retry could only ask the engine to invent the room from text — which
  // returned a DIFFERENT room for every view (the "each angle is a different
  // room" bug). A failed view is re-made where its real framing exists: the
  // room's 3D scene (front) or its walkthrough clip (left/right/back), so the
  // card links there instead of fabricating.

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Icon name="Image" className="size-4 text-accent" />
          <span className="font-medium">Renders</span>
          <span className="text-faint">·</span>
          <span className="text-muted">{completed} photos · {style.name}</span>
        </div>
        <Link href={`/projects/${id}/rooms`}>
          <Button variant="outline" icon="LayoutGrid">Render rooms</Button>
        </Link>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-6">
        {project.renders.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent">
                <Icon name="Camera" className="size-7" />
              </div>
              <h3 className="mt-4 text-lg font-medium">No renders yet</h3>
              <p className="mt-1 text-sm text-muted">
                Design and render each room — 4 photos per room — in the Rooms step.
              </p>
              <Link href={`/projects/${id}/rooms`}>
                <Button className="mt-5" icon="LayoutGrid">Go to Rooms</Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {roomGroups.map(({ room, renders }) => (
              <section key={room.id}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="size-3 rounded-sm" style={{ background: room.color }} />
                  <h3 className="text-sm font-semibold">{room.name}</h3>
                  <span className="text-xs text-faint">
                    {renders.filter((r) => r.status === "completed").length}/{renders.length} views
                  </span>
                  <Link
                    href={`/projects/${id}/rooms/${room.id}`}
                    className="ml-auto text-xs text-accent hover:underline"
                  >
                    Open room
                  </Link>
                </div>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  {renders.map((r) => (
                    <RenderCard key={r.id} projectId={id} render={r} roomId={room.id} />
                  ))}
                </div>
              </section>
            ))}

            {roomless.length > 0 && (
              <section>
                <h3 className="mb-3 text-sm font-semibold text-muted">Whole scene</h3>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  {roomless.map((r) => (
                    <RenderCard key={r.id} projectId={id} render={r} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RenderCard({
  projectId,
  render,
  roomId,
}: {
  projectId: string;
  render: RenderJob;
  /** the room this view belongs to — a failed view is re-made from its 3D scene */
  roomId?: string;
}) {
  const processing = render.status === "processing";
  const failed = render.status === "failed";
  const viewLabel = VIEW_LABEL[render.view] ?? render.view;
  const latest = render.versions.at(-1);
  const isVideo = !!latest?.imageUrl && latest.imageUrl.includes(".mp4");

  const body = (
    <div
      className={cn(
        "group animate-fade-up overflow-hidden rounded-2xl border border-border bg-surface transition-colors",
        !processing && !failed && "hover:border-border-strong",
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden border-b border-border bg-bg">
        {latest?.imageUrl && isVideo ? (
          <video
            src={latest.imageUrl}
            className="absolute inset-0 h-full w-full object-cover"
            muted
            loop
            autoPlay
            playsInline
          />
        ) : latest?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={latest.imageUrl}
            alt={`${viewLabel} render`}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="absolute inset-0 bg-grid" />
        )}

        <div className="absolute left-3 top-3">
          <RenderStatusBadge status={render.status} />
        </div>

        {processing && (
          <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-sm">
            <div className="text-center">
              <Icon name="Loader2" className="mx-auto mb-2 size-6 animate-spin text-accent" />
              <p className="text-xs text-muted">Rendering…</p>
            </div>
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 grid place-items-center bg-black/65 p-4 text-center">
            <div>
              <Icon name="CircleAlert" className="mx-auto mb-2 size-6 text-danger" />
              <p className="mx-auto max-w-[15rem] text-xs text-muted">{render.error}</p>
              {/* Re-make it where its real framing lives (the room's 3D scene /
                  walkthrough) — regenerating from here could only invent a
                  different room. */}
              {roomId && (
                <Link href={`/projects/${projectId}/rooms/${roomId}`}>
                  <Button size="sm" variant="outline" icon="ArrowRight" className="mt-3">
                    {WALKTHROUGH_VIEWS.has(render.view) ? "Re-run in room" : "Re-render in room"}
                  </Button>
                </Link>
              )}
              <p className="mx-auto mt-2 max-w-[15rem] text-[10px] text-faint">
                {WALKTHROUGH_VIEWS.has(render.view)
                  ? "Left / Right / Back are the walkthrough's grounded sides — re-run the walkthrough on the front render to remake them."
                  : "Views are rendered from the room's 3D framing."}
              </p>
            </div>
          </div>
        )}

        {!processing && !failed && (
          <div className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium backdrop-blur">
              <Icon name="Lasso" className="size-4 text-accent" /> Open & edit
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Icon name="Camera" className="size-3.5 text-muted" /> {viewLabel}
        </p>
        <p className="text-xs text-faint">{timeAgo(render.createdAt)}</p>
      </div>
    </div>
  );

  if (render.status !== "completed") return body;
  return <Link href={`/projects/${projectId}/renders/${render.id}`}>{body}</Link>;
}
