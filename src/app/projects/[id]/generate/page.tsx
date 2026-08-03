"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { RetryImg } from "@/components/ui/retry-img";
import { generateRoomImage } from "@/lib/design-plan-client";
import { ensureGreybox } from "@/lib/greybox/ensure-greybox-key";
import { describeFurnitureForPrompt } from "@/lib/greybox/furniture-layout";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { formatDimensionsRounded } from "@/lib/units";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GeneratingProgressRing } from "@/components/ui/generating-progress-ring";
import { Badge } from "@/components/ui/badge";
import { RoomNavRail } from "@/components/project/room-nav-rail";
import { uid, cn, slugifyRoomName } from "@/lib/utils";
import type { Room, RoomCard, RoomGeneration } from "@/lib/types";

// Stable reference for the "no rooms generating" case — `?? []` in the
// selector below would otherwise allocate a NEW array every call, which
// breaks Zustand's useSyncExternalStore-based subscription (React requires a
// selector's result to be referentially stable across calls with the same
// state) and causes "getServerSnapshot should be cached to avoid an infinite
// loop" / "Maximum update depth exceeded".
const NO_GENERATING_IDS: string[] = [];

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
  const updateRoom = useVasto((s) => s.updateRoom);
  const generatingIds = useVasto((s) => s.generatingRoomIds[id] ?? NO_GENERATING_IDS);
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
  const generatedCount = rooms.filter((r) => (cardOf(r.id)?.generations.length ?? 0) > 0).length;

  const generateMore = async (room: Room, note?: string) => {
    startGenerating(id, room.id);
    try {
      // Renders + uploads a fresh greybox only when the room's content hash
      // has changed since the last cached one (see ensure-greybox-key.ts), so
      // "Generate More" doesn't re-render on every call but still picks up an
      // edited door/window from the Plan editor. Falling back to the
      // text-only openings clause now only happens if the render/upload call
      // itself fails (caught below) — a room never placed in the Plan editor
      // still gets a real greybox, with seeded opening positions and the
      // layout default box size when its own dimensions are unknown.
      const gb = await ensureGreybox(id, room).catch((e) => {
        console.warn(
          `[generate] greybox render/upload failed for "${room.name}", falling back to text-only:`,
          e instanceof Error ? e.message : e,
        );
        return undefined;
      });
      if (gb) updateRoom(id, room.id, gb);
      const greyboxKey = gb?.greyboxKey;

      // Omit size entirely when a dimension is still missing, rather than
      // sending a literal "undefined x undefined ft" into the render
      // prompt — see Room.width/height's doc comment. Same helper
      // buildUniversalInput/design page's auto-fire loop use, so every
      // room-image payload describes size identically.
      const size = formatRoomSize(room.width, room.height);
      const gen = await generateRoomImage({
        projectId: id,
        universalInput,
        room: {
          name: room.name,
          type: room.type,
          ...(size ? { size } : {}),
          additional_notes: [universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes, note]
            .filter(Boolean)
            .join(". ") || undefined,
          openings: room.openings,
          furniture: room.furniture?.length ? describeFurnitureForPrompt(room.furniture) : undefined,
        },
        designSpec,
        greyboxKey,
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
            <div className="flex items-center gap-2.5">
              <h2 className="text-2xl font-bold tracking-tight">Generate</h2>
              <Badge icon="ImagePlus" className={cn(generatedCount === rooms.length && "border-success/30 bg-success/10 text-success")}>
                {generatedCount}/{rooms.length} rooms
              </Badge>
            </div>
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
          Sizes can appear a little larger or smaller than expected. Confirm with the sq ft
          figure for accuracy.
        </p>

        <div className="divide-y divide-border">
          {rooms.map((room) => (
            <RoomSection
              key={room.id}
              room={room}
              card={cardOf(room.id)}
              generating={generatingIds.includes(room.id)}
              onGenerateMore={(note) => generateMore(room, note)}
              onRetryFirst={() => generateMore(room)}
              onView={() => router.push(`/projects/${id}/generate/${room.id}`)}
              onFurnish={room.shape ? () => router.push(`/projects/${id}/furnish/${room.id}`) : undefined}
            />
          ))}
        </div>
      </div>
      <RoomNavRail rooms={rooms} />
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
  onFurnish,
}: {
  room: Room;
  card?: RoomCard;
  generating: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
  onRetryFirst: () => Promise<void>;
  onView: () => void;
  /** Only set when this room has a Plan Editor shape — furnishing needs a real footprint to place items in. */
  onFurnish?: () => void;
}) {
  const generations = card?.generations ?? [];
  const latest = generations.at(-1);
  // Older versions, most-recent-of-the-rest first, so the grid reads newest→oldest.
  const olderVersions = generations.slice(0, -1).reverse();
  const failed = !latest && !generating;

  return (
    <section id={`room-${room.id}`} className="scroll-mt-4 pt-6 first:pt-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold tracking-tight">{room.name}</h3>
          {onFurnish && (
            <Button size="sm" icon="Sofa" onClick={onFurnish}>
              Adjust with 3D
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">{formatDimensionsRounded(room.width, room.height)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <HeroCard
          room={room}
          latest={latest}
          showLatestTag={generations.length > 1}
          generating={generating && !latest}
          failed={failed}
          onRetry={onRetryFirst}
          onView={onView}
        />
        {olderVersions.map((gen, idx) => (
          <VersionThumb
            key={gen.id}
            room={room}
            generation={gen}
            version={generations.length - 1 - idx}
            onView={onView}
          />
        ))}
        <GenerateMoreCard disabled={!latest} onGenerateMore={onGenerateMore} />
      </div>
    </section>
  );
}

function HeroCard({
  room,
  latest,
  showLatestTag,
  generating,
  failed,
  onRetry,
  onView,
}: {
  room: Room;
  latest?: RoomCard["generations"][number];
  showLatestTag: boolean;
  generating: boolean;
  failed: boolean;
  onRetry: () => Promise<void>;
  onView: () => void;
}) {
  return (
    <div className="hover-lift group relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-surface">
      {latest ? (
        <>
          <RetryImg
            src={latest.imageUrl}
            alt={room.name}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          {showLatestTag && (
            <span className="absolute left-2 top-2 z-10 rounded-md border border-white/10 bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-foreground/90 backdrop-blur-sm">
              Latest
            </span>
          )}
          <a
            href={latest.imageUrl}
            download={`${slugifyRoomName(room.name)}.png`}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2 top-2 z-20 grid size-7 place-items-center rounded-md border border-white/10 bg-black/70 text-foreground/90 backdrop-blur-sm transition hover:bg-black/90 cursor-pointer"
            aria-label="Save image to your device"
            title="Save image"
          >
            <Icon name="Download" className="size-3.5" />
          </a>
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
            <GeneratingProgressRing active={generating} estimatedMs={15000} />
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

function VersionThumb({
  room,
  generation,
  version,
  onView,
}: {
  room: Room;
  generation: RoomGeneration;
  version: number;
  onView: () => void;
}) {
  return (
    <div className="hover-lift group relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-surface">
      <button type="button" onClick={onView} className="absolute inset-0 cursor-pointer">
        <RetryImg
          src={generation.imageUrl}
          alt={`${room.name} version`}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.05]"
        />
        <div className="absolute inset-0 bg-black/30 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      </button>
      <span className="absolute left-2 top-2 z-10 rounded-md border border-white/10 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted backdrop-blur-sm">
        v{version}
      </span>
      <a
        href={generation.imageUrl}
        download={`${slugifyRoomName(room.name)}-v${version}.png`}
        className="absolute right-2 top-2 z-20 grid size-7 place-items-center rounded-md border border-white/10 bg-black/60 text-muted backdrop-blur-sm transition hover:bg-black/90 hover:text-foreground cursor-pointer"
        aria-label="Save image to your device"
        title="Save image"
      >
        <Icon name="Download" className="size-3.5" />
      </a>
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
            <GeneratingProgressRing active={busy} estimatedMs={15000} />
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
    <div className="bg-grid grid h-full place-items-center text-center">
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
