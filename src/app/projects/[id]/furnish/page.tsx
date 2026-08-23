"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto, useHydrated } from "@/lib/store";
import { FurnishRoomCard, type FurnishCardStatus } from "@/components/project/furnish-room-card";
import { FloorPlanSidePanel } from "@/components/project/floor-plan-side-panel";
import { enqueueGreyboxRender } from "@/lib/greybox/render-queue";
import { validateOpenings } from "@/lib/greybox/validate-openings";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FloorPlan, PlacedFurniture, PlacedOpening, Room } from "@/lib/types";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";

/** Stable reference — see furnish/[roomId]/page.tsx's identical constant. */
const EMPTY_OPENINGS: PlacedOpening[] = [];

/**
 * Furnish gallery (Task 16) — the entry point to the new Furnish phase,
 * between Room Confirmation and Design. One card per room; the whole page's
 * job is to get every room's greybox reference image rendered (serially,
 * via render-queue.ts) and route into furnish/[roomId]'s 3D editor.
 *
 * Gated on hydration+project the same way furnish/[roomId]/page.tsx is: the
 * persisted store only finishes rehydrating from localStorage AFTER the
 * first render, so mounting the content component (and its room-list-driven
 * mount effect) only once that's settled avoids queuing renders for a
 * momentarily-empty room list.
 */
export default function FurnishGalleryPage() {
  const { id } = useParams<{ id: string }>();
  const hydrated = useHydrated();
  const project = useProject(id);

  if (!hydrated || !project) return null;

  // The Plan step was skipped, so no room has geometry and no greybox exists
  // to arrange furniture in. Rendered as a message with a way out rather than
  // a router.replace: a redirect fired from an effect flashes this page's
  // layout first and buries WHY the route closed, and the user can still land
  // here from a bookmark or the browser's history at any time.
  if (project.planSkipped) {
    return (
      <EmptyState
        icon="Sofa"
        text="This project skipped the 3D step, so there is nothing to furnish. You can plan it again from the Plan step to bring this back."
        href={`/projects/${id}/generate`}
        cta="Go to Generate"
      />
    );
  }

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

  return <FurnishGalleryContent projectId={id} rooms={rooms} plan={project.floorPlan} />;
}

