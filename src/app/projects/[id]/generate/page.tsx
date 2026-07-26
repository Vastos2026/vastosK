"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { generateRoomImage } from "@/lib/design-plan-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GeneratingLoader } from "@/components/ui/generating-loader";
import { uid, cn } from "@/lib/utils";
import type { Room, RoomCard } from "@/lib/types";

/**
 * Room Generation Gallery (rebuilt) — one SECTION per room. Each section has
 * a hero card (the latest generation, or a loading/error state) and a
 * "Generate More" card beside it. The first generation for every room is
 * fired automatically from the Design page the moment Design Planning
 * finishes (see design/page.tsx's confirm()) — this page only ever reads
 * progress from the store, it never itself triggers a room's FIRST image.
 */
export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);
  const generatingIds = useVasto((s) => s.generatingRoomIds[id] ?? []);
  const startGenerating = useVasto((s) => s.startGenerating);
  const stopGenerating = useVasto((s) => s.stopGenerating);

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

  const generateMore = async (room: Room, note?: string) => {
    startGenerating(id, room.id);
    try {
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
    } finally {
      stopGenerating(id, room.id);
    }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
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
        <p className="mb-8 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Sizes can appear a little larger or smaller than expected — confirm with the sq ft
          figure for accuracy.
        </p>

        <div className="space-y-10">
          {rooms.map((room) => (
            <RoomSection
              key={room.id}
              room={room}
              card={cardOf(room.id)}
              generating={generatingIds.includes(room.id)}
              onGenerateMore={(note) => generateMore(room, note)}
              onRetryFirst={() => generateMore(room)}
              onView={() => router.push(`/projects/${id}/generate/${room.id}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomSection({
  room,
  card,
  generating,
  onGenerateMore,
  onRetryFirst,
  onView,
}: {
  room: Room;
  card?: RoomCard;
  generating: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
  onRetryFirst: () => Promise<void>;
  onView: () => void;
}) {
  const latest = card?.generations.at(-1);
  const failed = !latest && !generating;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-lg font-semibold tracking-tight">{room.name}</h3>
        <p className="text-xs text-muted">
          {Math.round(room.width)} × {Math.round(room.height)} ft
          {card && card.generations.length > 1 && ` · ${card.generations.length} versions`}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <HeroCard room={room} latest={latest} generating={generating && !latest} failed={failed} onRetry={onRetryFirst} onView={onView} />
        <GenerateMoreCard disabled={!latest} onGenerateMore={onGenerateMore} />
      </div>
    </section>
  );
}

function HeroCard({
  room,
  latest,
  generating,
  failed,
  onRetry,
  onView,
}: {
  room: Room;
  latest?: RoomCard["generations"][number];
  generating: boolean;
  failed: boolean;
  onRetry: () => Promise<void>;
  onView: () => void;
}) {
  return (
    <div className="hover-lift group relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-surface">
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
      ) : generating ? (
        <div className="absolute inset-0 grid place-items-center bg-grid">
          <div className="flex flex-col items-center gap-3">
            <GeneratingLoader />
            <p className="text-xs text-muted">Generating {room.name}…</p>
          </div>
        </div>
      ) : failed ? (
        <div className="absolute inset-0 grid place-items-center bg-grid">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <Icon name="CircleAlert" className="size-6 text-danger" />
            <p className="text-xs text-muted">Generation failed.</p>
            <Button size="sm" variant="outline" icon="RefreshCw" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GenerateMoreCard({
  disabled,
  onGenerateMore,
}: {
  disabled: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onGenerateMore(note.trim() || undefined);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "relative aspect-[4/3] overflow-hidden rounded-2xl border border-dashed border-border bg-surface/40 transition-opacity",
        disabled && "opacity-40",
      )}
    >
      {busy ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <GeneratingLoader />
            <p className="text-xs text-muted">Generating another version…</p>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
          <Icon name="RefreshCw" className="size-6 text-faint" />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            disabled={disabled}
            placeholder="Other requirements for this version, e.g. make it brighter"
            className="input w-full resize-none text-xs disabled:cursor-not-allowed"
          />
          {error && <p className="text-[11px] text-danger">{error}</p>}
          <Button size="sm" variant="outline" disabled={disabled} onClick={run}>
            Generate More
          </Button>
        </div>
      )}
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
