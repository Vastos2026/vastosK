"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { generateRoomImage } from "@/lib/design-plan-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { uid } from "@/lib/utils";
import type { Room, RoomCard } from "@/lib/types";

/**
 * Room Generation Gallery (revamp Workstream 8.5, flow step 8) — replaces the
 * deleted 3D-workspace page. One card per confirmed room: Generate, Generate
 * More (its own "Other requirements" note), View/Edit. No furniture catalog,
 * no reference images, no per-room style, no 3D scene — the design language
 * comes entirely from the cached Design Specification.
 */
export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);

  if (!project) return null;

  const rooms = project.floorPlan?.rooms ?? [];

  if (!project.floorPlan || rooms.length === 0) {
    return (
      <EmptyState
        icon="Ruler"
        text="Confirm your rooms first."
        href={`/projects/${id}/review`}
        cta="Go to Room Confirmation"
      />
    );
  }
  if (!project.universalInput || !project.designSpec) {
    return (
      <EmptyState
        icon="Palette"
        text="Plan the design first."
        href={`/projects/${id}/design`}
        cta="Go to Design"
      />
    );
  }

  const universalInput = project.universalInput;
  const designSpec = project.designSpec;
  const cardOf = (roomId: string) => project.roomCards.find((c) => c.roomId === roomId);
  const allHaveImages = rooms.every((r) => (cardOf(r.id)?.generations.length ?? 0) > 0);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Generate</h2>
            <p className="mt-1 text-sm text-muted">
              One image per room, same design language throughout.
            </p>
          </div>
          <Link href={`/projects/${id}/approve`}>
            <Button iconRight="ArrowRight" disabled={!allHaveImages}>
              Continue to Approval
            </Button>
          </Link>
        </div>
        <p className="mb-6 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Sizes can appear a little larger or smaller than expected — confirm with the sq ft
          figure for accuracy.
        </p>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => (
            <RoomCardTile
              key={room.id}
              room={room}
              card={cardOf(room.id)}
              onGenerate={async (note) => {
                const gen = await generateRoomImage({
                  projectId: id,
                  universalInput,
                  room: {
                    name: room.name,
                    size: `${room.width} x ${room.height} ft`,
                    additional_notes: [universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes, note]
                      .filter(Boolean)
                      .join(". ") || undefined,
                    openings: room.openings,
                  },
                  designSpec,
                });
                addGeneration(id, room.id, {
                  id: uid("gen"),
                  createdAt: new Date().toISOString(),
                  imageUrl: gen.imageUrl,
                  imageKey: gen.key,
                  prompt: gen.prompt,
                  note,
                });
              }}
              onView={() => router.push(`/projects/${id}/generate/${room.id}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomCardTile({
  room,
  card,
  onGenerate,
  onView,
}: {
  room: Room;
  card?: RoomCard;
  onGenerate: (note?: string) => Promise<void>;
  onView: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreNote, setMoreNote] = useState("");
  const [showMore, setShowMore] = useState(false);

  const latest = card?.generations.at(-1);

  const run = async (note?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onGenerate(note);
      setShowMore(false);
      setMoreNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hover-lift group overflow-hidden rounded-2xl border border-border bg-surface transition-colors">
      <div className="relative aspect-[4/3] overflow-hidden border-b border-border bg-grid bg-bg">
        {latest ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={latest.imageUrl}
              alt={room.name}
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
            <button
              onClick={onView}
              className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-all duration-200 hover:bg-black/50 group-hover:opacity-100 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium backdrop-blur">
                <Icon name="Eye" className="size-4 text-accent" /> Tap to View or Edit
              </span>
            </button>
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            {busy ? (
              <Icon name="Loader2" className="size-6 animate-spin text-accent" />
            ) : (
              <span className="size-10 rounded-lg" style={{ background: room.color, opacity: 0.4 }} />
            )}
          </div>
        )}
      </div>

      <div className="p-3.5">
        <p className="truncate text-sm font-medium">{room.name}</p>
        <p className="mt-0.5 text-xs text-muted">
          {Math.round(room.width)} × {Math.round(room.height)} ft
          {card && card.generations.length > 1 && ` · ${card.generations.length} versions`}
        </p>

        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

        {!latest ? (
          <Button className="mt-3 w-full" size="sm" icon="Sparkles" loading={busy} onClick={() => run()}>
            Generate
          </Button>
        ) : showMore ? (
          <div className="mt-3 space-y-2">
            <textarea
              value={moreNote}
              onChange={(e) => setMoreNote(e.target.value)}
              rows={2}
              placeholder="Other requirements for this version, e.g. make it brighter"
              className="input w-full resize-none text-xs"
              autoFocus
            />
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="flex-1" onClick={() => setShowMore(false)}>
                Cancel
              </Button>
              <Button size="sm" className="flex-1" loading={busy} onClick={() => run(moreNote.trim() || undefined)}>
                Generate
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" icon="RefreshCw" className="flex-1" onClick={() => setShowMore(true)}>
              Generate More
            </Button>
            <Button size="sm" variant="outline" icon="Pencil" className="flex-1" onClick={onView}>
              Edit
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ icon, text, href, cta }: { icon: string; text: string; href: string; cta: string }) {
  return (
    <div className="grid h-full place-items-center text-center">
      <div>
        <Icon name={icon} className="mx-auto size-8 text-faint" />
        <p className="mt-3 text-sm text-muted">{text}</p>
        <Link href={href}>
          <Button className="mt-4" variant="outline">{cta}</Button>
        </Link>
      </div>
    </div>
  );
}
