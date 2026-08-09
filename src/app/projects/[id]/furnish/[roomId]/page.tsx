"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto, useHydrated } from "@/lib/store";
import { FurnitureEditorCanvas, type FurnitureCommitPatch } from "@/components/project/furniture-editor-canvas";
import { furnitureForRoomType, catalogueEntry } from "@/lib/greybox/furniture-catalogue";
import { toWorldFurniture, worldToLocal } from "@/lib/greybox/furniture-layout";
import { ensureGreybox, type GreyboxResult } from "@/lib/greybox/ensure-greybox-key";
import { defaultArrangementFor, firstFreeSlot } from "@/lib/greybox/first-free-slot";
import { MAX_FURNITURE, resolveOcclusion, resolvePlacement, type OcclusionViolation } from "@/lib/greybox/validate-furniture";
import { validateOpenings } from "@/lib/greybox/validate-openings";
import { greyboxCamera } from "@/lib/greybox/camera";
import { GREYBOX_ASPECT } from "@/lib/greybox/dimensions";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import { generateRoomImage } from "@/lib/design-plan-client";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RetryImg } from "@/components/ui/retry-img";
import { cn, uid } from "@/lib/utils";
import type { PlacedFurniture, PlacedOpening, Room } from "@/lib/types";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";
import type { DesignSpecification, UniversalInput } from "@/lib/ai/prompting/types";

const ROTATE_STEP = Math.PI / 12; // 15 degrees
/** Stable reference so `room.placedOpenings ?? EMPTY_OPENINGS` doesn't allocate (and bust memoization) on every render. */
const EMPTY_OPENINGS: PlacedOpening[] = [];

/**
 * Furniture placement editor (Phase B) — hosts Task 14's fixed-camera 3D
 * canvas: a sidebar to add/list/cap furniture, live occlusion warnings, a
 * save-time occlusion gate, and the `?from=` return contract Task 17 wires
 * the rest of the flow around.
 *
 * Wrapped in Suspense because FurnishContent reads useSearchParams() (the
 * `from` query param), which Next requires a Suspense boundary for — see
 * login-form.tsx for the same pattern.
 */
export default function FurnishPage() {
  return (
    <Suspense fallback={null}>
      <FurnishPageInner />
    </Suspense>
  );
}

function FurnishPageInner() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  const hydrated = useHydrated();
  const project = useProject(id);

  // Same hydration-timing gotcha plan/page.tsx's top comment documents: the
  // persisted store only finishes rehydrating from localStorage AFTER the
  // first render, so a useState initializer that reads room.furniture on
  // that first render would freeze at whatever was there pre-hydration
  // (typically nothing) forever, since useState's argument only runs once.
  // Gating the content component's mount on hydration+data means its own
  // useState runs for the first time with the real room already in hand.
  if (!hydrated || !project) return null;

  const room = project.floorPlan?.rooms.find((r) => r.id === roomId);

  if (!room) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-7 text-muted" />
          <p className="mt-3 text-sm text-muted">This room could not be found.</p>
          <Link href={`/projects/${id}/review`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">
              Back to Review
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <FurnishContent
      projectId={id}
      room={room}
      universalInput={project.universalInput}
      designSpec={project.designSpec}
    />
  );
}

function CentredMessage({
  icon,
  spin,
  children,
  action,
}: {
  icon: string;
  spin?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center text-center">
      <div>
        <Icon name={icon} className={cn("mx-auto size-7 text-muted", spin && "animate-spin")} />
        <p className="mt-3 max-w-xs text-sm text-muted">{children}</p>
        {action}
      </div>
    </div>
  );
}