function FurnishGalleryContent({
  projectId,
  rooms,
  plan,
}: {
  projectId: string;
  rooms: Room[];
  plan?: FloorPlan;
}) {
  const setRoomGreybox = useVasto((s) => s.setRoomGreybox);
  const updateRoom = useVasto((s) => s.updateRoom);
  const [status, setStatus] = useState<Record<string, FurnishCardStatus>>(() =>
    Object.fromEntries(rooms.map((r) => [r.id, "pending" as const])),
  );

  // Stable per-room signature of just the fields that decide whether a room
  // CAN render at all (width/height) — deliberately not furniture or
  // openings, which this effect already treats as "picked up on next mount,
  // not live" by design (see below). Recomputed every render (cheap: a join
  // over room count) purely so it can sit in the effect's dependency array;
  // it does nothing else.
  const dimsSignature = rooms.map((r) => `${r.id}:${r.width ?? ""}:${r.height ?? ""}`).join("|");

  // On mount, queue every room's greybox render one at a time through
  // render-queue.ts's serial chain — see that file's doc comment for why
  // (parallel WebGL contexts get silently evicted). ensureGreybox is
  // hash-gated, so revisiting this page after nothing changed resolves every
  // job from cache with zero renders/uploads (Step 4's "reload re-renders
  // nothing"). Runs once for the room list this component mounted with, AND
  // re-runs if any room's width/height changes without a remount — Next's
  // router cache can preserve this page across a Review round trip, and
  // without `dimsSignature` in the deps a room's status stayed stuck on
  // whatever it resolved to BEFORE the user filled in dimensions (reported
  // bug: "add dimensions" kept showing after they were added). A room added
  // or removed via Room Confirmation is still only picked up the next time
  // this page mounts — that part is unchanged, and deliberately not covered
  // by this signature.
  useEffect(() => {
    let cancelled = false;
    // Loaded on demand rather than at module scope. This page renders <img>
    // cards and never mounts a 3D canvas, but ensureGreybox transitively
    // pulls in three.js, so a static import put roughly 550KB of WebGL code
    // into the gallery's first load for work that cannot start until after
    // mount anyway. Started once here and awaited inside each queued job, so
    // the module is fetched a single time no matter how many rooms there are.
    const greybox = import("@/lib/greybox/ensure-greybox-key");
    // Same "fetch once, await inside every queued job" shape as `greybox`
    // above — these four are only needed to seed a never-furnished room (see
    // below), which is the uncommon branch, but that seed has to be derived
    // through the exact same helpers ensureGreybox itself uses, so they ride
    // along rather than being hand-rolled here.
    const roomSpecMod = import("@/lib/greybox/room-spec");
    const cameraMod = import("@/lib/greybox/camera");
    const dimsMod = import("@/lib/greybox/dimensions");
    const slotMod = import("@/lib/greybox/first-free-slot");
    for (const room of rooms) {
      enqueueGreyboxRender(async () => {
        // `room.furniture === undefined` means nobody has ever opened this
        // room's 3D editor — the gallery used to hand such a room straight to
        // ensureGreybox as-is, which rendered and CACHED an empty box (only
        // door/window cutouts), so a room the user never opened came back
        // under-furnished with no later trigger to fix it (reported bug).
        // `[]` means the user opened the editor and removed every piece on
        // purpose, which must be left alone — re-seeding it would silently
        // override a deliberate choice. Seeding has to happen BEFORE the
        // ensureGreybox call below, in this same queued job, or the cached
        // greybox would still be the empty one until some unrelated later
        // edit invalidated the hash.
        let seededRoom = room;
        if (room.furniture === undefined) {
          const [{ roomSpecFor }, { greyboxCamera }, { GREYBOX_ASPECT }, { defaultArrangementFor }] =
            await Promise.all([roomSpecMod, cameraMod, dimsMod, slotMod]);
          // roomSpecFor + greyboxCamera is the SAME derivation ensureGreybox
          // and the per-room editor both use — hand-building a spec here
          // would risk seeding furniture framed by a different camera than
          // the one the greybox actually renders from.
          const payload = roomSpecFor(room);
          const spec: GreyboxRoomSpec = {
            width: payload.width,
            depth: payload.depth,
            openings: payload.openings,
            cameraView: payload.cameraView,
          };
          const camera = greyboxCamera(spec, GREYBOX_ASPECT);
          const arrangement: PlacedFurniture[] = defaultArrangementFor(room.type, spec, camera);
          // Service room types (Bathroom, Utility, Store Room...) legitimately
          // seed nothing — defaultArrangementFor already returns [] for them
          // via NO_FURNITURE_ROOM_TYPES. Only persist when there is actually
          // something to add: writing an empty array here would be harmless
          // (greyboxHashFor treats undefined and [] identically via its own
          // `?? []`) but is pointless churn on every service room's card.
          if (arrangement.length > 0) {
            updateRoom(projectId, room.id, { furniture: arrangement });
            seededRoom = { ...room, furniture: arrangement };
          }
        }
        return (await greybox).ensureGreybox(projectId, seededRoom).catch((e) => {
          // Matches generate/page.tsx's own fallback posture: a render/upload
          // failure degrades to the same empty state as "no dimensions yet"
          // rather than surfacing a distinct error UI this task doesn't spec.
          console.warn(
            `[furnish] greybox render/upload failed for "${room.name}":`,
            e instanceof Error ? e.message : e,
          );
          return undefined;
        });
      }).then((gb) => {
        if (cancelled) return;
        // Never spread the whole ensureGreybox result into the store —
        // `projected` is derived fresh per call (see GreyboxResult's own doc
        // comment) and is not one of Room's persisted fields. Only the four
        // real fields go to setRoomGreybox; the card renders greyboxKey via
        // /api/render?key=, nothing here needs `projected`.
        if (gb) {
          setRoomGreybox(projectId, room.id, {
            greyboxKey: gb.greyboxKey,
            greyboxMaskKey: gb.greyboxMaskKey,
            greyboxHash: gb.greyboxHash,
            greyboxLedger: gb.greyboxLedger,
          });
        }
        setStatus((s) => ({ ...s, [room.id]: gb ? "ready" : "unavailable" }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, dimsSignature]);

  const furnishedCount = rooms.filter((r) => (r.furniture?.length ?? 0) > 0).length;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      {/* flex-col by default so a narrow viewport stacks the plan panel
          above the gallery instead of squeezing the card grid; xl:flex-row
          only once there's comfortably enough width for a 224px sidebar
          beside the unchanged max-w-5xl content (1024 + 224 + gap fits
          inside max-w-7xl's 1280px with room to spare). The content column
          keeps its own mx-auto max-w-5xl exactly as before, now centering
          within the space left over next to the panel rather than the whole
          viewport, so the card grid's sizing is unaffected either way. */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 xl:flex-row xl:items-start">
        <FloorPlanSidePanel plan={plan} />
        <div className="mx-auto min-w-0 max-w-5xl flex-1">
          <div className="mb-8 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-2xl font-bold tracking-tight">Furnish</h2>
                <Badge
                  icon="Sofa"
                  className={cn(furnishedCount === rooms.length && "border-success/30 bg-success/10 text-success")}
                >
                  {furnishedCount} of {rooms.length} furnished
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted">
                Furnish your rooms — place furniture where you want it. Every room starts with a default
                arrangement automatically, so skipping one still generates it furnished; open a room to
                rearrange it instead.
              </p>
            </div>
            {/* Always enabled: an unfurnished room still generates fine from an
                openings-only greybox — furnishing is an optional refinement,
                not a gate on the rest of the flow. */}
            <Link href={`/projects/${projectId}/design`}>
              <Button iconRight="ArrowRight">Continue to Design</Button>
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {rooms.map((room) => (
              <FurnishRoomCard
                key={room.id}
                projectId={projectId}
                room={room}
                status={status[room.id] ?? "pending"}
                hasOpeningViolation={hasOpeningViolation(room)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Section 5's read-only opening validity check, per room. Mirrors
 * furnish/[roomId]/page.tsx's own gate exactly (same inputs: placedOpenings
 * or none, layoutSize's width/height) — an internal-geometry exception to
 * layoutSize's "never display as fact" rule, since this never shows the
 * numbers themselves, only whether they're currently valid.
 */
function hasOpeningViolation(room: Room): boolean {
  const openings = room.placedOpenings ?? EMPTY_OPENINGS;
  const { width, height } = layoutSize(room);
  return validateOpenings(openings, width, height).length > 0;
}

function EmptyState({ icon, text, href, cta }: { icon: string; text: string; href: string; cta: string }) {
  return (
    <div className="bg-grid grid h-full place-items-center text-center">
      <div>
        <Icon name={icon} className="mx-auto size-8 text-faint" />
        <p className="mt-3 text-sm text-muted">{text}</p>
        <Link href={href}>
          <Button className="mt-4" variant="outline">
            {cta}
          </Button>
        </Link>
      </div>
    </div>
  );
}
