"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto, useHydrated } from "@/lib/store";
import { FurnitureEditorCanvas, footprintClampMargins } from "@/components/project/furniture-editor-canvas";
import { furnitureForRoomType } from "@/lib/greybox/furniture-catalogue";
import { defaultFurnitureFor, describeFurnitureForPrompt, toWorldFurniture } from "@/lib/greybox/furniture-layout";
import { renderGreyboxBundle } from "@/lib/greybox/render-mask";
import { layoutSize } from "@/lib/pipeline/empty-plan";
import { generateRoomImage } from "@/lib/design-plan-client";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RetryImg } from "@/components/ui/retry-img";
import { cn, uid } from "@/lib/utils";
import type { PlacedFurniture, Room } from "@/lib/types";
import type { DesignSpecification, UniversalInput } from "@/lib/ai/prompting/types";

/** New items spread along x (room-local), wrapping before they'd clamp to nothing but overlap. */
const NEW_ITEM_STEP = 0.15;
const NEW_ITEM_MIN = 0.1;
const NEW_ITEM_MAX = 0.9;
const ROTATE_STEP = Math.PI / 12; // 15 degrees

/**
 * Furniture placement editor (Phase B) — an interactive, orbit-controlled
 * companion to the Plan Editor's locked greybox export view. Lets the user
 * drop and arrange furniture proxies in a room's 3D greybox before
 * generation, then re-renders + re-uploads the greybox reference image so
 * the placement actually reaches the image model.
 */
export default function FurnishPage() {
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

  // A room only gets a feet-scale footprint + wall openings once it's been
  // placed in the Plan Editor (Room.shape) — without that there is nothing
  // to build a greybox from, so furnishing it would crash rather than help.
  if (!room.shape) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-7 text-muted" />
          <p className="mt-3 max-w-xs text-sm text-muted">
            {room.name} hasn&apos;t been placed in the Plan Editor yet, so it has no shape or openings to furnish.
          </p>
          <Link href={`/projects/${id}/plan`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">
              Go to Plan Editor
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return <FurnishContent projectId={id} room={room} universalInput={project.universalInput} designSpec={project.designSpec} />;
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
  const addGeneration = useVasto((s) => s.addGeneration);
  const router = useRouter();

  const [furniture, setFurniture] = useState<PlacedFurniture[]>(
    () => room.furniture ?? defaultFurnitureFor(room.type),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lastGeneration, setLastGeneration] = useState<{ imageUrl: string; createdAt: string } | null>(null);

  const { width, height: depth } = layoutSize(room);
  const openings = room.placedOpenings ?? [];
  const catalogue = furnitureForRoomType(room.type);

  const addFurniture = (kind: string) => {
    const step = furniture.length % Math.round((NEW_ITEM_MAX - NEW_ITEM_MIN) / NEW_ITEM_STEP + 1);
    const rawX = Math.min(NEW_ITEM_MAX, Math.max(NEW_ITEM_MIN, NEW_ITEM_MIN + NEW_ITEM_STEP * step));
    // Clamp the new item's default spot by its actual footprint (feet), not
    // the flat NEW_ITEM_MIN/MAX margin — a large item (e.g. a 9ft conference
    // table) dropped near NEW_ITEM_MIN/MAX in a small room would otherwise
    // start already clipping a wall, same footprint-vs-flat-margin issue the
    // live drag clamp below has to account for.
    const { mx, mz } = footprintClampMargins(kind, width, depth);
    const x = Math.min(1 - mx, Math.max(mx, rawX));
    const z = Math.min(1 - mz, Math.max(mz, 0.5));
    const item: PlacedFurniture = { id: uid("furn"), kind, x, z, rotation: 0 };
    setFurniture((prev) => [...prev, item]);
    setSelectedId(item.id);
  };

  const rotateItem = (itemId: string, dir: 1 | -1) => {
    setFurniture((prev) =>
      prev.map((f) => (f.id === itemId ? { ...f, rotation: f.rotation + dir * ROTATE_STEP } : f)),
    );
  };

  const deleteItem = (itemId: string) => {
    setFurniture((prev) => prev.filter((f) => f.id !== itemId));
    setSelectedId((cur) => (cur === itemId ? null : cur));
  };

  /**
   * Renders + uploads the current arrangement's greybox and writes it (plus
   * the furniture list) onto the room in the store. Shared by both the plain
   * Save button and Generate below, since Generate needs to do everything
   * Save does before it can kick off a render with the up-to-date reference
   * image.
   */
  const saveArrangement = async (): Promise<string> => {
    const { dataUri, maskDataUri, projected } = renderGreyboxBundle({
      width,
      depth,
      openings,
      furniture: toWorldFurniture(furniture, width, depth),
    });
    const res = await fetch("/api/upload-greybox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, dataUri, maskDataUri, projected }),
    });
    if (!res.ok) throw new Error(`Greybox upload failed (${res.status})`);
    const { key, maskKey, ledger } = (await res.json()) as {
      key: string;
      maskKey: string;
      ledger: { doors: number; windows: number };
    };
    updateRoom(projectId, room.id, { furniture, greyboxKey: key, greyboxMaskKey: maskKey, greyboxLedger: ledger });
    return key;
  };

  const handleSave = async () => {
    if (busy || generating) return;
    setBusy(true);
    setError(null);
    try {
      await saveArrangement();
      router.push(`/projects/${projectId}/review`);
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
   * CURRENT furniture arrangement — the exact same mechanism
   * generate/page.tsx's `generateMore` uses (generateRoomImage +
   * addGeneration), so the result lands in the same roomCards/generations
   * data Approve, the profile renders list, and Walkthrough all read from.
   * Stays on this page afterward (no navigation) so the freshly generated
   * image can render inline in the sidebar via `lastGeneration` — the user
   * asked to see the result land here rather than being sent to the gallery.
   */
  const handleGenerate = async () => {
    if (busy || generating || !canGenerate || !universalInput || !designSpec) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const greyboxKey = await saveArrangement();
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
          furniture: furniture.length ? describeFurnitureForPrompt(furniture) : undefined,
        },
        designSpec,
        greyboxKey,
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
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <Link
          href={`/projects/${projectId}/generate`}
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
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-bg p-6">
        <div className="mx-auto flex h-full max-w-6xl gap-5">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-grid">
            <FurnitureEditorCanvas
              width={width}
              depth={depth}
              openings={openings}
              furniture={furniture}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onFurnitureChange={setFurniture}
            />
            <p className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-bg/80 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur">
              Drag to orbit. Click an item to select, then drag it to move. The wireframe box shows the exported view.
            </p>
          </div>

          <aside className="w-96 shrink-0 space-y-4 overflow-y-auto">
            <div className="rounded-2xl border border-border bg-surface-2 p-4">
              <p className="mb-3 text-xs font-semibold text-foreground">Add furniture</p>
              <div className="flex flex-wrap gap-2">
                {catalogue.map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    onClick={() => addFurniture(entry.kind)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg px-3 py-2 text-sm font-medium text-muted transition hover:border-accent/50 hover:bg-surface-3 hover:text-foreground cursor-pointer"
                  >
                    <Icon name="Plus" className="size-4" />
                    {entry.label}
                  </button>
                ))}
                {catalogue.length === 0 && (
                  <p className="text-xs text-faint">No catalogue items for this room type.</p>
                )}
              </div>
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
