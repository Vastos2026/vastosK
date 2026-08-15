"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { RetryImg } from "@/components/ui/retry-img";
import { generateRoomImage } from "@/lib/design-plan-client";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { formatDimensionsRounded } from "@/lib/units";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { GeneratingProgressRing } from "@/components/ui/generating-progress-ring";
import { Badge } from "@/components/ui/badge";
import { RoomNavRail } from "@/components/project/room-nav-rail";
import { FloorPlanSidePanel } from "@/components/project/floor-plan-side-panel";
import { uid, cn, slugifyRoomName } from "@/lib/utils";
import type { Room, RoomCard, RoomGeneration } from "@/lib/types";
import { roomSpecFor } from "@/lib/greybox/room-spec";

// Stable reference for the "no rooms generating" case — `?? {}` in the
// selector below would otherwise allocate a NEW object every call, which
// breaks Zustand's useSyncExternalStore-based subscription (React requires a
// selector's result to be referentially stable across calls with the same
// state) and causes "getServerSnapshot should be cached to avoid an infinite
// loop" / "Maximum update depth exceeded".
const NO_GENERATING_COUNTS: Record<string, number> = {};

/**
 * Room Generation Gallery (rebuilt) — one SECTION per room. Each section is a
 * single horizontally-scrollable strip of equal-size generation tiles,
 * oldest→newest left→right (newest rightmost, so a fresh generation lands
 * beside the one it's meant to be compared against), plus a "Generate More"
 * tile at the end. The first generation for every room is fired automatically
 * from the Design page the moment Design Planning finishes (see
 * design/page.tsx's confirm()) — this page only ever reads progress from the
 * store, it never itself triggers a room's FIRST image.
 */
export default function GeneratePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);
  const updateRoom = useVasto((s) => s.updateRoom);
  const generatingCounts = useVasto((s) => s.generatingRoomIds[id] ?? NO_GENERATING_COUNTS);
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

  // No greybox anywhere on this project — see Project.planSkipped. Drives
  // both the missing "Adjust with 3D" button and the text-only generation
  // path below, off the one flag, so the button can't offer an editor the
  // generation never uses.
  const planSkipped = !!project.planSkipped;

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
      //
      // PERF: dynamically imported (was a static top-level import) — the
      // greybox module pulls in three.js transitively (render-mask.ts ->
      // three), which was measured at ~570KB of extra First Load JS on this
      // route (route-bundle-stats.json: 1400.9KB here vs. ~840KB baseline on
      // routes that never touch greybox). This call only ever runs inside a
      // user-triggered "Generate More" click, never during initial render, so
      // deferring the import to here keeps three.js out of this route's
      // initial bundle without changing when or how ensureGreybox runs.
      //
      // Skipped entirely on a plan-skipped project (same rule as
      // design/page.tsx's auto-fire loop): no room geometry was ever placed,
      // so there is nothing to render, and the three.js module never even
      // loads. The greybox FIELDS below are gated on the same flag rather
      // than just on `gb` being undefined, because a room can still carry a
      // greyboxKey persisted before the skip, and the server keys
      // `hasGreybox` off that key.
      const gb = planSkipped
        ? undefined
        : await (await import("@/lib/greybox/ensure-greybox-key")).ensureGreybox(id, room).catch((e) => {
            console.warn(
              `[generate] greybox render/upload failed for "${room.name}", falling back to text-only:`,
              e instanceof Error ? e.message : e,
            );
            return undefined;
          });
      // Never spread the whole ensureGreybox result into the store —
      // `projected` is derived fresh on every call (see GreyboxResult's own
      // doc comment) and is not one of Room's persisted fields. Only the
      // four real fields go to updateRoom; gb.projected/etc. stay in local
      // scope for the generateRoomImage call below — matches design/page.tsx's
      // auto-fire loop exactly.
      if (gb) {
        updateRoom(id, room.id, {
          greyboxKey: gb.greyboxKey,
          greyboxMaskKey: gb.greyboxMaskKey,
          greyboxHash: gb.greyboxHash,
          greyboxLedger: gb.greyboxLedger,
        });
      }

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
        },
        designSpec,
        greyboxKey: gb?.greyboxKey,
        greyboxMaskKey: gb?.greyboxMaskKey,
        projected: gb?.projected,
        furniture: planSkipped ? undefined : room.furniture,
        // See design/page.tsx: identifies each grey box in the prompt.
        roomSpec: planSkipped ? undefined : roomSpecFor(room),
        greyboxAnnotatedKey: gb?.greyboxAnnotatedKey,
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
      {/* Same responsive split as furnish/page.tsx's FloorPlanSidePanel
          integration: stacked (panel above content) below xl, side-by-side
          from xl up, with the content column keeping its original
          mx-auto max-w-5xl so the generation strips' sizing is unchanged
          either way. RoomNavRail stays a viewport-fixed overlay outside this
          row, so it's untouched by the extra flex wrapper. */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 xl:flex-row xl:items-start">
        <FloorPlanSidePanel plan={project.floorPlan} />
        <div className="mx-auto min-w-0 max-w-5xl flex-1">
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
                generatingCount={generatingCounts[room.id] ?? 0}
                onGenerateMore={(note) => generateMore(room, note)}
                onRetryFirst={() => generateMore(room)}
                onView={(genId) =>
                  router.push(`/projects/${id}/generate/${room.id}${genId ? `?v=${genId}` : ""}`)
                }
                onFurnish={
                  planSkipped ? undefined : () => router.push(`/projects/${id}/furnish/${room.id}?from=generate`)
                }
              />
            ))}
          </div>
        </div>
      </div>
      <RoomNavRail rooms={rooms} />
    </div>
  );
}

