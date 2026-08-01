"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { PlanEditorCanvas, type EditorRoom } from "@/components/project/plan-editor-canvas";
import { deriveOpenings, seedPlacedOpenings, type EditorShape } from "@/lib/plan-editor/geometry";
import { ROOM_PALETTE, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Room } from "@/lib/types";

/**
 * The Plan Editor (revamp: greybox opening placement, Phase A) — sits between
 * Upload and Room Confirmation. Lets the user drop each extracted room onto
 * the uploaded plan image as a rectangle and place its doors/windows on its
 * walls, so the generated room image can be conditioned on where they
 * actually are (see docs/superpowers/specs/2026-08-01-greybox-*).
 *
 * Editing happens entirely in local state; "Continue" derives RoomOpening[]
 * from the placed geometry and writes everything back in one
 * applyPlanLayout call — the same "build final Room[] locally, commit once"
 * pattern the (disabled) Sketch Tool page uses.
 */

const DEFAULT_SHAPE: EditorShape = { x: 0.38, y: 0.38, w: 0.2, h: 0.2 };

export default function PlanEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const applyPlanLayout = useVasto((s) => s.applyPlanLayout);

  const initialRooms = useMemo(() => project?.floorPlan?.rooms ?? [], [project?.floorPlan?.rooms]);
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  if (!project) return null;

  const plan = project.floorPlan;
  const referenceImage = imageFailed
    ? undefined
    : plan?.meta?.storageKey
      ? `/api/render?key=${encodeURIComponent(plan.meta.storageKey)}`
      : plan?.previewUrl;

  const placedRooms: EditorRoom[] = rooms
    .filter((r): r is Room & { shape: NonNullable<Room["shape"]> } => !!r.shape)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      shape: r.shape,
      placedOpenings: r.placedOpenings ?? [],
    }));
  const unplacedRooms = rooms.filter((r) => !r.shape);

  const patchRoom = (roomId: string, patch: Partial<Room>) =>
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, ...patch } : r)));

  const placeRoom = (room: Room) => {
    // Seed from this room's extraction-time openings (side-only guess) so
    // there's something to drag into place, not a blank rectangle.
    const seeded = room.placedOpenings ?? seedPlacedOpenings(room.openings ?? []);
    patchRoom(room.id, { shape: { ...DEFAULT_SHAPE }, placedOpenings: seeded });
    setSelectedId(room.id);
  };

  const addNewRoom = () => {
    const room: Room = {
      id: uid("room"),
      name: `Room ${rooms.length + 1}`,
      x: 0,
      y: 0,
      color: ROOM_PALETTE[rooms.length % ROOM_PALETTE.length],
      shape: { ...DEFAULT_SHAPE },
      placedOpenings: [],
    };
    setRooms((prev) => [...prev, room]);
    setSelectedId(room.id);
  };

  const unplaceRoom = (roomId: string) => {
    patchRoom(roomId, { shape: undefined });
    if (selectedId === roomId) setSelectedId(null);
  };

  const deleteRoom = (roomId: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    if (selectedId === roomId) setSelectedId(null);
  };

  const proceed = () => {
    if (placedRooms.length > 0) {
      const derived = deriveOpenings(placedRooms);
      const finalRooms = rooms.map((r) => (r.shape ? { ...r, openings: derived[r.id] ?? [] } : r));
      applyPlanLayout(id, finalRooms);
    }
    router.push(`/projects/${id}/review`);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Place doors and windows</h2>
          <p className="mt-1 text-sm text-muted">
            Draw each room where it actually sits on the plan, then drag its doors and windows onto the
            right wall. This is what makes the generated image put them in the same place.
          </p>
        </div>

        {!referenceImage ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <Icon name="Image" className="mx-auto size-7 text-faint" />
            <p className="mt-3 text-sm text-muted">
              No plan image to draw on for this project. You can still add rooms and their doors/windows
              manually on the next screen.
            </p>
            <Button className="mt-4" iconRight="ArrowRight" onClick={() => router.push(`/projects/${id}/review`)}>
              Continue to Room Confirmation
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div
              className="relative w-full overflow-hidden rounded-2xl border border-border bg-grid bg-surface"
              style={{ aspectRatio: aspect ?? 4 / 3 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={referenceImage}
                alt="Uploaded floor plan"
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
                onError={() => setImageFailed(true)}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
                }}
              />
              <PlanEditorCanvas
                rooms={placedRooms}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onShapeChange={(roomId, shape) => patchRoom(roomId, { shape })}
                onOpeningsChange={(roomId, placedOpenings) => patchRoom(roomId, { placedOpenings })}
              />
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-3.5">
                <h3 className="text-sm font-semibold">Rooms</h3>
                <p className="mt-1 text-xs text-faint">
                  Click a wall on the selected room to add a door; click it again to make it a window, once
                  more to remove it. Drag a door/window along its wall, or drag its ends to resize.
                </p>
                <div className="scrollbar-thin mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {placedRooms.map((r) => {
                    const doors = r.placedOpenings.filter((o) => o.type === "door").length;
                    const windows = r.placedOpenings.filter((o) => o.type === "window").length;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedId(r.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          r.id === selectedId ? "bg-accent/15 text-accent" : "hover:bg-surface-2"
                        }`}
                      >
                        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                        <span className="min-w-0 flex-1 truncate font-medium">{r.name || "Room"}</span>
                        <span className="shrink-0 text-faint">
                          {doors}D · {windows}W
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            unplaceRoom(r.id);
                          }}
                          className="shrink-0 cursor-pointer text-faint hover:text-foreground"
                          aria-label={`Remove ${r.name} from plan`}
                          title="Remove from plan"
                        >
                          <Icon name="EyeOff" className="size-3.5" />
                        </button>
                      </button>
                    );
                  })}
                  {placedRooms.length === 0 && (
                    <p className="px-1 py-2 text-xs text-faint">No rooms placed yet.</p>
                  )}
                </div>
              </div>

              {unplacedRooms.length > 0 && (
                <div className="rounded-2xl border border-border bg-surface p-3.5">
                  <h3 className="text-sm font-semibold">Not on the plan yet</h3>
                  <div className="mt-2 space-y-1.5">
                    {unplacedRooms.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs">
                        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                        <span className="min-w-0 flex-1 truncate">{r.name || "Room"}</span>
                        <Button size="sm" variant="ghost" onClick={() => placeRoom(r)}>
                          Place
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          icon="Trash2"
                          aria-label={`Delete ${r.name}`}
                          onClick={() => deleteRoom(r.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={addNewRoom}
                className="hover-lift flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/60 py-3 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                <Icon name="Plus" className="size-3.5" /> Add room
              </button>

              {selectedId && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="Trash2"
                  className="w-full"
                  onClick={() => deleteRoom(selectedId)}
                >
                  Delete selected room entirely
                </Button>
              )}
            </div>
          </div>
        )}

        {referenceImage && (
          <div className="mt-6 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => router.push(`/projects/${id}/review`)}>
              Skip for now
            </Button>
            <Button iconRight="ArrowRight" onClick={proceed}>
              Continue to Room Confirmation
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
