"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject } from "@/lib/store";
import { STYLE_BY_ID, STYLES } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RenderStatusBadge } from "@/components/ui/badge";

/**
 * Room-by-room flow (workflow): list every room in the plan so the user can
 * open each one and design + render its interior individually, under the one
 * house style.
 */
export default function RoomsPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  if (!project) return null;

  const style = STYLE_BY_ID[project.styleId ?? ""] ?? STYLES[0];
  const rooms = project.floorPlan?.rooms ?? [];

  if (!project.floorPlan || rooms.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="LayoutGrid" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">Parse a floor plan first to design its rooms.</p>
          <Link href={`/projects/${id}/upload`}>
            <Button className="mt-4" variant="outline" icon="Upload">Go to upload</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Icon name="LayoutGrid" className="size-4 text-accent" />
          <span className="font-medium">Rooms · {rooms.length}</span>
          <span className="text-faint">·</span>
          <span className="text-muted">Design & render each room — {style.name}</span>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => {
            const items = project.placedItems.filter((it) => it.roomId === room.id && !it.ghost);
            const roomRenders = project.renders.filter((r) => r.roomId === room.id);
            const latest = roomRenders[0];
            const thumb = latest?.versions.at(-1)?.imageUrl;
            return (
              <Link
                key={room.id}
                href={`/projects/${id}/rooms/${room.id}`}
                className="group animate-fade-up overflow-hidden rounded-2xl border border-border bg-surface transition-colors hover:border-border-strong"
              >
                <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-grid bg-bg">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={`${room.name} render`}
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center">
                      <span className="flex flex-col items-center gap-2 text-faint">
                        <span
                          className="size-10 rounded-lg"
                          style={{ background: room.color, opacity: 0.5 }}
                        />
                        <span className="text-xs">No render yet</span>
                      </span>
                    </div>
                  )}
                  {latest && (
                    <div className="absolute left-3 top-3">
                      <RenderStatusBadge status={latest.status} />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 p-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{room.name}</p>
                    <p className="text-xs text-muted">
                      {Math.round(room.width)} × {Math.round(room.height)} ft · {items.length} items
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-accent opacity-0 transition-opacity group-hover:opacity-100">
                    Design <Icon name="ArrowRight" className="size-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