function RoomSection({
  room,
  card,
  generatingCount,
  onGenerateMore,
  onRetryFirst,
  onView,
  onFurnish,
}: {
  room: Room;
  card?: RoomCard;
  generatingCount: number;
  onGenerateMore: (note?: string) => Promise<void>;
  onRetryFirst: () => Promise<void>;
  onView: (genId?: string) => void;
  /** Absent on a plan-skipped project, where there is no 3D editor to adjust — see Project.planSkipped. */
  onFurnish?: () => void;
}) {
  const generations = card?.generations ?? [];
  const failed = generations.length === 0 && generatingCount === 0;
  const stripRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest tile on arrival, again after every new
  // generation lands, and again the moment a fresh one starts (generatingCount
  // ticking up) — a generation kicked off from "Adjust with 3D" or a second
  // Generate More click needs its placeholder tile to scroll into view too,
  // not just the completed image that eventually replaces it.
  useEffect(() => {
    stripRef.current?.scrollTo({ left: stripRef.current.scrollWidth, behavior: "smooth" });
  }, [generations.length, generatingCount]);

  return (
    <section id={`room-${room.id}`} className="scroll-mt-4 pt-6 first:pt-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold tracking-tight">{room.name}</h3>
          {/* No longer disabled while a generation is in flight — rooms can
              now run several generations at once (see generatingRoomIds'
              doc comment in store.ts), so there's nothing left to wait for.
              Not rendered at all on a plan-skipped project: the 3D editor it
              opens refuses to load there, and a button that leads to a dead
              end is worse than no button. */}
          {onFurnish && (
            <Button size="sm" icon="Sofa" onClick={onFurnish}>
              Adjust with 3D
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">{formatDimensionsRounded(room.width, room.height)}</p>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2" ref={stripRef}>
        {failed ? (
          <GenerationTile room={room} version={1} isLatest failed onRetry={onRetryFirst} />
        ) : (
          <>
            {generations.map((gen, i) => (
              <GenerationTile
                key={gen.id}
                room={room}
                gen={gen}
                version={i + 1}
                isLatest={i === generations.length - 1}
                onOpen={() => onView(gen.id)}
              />
            ))}
            {/* One placeholder tile per generation currently running for this
                room. Generate More used to swap its whole card for a spinner
                (blocking a second click); now the in-flight state lives here
                instead, so any number of these can appear alongside the
                Generate More card at once. */}
            {Array.from({ length: generatingCount }, (_, i) => (
              <GenerationTile
                key={`generating-${i}`}
                room={room}
                version={generations.length + i + 1}
                isLatest
                generating
              />
            ))}
          </>
        )}
        <GenerateMoreCard disabled={generations.length === 0} onGenerateMore={onGenerateMore} />
      </div>
    </section>
  );
}

/**
 * One tile in a room's generation strip — covers what the old `HeroCard` +
 * `VersionThumb` pair did together. `gen` is omitted only for the "nothing
 * generated for this room yet" placeholder (the auto-fired first generation
 * from Design still in flight, or failed) — in every other case it's the
 * generation this tile displays, `isLatest` picks "Latest" vs. `v{n}` for the
 * badge, and `onOpen`/download apply.
 */
function GenerationTile({
  room,
  gen,
  version,
  isLatest,
  generating,
  failed,
  onRetry,
  onOpen,
}: {
  room: Room;
  gen?: RoomGeneration;
  version: number;
  isLatest: boolean;
  generating?: boolean;
  failed?: boolean;
  onRetry?: () => Promise<void>;
  onOpen?: () => void;
}) {
  return (
    <div className="hover-lift group relative aspect-[4/3] w-64 shrink-0 overflow-hidden rounded-2xl border border-border bg-surface">
      {gen ? (
        <>
          <RetryImg
            src={gen.imageUrl}
            alt={isLatest ? room.name : `${room.name} version ${version}`}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span className="absolute left-2 top-2 z-10 rounded-md border border-white/10 bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-foreground/90 backdrop-blur-sm">
            {isLatest ? "Latest" : `v${version}`}
          </span>
          <a
            href={gen.imageUrl}
            download={`${slugifyRoomName(room.name)}${isLatest ? "" : `-v${version}`}.png`}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2 top-2 z-20 grid size-7 place-items-center rounded-md border border-white/10 bg-black/70 text-foreground/90 backdrop-blur-sm transition hover:bg-black/90 cursor-pointer"
            aria-label="Save image to your device"
            title="Save image"
          >
            <Icon name="Download" className="size-3.5" />
          </a>
          <button
            onClick={onOpen}
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

function GenerateMoreCard({
  disabled,
  onGenerateMore,
}: {
  disabled: boolean;
  onGenerateMore: (note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Fires and returns immediately, instead of the old awaited flow that
  // swapped this whole card for a spinner (which blocked a second click
  // until the first request settled). The in-flight state now lives in the
  // store (generatingRoomIds) and renders as a placeholder tile in
  // RoomSection's strip, so this card stays a usable form the whole time —
  // click Generate More twice in a row and two placeholder tiles appear.
  const run = () => {
    if (disabled) return;
    setError(null);
    const fired = note.trim() || undefined;
    setNote("");
    onGenerateMore(fired).catch((e) => {
      setError(e instanceof Error ? e.message : "Generation failed");
    });
  };

  return (
    <div
      className={cn(
        "relative aspect-[4/3] w-64 shrink-0 overflow-hidden rounded-2xl border border-dashed border-border bg-surface/40 transition-opacity",
        disabled && "opacity-40",
      )}
    >
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