function FurnishContent({
  projectId,
  room,
  universalInput,
  designSpec,
}: {
  projectId: string;
  room: Room;
  universalInput: UniversalInput | undefined;
  designSpec: DesignSpecification | undefined;
}) {
  const updateRoom = useVasto((s) => s.updateRoom);
  const setRoomGreybox = useVasto((s) => s.setRoomGreybox);
  const addGeneration = useVasto((s) => s.addGeneration);
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  // Same branch handleSave already uses to decide where Save lands — the
  // back-link arrow must agree, or a room opened from the Furnish gallery
  // (no ?from) sends the user to /generate, a phase they haven't reached yet.
  const backHref = from === "generate" ? `/projects/${projectId}/generate` : `/projects/${projectId}/furnish`;
  // This page is deliberately two modes of one editor, not two pages: reached
  // from the Furnish gallery it is an arrangement step (Save only), and
  // reached from the Generate gallery's "Adjust with 3D" it is an iteration
  // step (Save and Generate). `from` is the single switch for all three of
  // those differences — this flag, backHref above, and handleSave's
  // destination — so they can never disagree with each other.
  const showGenerate = from === "generate";

  // Geometry first, because the furniture seed below needs it. `layoutSize`
  // and `greyboxCamera` are both pure functions of the room, so computing
  // them ahead of the first useState costs nothing and lets that state's
  // initializer place its seed against the real camera — see
  // defaultArrangementFor's doc comment for why a camera-blind seed was a bug.
  const { width, height: depth } = layoutSize(room);
  const openings = room.placedOpenings ?? EMPTY_OPENINGS;
  const catalogue = furnitureForRoomType(room.type);

  const spec = useMemo<GreyboxRoomSpec>(() => ({ width, depth, openings }), [width, depth, openings]);
  const camera = useMemo(() => greyboxCamera(spec, GREYBOX_ASPECT), [spec]);

  const [furniture, setFurniture] = useState<PlacedFurniture[]>(
    () => room.furniture ?? defaultArrangementFor(room.type, spec, camera),
  );
  // Captures the arrangement the editor MOUNTED with, once — used only by
  // the readiness-gate effect below so it runs a single renderability probe
  // per room rather than re-firing (and re-uploading) on every furniture
  // edit. A ref, not a dependency, so it never forces that effect to re-run.
  const initialFurnitureRef = useRef(furniture);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [occlusion, setOcclusion] = useState<OcclusionViolation[]>([]);
  const [notice, setNotice] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lastGeneration, setLastGeneration] = useState<{ imageUrl: string; createdAt: string } | null>(null);
  const [readiness, setReadiness] = useState<"checking" | "ready" | "unavailable">("checking");

  // Section 5 — openings are read-only here (they're placed in the Plan
  // Editor). These used to BLOCK the editor outright. They no longer do:
  // Section 5's thresholds are tuned for geometry a human placed deliberately,
  // and Gemini-derived openings trip them often enough that blocking made a
  // large share of real floor plans unfurnishable. The violation is still
  // real and still worth showing — a door 0.3ft from a corner renders as a
  // missing wall chunk, and the image model faithfully reproduces whatever
  // the greybox shows it — so it degrades to a warning the user can read and
  // act on, rather than a wall they cannot get past. Nothing is auto-repaired;
  // an opening still never moves on its own.
  const openingViolations = useMemo(() => validateOpenings(openings, width, depth), [openings, width, depth]);
  const [violationsDismissed, setViolationsDismissed] = useState(false);

  // Gap 1's replacement for the old `if (!room.shape) return <...>` gate,
  // which Task 7 made obsolete (ensureGreybox no longer requires room.shape).
  // The only thing that can make a room genuinely unfurnishable now is
  // ensureGreybox itself coming back undefined — a render/upload failure,
  // since layoutSize/seedPlacedOpenings mean every OTHER room gets at least
  // a plain box. Runs once per room (not on every furniture edit — Save/
  // Generate are this editor's own deliberate points of contact with
  // ensureGreybox) using the arrangement the canvas mounted with, and
  // persists a success so a following Save has a real shot at a cache hit
  // instead of re-rendering the same thing twice.
  useEffect(() => {
    let cancelled = false;
    ensureGreybox(projectId, { ...room, furniture: initialFurnitureRef.current })
      .then((gb) => {
        if (cancelled) return;
        if (gb) {
          updateRoom(projectId, room.id, {
            greyboxKey: gb.greyboxKey,
            greyboxMaskKey: gb.greyboxMaskKey,
            greyboxHash: gb.greyboxHash,
            greyboxLedger: gb.greyboxLedger,
          });
          setReadiness("ready");
        } else {
          setReadiness("unavailable");
        }
      })
      .catch(() => {
        if (!cancelled) setReadiness("unavailable");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, room.id]);

  const addFurniture = (kind: string) => {
    if (furniture.length >= MAX_FURNITURE) return; // buttons are disabled at the cap; stay safe if called anyway
    const slot = firstFreeSlot(kind, furniture, spec, camera);
    if (!slot) {
      setAddError("No free space left in this room");
      return;
    }
    setAddError(null);
    const item: PlacedFurniture = { id: uid("furn"), kind, x: slot.x, z: slot.z, rotation: 0 };
    setFurniture((prev) => [...prev, item]);
    setSelectedId(item.id);
  };

  const rotateItem = (itemId: string, dir: 1 | -1) => {
    setFurniture((prev) => {
      const item = prev.find((f) => f.id === itemId);
      if (!item) return prev;
      const rotation = item.rotation + dir * ROTATE_STEP;
      // Mirrors furniture-editor-canvas.tsx's own keyboard ([`/`]`) rotate
      // handler exactly: re-run resolvePlacement at the item's CURRENT
      // (already-legal) position as both the target and the `from`, at the
      // NEW rotation — a rotation alone can widen the item's AABB and create
      // an overlap the position by itself did not have (footprintAabb folds
      // rotation into the box extents), so resolvePlacement may need to
      // nudge the position to dodge it.
      const others = toWorldFurniture(
        prev.filter((f) => f.id !== itemId),
        width,
        depth,
      );
      const world = toWorldFurniture([item], width, depth)[0];
      if (!world) return prev; // unknown/stale kind — nothing to safely rotate
      const { x, z } = resolvePlacement(
        { kind: item.kind, rotation, x: world.x, z: world.z, fromX: world.x, fromZ: world.z },
        others,
        { width, depth },
        { x: camera.position.x, z: camera.position.z },
      );
      const local = worldToLocal(x, z, width, depth);
      return prev.map((f) => (f.id === itemId ? { ...f, x: local.x, z: local.z, rotation } : f));
    });
  };

  const deleteItem = (itemId: string) => {
    setFurniture((prev) => prev.filter((f) => f.id !== itemId));
    setSelectedId((cur) => (cur === itemId ? null : cur));
  };

  // Task 14's canvas reports every drag/nudge/rotate/delete through this one
  // callback rather than handing back a whole new furniture array — see
  // FurnitureCommitPatch's doc comment. `null` means remove.
  const handleFurnitureCommit = (itemId: string, patch: FurnitureCommitPatch) => {
    if (patch === null) {
      deleteItem(itemId);
      return;
    }
    setFurniture((prev) => prev.map((f) => (f.id === itemId ? { ...f, ...patch } : f)));
  };

  function occlusionMessage(v: OcclusionViolation): string {
    const opening = openings.find((o) => o.id === v.openingId);
    const wallLabel = opening ? `${opening.wall} ` : "";
    const blocker = furniture.find((f) => f.id === v.blockerId);
    const label = blocker ? (catalogueEntry(blocker.kind)?.label ?? blocker.kind) : "Something";
    return `${label} blocks the ${wallLabel}${v.openingType}. Move it or the generated room may show a wall there instead.`;
  }

  /**
   * Section 6.1's save-time gate for anything the live warnings did not get
   * fixed. Furniture always yields; an opening never moves. Also the point
   * of contact that (re-)renders the greybox reference for the CURRENT
   * arrangement and persists it — shared by Save and Generate, since
   * Generate needs everything Save does before it can kick off a render.
   */
  async function save(): Promise<{ furniture: PlacedFurniture[]; gb: GreyboxResult } | undefined> {
    const { furniture: resolved, changes } = resolveOcclusion(furniture, occlusion);
    if (changes.length) {
      setNotice(changes);
      setFurniture(resolved);
      setSelectedId((cur) => (cur && resolved.some((f) => f.id === cur) ? cur : null));
      updateRoom(projectId, room.id, { furniture: resolved });
    }
    const gb = await ensureGreybox(projectId, { ...room, furniture: resolved });
    if (!gb) return undefined;
    setRoomGreybox(projectId, room.id, {
      furniture: resolved,
      greyboxKey: gb.greyboxKey,
      greyboxMaskKey: gb.greyboxMaskKey,
      greyboxHash: gb.greyboxHash,
      greyboxLedger: gb.greyboxLedger,
    });
    return { furniture: resolved, gb };
  }

  const handleSave = async () => {
    if (busy || generating) return;
    setBusy(true);
    setError(null);
    try {
      const result = await save();
      if (!result) {
        setError("Could not save this arrangement — try again.");
        return;
      }
      router.push(from === "generate" ? `/projects/${projectId}/generate` : `/projects/${projectId}/furnish`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // Only undefined when the project hasn't been through Design Planning yet
  // (design/page.tsx hasn't run, or /api/design-plan hasn't resolved) — same
  // precondition generate/page.tsx's own empty state checks for.
  const canGenerate = !!universalInput && !!designSpec;

  /**
   * Save, then immediately generate a real image for this room using the
   * CURRENT (post-occlusion-resolve) furniture arrangement — the exact same
   * mechanism generate/page.tsx's `generateMore` uses (generateRoomImage +
   * addGeneration), so the result lands in the same roomCards/generations
   * data Approve, the profile renders list, and Walkthrough all read from.
   * Stays on this page afterward (no navigation) so the freshly generated
   * image can render inline in the sidebar via `lastGeneration`.
   */
  const handleGenerate = async () => {
    if (busy || generating || !canGenerate || !universalInput || !designSpec) return;
    setGenerating(true);
    setGenerateError(null);
    // Register in the store as well as locally. `generating` above only drives
    // THIS page's button; the Generate gallery reads `generatingRoomIds` to
    // decide whether to show a room's spinner, so without this a generation
    // kicked off here was invisible over there — the user navigated to the
    // gallery, saw no loading state, and the image simply appeared later
    // (reported bug). design/page.tsx's auto-fire loop already pairs these
    // two calls the same way.
    useVasto.getState().startGenerating(projectId, room.id);
    try {
      const result = await save();
      if (!result) {
        setGenerateError("Could not prepare this room's 3D reference — try again.");
        return;
      }
      const { furniture: savedFurniture, gb } = result;
      const size = formatRoomSize(room.width, room.height);
      const gen = await generateRoomImage({
        projectId,
        universalInput,
        room: {
          name: room.name,
          type: room.type,
          ...(size ? { size } : {}),
          additional_notes: universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes,
          openings: room.openings,
        },
        designSpec,
        greyboxKey: gb.greyboxKey,
        greyboxMaskKey: gb.greyboxMaskKey,
        projected: gb.projected,
        furniture: savedFurniture,
      });
      const createdAt = new Date().toISOString();
      addGeneration(projectId, room.id, {
        id: uid("gen"),
        createdAt,
        imageUrl: gen.imageUrl,
        imageKey: gen.key,
        prompt: gen.prompt,
      });
      setLastGeneration({ imageUrl: gen.imageUrl, createdAt });
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
      useVasto.getState().stopGenerating(projectId, room.id);
    }
  };

  if (readiness === "checking") {
    return (
      <CentredMessage icon="Loader2" spin>
        Preparing this room&apos;s 3D view…
      </CentredMessage>
    );
  }

  if (readiness === "unavailable") {
    return (
      <CentredMessage
        icon="CircleAlert"
        action={
          <Link href={`/projects/${projectId}/review`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">
              Go to Room Confirmation
            </Button>
          </Link>
        }
      >
        Add this room&apos;s dimensions in Room Confirmation to arrange furniture in 3D
      </CentredMessage>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <Link
          href={backHref}
          className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-muted hover:text-foreground"
        >
          <Icon name="ArrowLeft" className="size-4 shrink-0" />
          <span className="truncate">{room.name}</span>
        </Link>
        <div className="flex items-center gap-2">
          {(error || generateError) && (
            <p className="max-w-[16rem] truncate text-[11px] text-danger" title={error ?? generateError ?? undefined}>
              {error ?? generateError}
            </p>
          )}
          <Button size="sm" variant="outline" icon="Check" loading={busy} disabled={generating} onClick={handleSave}>
            Save
          </Button>
          {/* Generate belongs only to the "Adjust with 3D" entry point, which
              is reached FROM the Generate gallery with ?from=generate — there
              the user has already been through Design and is iterating on an
              existing image. Opened from the Furnish gallery this is a plain
              arrangement step that has not reached Design yet, so Save is the
              only meaningful action and offering Generate just leads to the
              disabled "plan the design first" state. */}
          {showGenerate && (
            <Button
              size="sm"
              icon="Sparkles"
              loading={generating}
              disabled={busy || !canGenerate}
              title={canGenerate ? undefined : "Plan the design first (Design step) before generating a room image."}
              onClick={handleGenerate}
            >
              Generate
            </Button>
          )}
        </div>
      </div>

      {openingViolations.length > 0 && !violationsDismissed && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-5 py-3">
          <div className="mx-auto flex max-w-6xl items-start gap-3">
            <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">
                Some doors and windows in this room sit in positions that may not render accurately
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-muted">
                {openingViolations.map((v, i) => (
                  <li key={i}>{v.message}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted">
                You can keep furnishing and generating. The generated image may show these openings in slightly
                different positions, or as solid wall.{" "}
                <Link href={`/projects/${projectId}/plan`} className="font-medium text-accent hover:underline">
                  Adjust them in the Plan Editor
                </Link>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setViolationsDismissed(true)}
              className="shrink-0 text-faint hover:text-muted cursor-pointer"
              aria-label="Dismiss"
            >
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-bg p-6">
        <div className="mx-auto flex h-full max-w-6xl gap-5">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-grid">
              <FurnitureEditorCanvas
                spec={spec}
                furniture={furniture}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onCommit={handleFurnitureCommit}
                onOcclusionChange={setOcclusion}
              />
              <p className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-bg/80 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur">
                Click an item to select it, then drag to move. Arrow keys nudge, [ ] rotates, Delete removes.
              </p>
            </div>

            {occlusion.length > 0 && (
              <div className="shrink-0 space-y-1.5 rounded-2xl border border-warning/30 bg-warning/10 p-3">
                {occlusion.map((v) => (
                  <p key={v.openingId} className="flex items-start gap-2 text-xs text-warning">
                    <Icon name="CircleAlert" className="mt-0.5 size-3.5 shrink-0" />
                    <span>{occlusionMessage(v)}</span>
                  </p>
                ))}
              </div>
            )}

            {notice.length > 0 && (
              <div className="shrink-0 space-y-1.5 rounded-2xl border border-border bg-surface-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">Adjusted on save</p>
                  <button
                    type="button"
                    onClick={() => setNotice([])}
                    className="shrink-0 text-faint hover:text-muted cursor-pointer"
                    aria-label="Dismiss"
                  >
                    <Icon name="X" className="size-3.5" />
                  </button>
                </div>
                {notice.map((n, i) => (
                  <p key={i} className="text-xs text-muted">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </div>

          <aside className="w-96 shrink-0 space-y-4 overflow-y-auto">
            <div className="rounded-2xl border border-border bg-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">Add furniture</p>
                {furniture.length >= MAX_FURNITURE && (
                  <span className="text-[11px] font-medium text-muted">
                    Room is full ({furniture.length} of {MAX_FURNITURE})
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {catalogue.map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    disabled={furniture.length >= MAX_FURNITURE}
                    onClick={() => addFurniture(entry.kind)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg px-3 py-2 text-sm font-medium text-muted transition hover:border-accent/50 hover:bg-surface-3 hover:text-foreground cursor-pointer",
                      furniture.length >= MAX_FURNITURE && "cursor-not-allowed opacity-50 hover:border-border hover:bg-bg hover:text-muted",
                    )}
                  >
                    <Icon name="Plus" className="size-4" />
                    {entry.label}
                  </button>
                ))}
                {catalogue.length === 0 && (
                  <p className="text-xs text-faint">No catalogue items for this room type.</p>
                )}
              </div>
              {addError && <p className="mt-2 text-xs text-danger">{addError}</p>}
            </div>

            <div className="rounded-2xl border border-border bg-surface-2 p-4">
              <p className="mb-3 text-xs font-semibold text-foreground">Placed items</p>
              {furniture.length === 0 && (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-faint">
                  Nothing placed yet. Add something above.
                </p>
              )}
              <ul className="space-y-2">
                {furniture.map((item) => {
                  const entry = catalogue.find((e) => e.kind === item.kind);
                  const isSelected = item.id === selectedId;
                  return (
                    <li
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm cursor-pointer transition",
                        isSelected
                          ? "border-accent/60 bg-accent/10 text-foreground"
                          : "border-border bg-bg text-muted hover:bg-surface-3 hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{entry?.label ?? item.kind}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label="Rotate left"
                          title="Rotate left"
                          onClick={(e) => {
                            e.stopPropagation();
                            rotateItem(item.id, -1);
                          }}
                          className="rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-foreground cursor-pointer"
                        >
                          <Icon name="RotateCw" className="size-4 -scale-x-100" />
                        </button>
                        <button
                          type="button"
                          aria-label="Rotate right"
                          title="Rotate right"
                          onClick={(e) => {
                            e.stopPropagation();
                            rotateItem(item.id, 1);
                          }}
                          className="rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-foreground cursor-pointer"
                        >
                          <Icon name="RotateCw" className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteItem(item.id);
                          }}
                          className="rounded-md p-1.5 text-muted hover:bg-danger/15 hover:text-danger cursor-pointer"
                        >
                          <Icon name="Trash2" className="size-4" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="rounded-2xl border border-border bg-surface-2 p-4">
              <p className="mb-3 text-xs font-semibold text-foreground">Latest generation</p>
              {lastGeneration ? (
                <div>
                  <div className="overflow-hidden rounded-xl border border-border bg-grid">
                    <RetryImg src={lastGeneration.imageUrl} alt="" className="aspect-square w-full object-cover" />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <p className="text-xs text-muted">Generated just now</p>
                    <Link
                      href={`/projects/${projectId}/generate`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                      View in gallery
                      <Icon name="ArrowRight" className="size-3.5" />
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-faint">
                  Click Generate to render this arrangement into a room image.
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
