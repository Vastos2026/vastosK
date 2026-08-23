"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto, useHydrated } from "@/lib/store";
import {
  PlanEditorCanvas,
  DOOR_COLOR,
  WINDOW_COLOR,
  type EditorRoom,
  type EditorTool,
} from "@/components/project/plan-editor-canvas";
import { deriveOpenings, seedPlacedOpenings, type EditorShape } from "@/lib/plan-editor/geometry";
import { validateOpenings } from "@/lib/greybox/validate-openings";
import { DEFAULT_ROOM_SIZE_FT, emptyPlan } from "@/lib/pipeline/empty-plan";
import { ROOM_PALETTE, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { FloorPlan, Room } from "@/lib/types";

/** How many undo steps to keep — a generous cap, not a claim anyone needs more. */
const HISTORY_LIMIT = 50;

/**
 * A freshly-uploaded plan image can very rarely still 403 for a moment even
 * with the server-side ownership fix (requireOwnedKey/generations table, see
 * supabase/projects.ts's isRecordedPlanUpload) — e.g. a slow DB replica — and
 * browsers never retry a failed <img> on their own, so without this a rare
 * miss permanently shows "No plan image" until a manual reload. Same
 * short-retry pattern as generate/page.tsx's RetryImg.
 */
// Same widened schedule as retry-img.tsx's RETRY_SCHEDULE_MS — kept as its
// own copy rather than routed through the shared RetryImg component because
// this page needs its OWN "give up" UI (the large "No plan image to draw on"
// empty state with a Continue button), not RetryImg's generic broken-icon.
const IMG_RETRY_SCHEDULE_MS = [500, 800, 1300, 2000, 3000];

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

/**
 * Aspect of the blank-canvas mode's grid. There is no image to read a natural
 * aspect off, and it has to be a FIXED number rather than "fill the column":
 * every shape is stored normalised to the canvas, so a canvas whose aspect
 * changed with the viewport would move every room's real-world proportions
 * with it. Deliberately PORTRAIT and taller than one viewport — the user
 * wants a canvas roomy enough to draw a real plan into, not one that fits on
 * screen, so reaching the bottom takes a scroll. That means it no longer
 * matches the image path's 4/3 fallback below; that's fine, the image path
 * reads its aspect off the actual uploaded image instead of guessing.
 */
const BLANK_CANVAS_ASPECT = 5 / 6;

/**
 * The toolbar's keyboard shortcuts, rendered as the legend panel and applied
 * by the keydown handler below. One list so the two can't disagree about what
 * a key does. Delete/Backspace EQUIPS the delete tool (the same thing the
 * toolbar button does); it never deletes the selected room, which is what the
 * "Delete selected room entirely" button is for.
 */
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["A"], label: "Select, move and resize" },
  { keys: ["D"], label: "Add door" },
  { keys: ["W"], label: "Add window" },
  { keys: ["Del", "Backspace"], label: "Delete doors and windows" },
];

export default function PlanEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const project = useProject(id);
  const setPlanSkipped = useVasto((s) => s.setPlanSkipped);

  // Gate the EDITOR's mount on hydration+data being ready, rather than
  // seeding its local room-copy state via an effect: the persisted store
  // only finishes hydrating from localStorage AFTER the first render, so a
  // useState initializer evaluated on that first render would freeze at
  // empty forever (useState's argument is only used once, ever). Not
  // rendering PlanEditorContent until real data exists means its own
  // useState(project.floorPlan.rooms) runs for the first time with the real
  // rooms already in hand.
  if (!hydrated || !project) return null;

  // Coming back to a page the user deliberately skipped. Answering Yes just
  // clears the flag — that re-renders straight into the editor below, and
  // brings Furnish and "Adjust with 3D" back with it, since both key off the
  // same flag rather than off a separate copy of this decision. No local
  // "answered" state is needed for the Yes branch for exactly that reason.
  if (project.planSkipped) {
    return (
      <PlanAgainPrompt
        onYes={() => setPlanSkipped(id, false)}
        onNo={() => router.back()}
      />
    );
  }

  return <PlanEditorContent projectId={id} floorPlan={project.floorPlan} />;
}

function PlanAgainPrompt({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 text-center">
        <Icon name="DoorClosed" className="mx-auto size-7 text-faint" />
        <h2 className="mt-3 text-lg font-semibold">You have skipped this page, do you want to plan again?</h2>
        <p className="mt-1.5 text-sm text-muted">
          Planning again brings back the 3D greybox step, so rooms are generated from real geometry and you can
          place furniture yourself. Images you have already generated stay exactly as they are.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="ghost" onClick={onNo}>
            No, go back
          </Button>
          <Button icon="Pencil" onClick={onYes}>
            Yes, plan again
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlanEditorContent({
  projectId,
  floorPlan,
}: {
  projectId: string;
  floorPlan: FloorPlan | undefined;
}) {
  const router = useRouter();
  const applyPlanLayout = useVasto((s) => s.applyPlanLayout);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setPlanSkipped = useVasto((s) => s.setPlanSkipped);
  const confirmPlan = useVasto((s) => s.confirmPlan);

  const [rooms, setRooms] = useState<Room[]>(floorPlan?.rooms ?? []);
  const [skipConfirming, setSkipConfirming] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imgAttempt, setImgAttempt] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  const imgRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (imgRetryRef.current) clearTimeout(imgRetryRef.current);
  }, []);
  const [tool, setTool] = useState<EditorTool>("select");

  // "Continue" below is a router.push, not a <Link>, so Next's automatic
  // viewport prefetch never covers it. Room Confirmation is the only
  // possible next step from here, so warm it as soon as the editor mounts —
  // by the time someone finishes placing rooms/openings and clicks Continue,
  // the route is already fetched.
  useEffect(() => {
    router.prefetch(`/projects/${projectId}/review`);
  }, [router, projectId]);

  // Toolbar keyboard shortcuts. The listener lives in an effect because it is
  // a window subscription — subscribe on mount, unsubscribe on unmount, with
  // nothing else in the effect body. The state setter runs inside the
  // HANDLER, which is a user event, not during the effect itself.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd/Alt combinations belong to the browser and the OS (Cmd+D
      // bookmarks, Alt+Left goes back). Only bare keypresses are the
      // toolbar's, or this would break those silently.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Typing a room name in the panel beside the canvas must never re-arm
      // the delete cursor. `select` and contenteditable are here for the same
      // reason even though this page currently has neither — the guard is
      // about where focus IS, not about which fields happen to exist today.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Backspace still navigates back in some browser/OS configurations,
        // and this only EQUIPS the delete tool, so leaving the default in
        // place would throw the user off the page instead of arming a cursor.
        e.preventDefault();
        setTool("delete");
        return;
      }
      switch (e.key.toLowerCase()) {
        case "a":
          setTool("select");
          break;
        case "d":
          setTool("door");
          break;
        case "w":
          setTool("window");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Undo/redo for canvas interactions (room move/resize, opening add/
  // delete/move/resize) — NOT room-list actions like "Add room" or "Delete
  // room entirely", which stay outside this history, same as before this
  // feature existed. onInteractionStart snapshots `rooms` BEFORE a drag or
  // tool click mutates it; onCommit pushes that snapshot once the
  // interaction actually finishes — so one undo step = one user action,
  // not one step per pointermove frame during a drag.
  const [history, setHistory] = useState<Room[][]>([]);
  const [future, setFuture] = useState<Room[][]>([]);
  const pendingSnapshotRef = useRef<Room[] | null>(null);

  const handleInteractionStart = () => {
    pendingSnapshotRef.current = rooms;
  };
  const handleCommit = () => {
    const before = pendingSnapshotRef.current;
    pendingSnapshotRef.current = null;
    if (!before) return;
    setHistory((h) => [...h, before].slice(-HISTORY_LIMIT));
    setFuture([]);
  };
  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setFuture((f) => [...f, rooms]);
    setHistory((h) => h.slice(0, -1));
    setRooms(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[future.length - 1];
    setHistory((h) => [...h, rooms]);
    setFuture((f) => f.slice(0, -1));
    setRooms(next);
  };

  const referenceImage = imageFailed
    ? undefined
    : floorPlan?.meta?.storageKey
      ? `/api/render?key=${encodeURIComponent(floorPlan.meta.storageKey)}`
      : floorPlan?.previewUrl;

  /**
   * No image to trace over — the "No, not yet" entry point, and equally a
   * project whose stored plan image has gone for good (imageFailed above,
   * after the retry schedule). This is a MODE, not a dead end: it used to
   * render an empty state whose only action was "continue to the next
   * screen", which left a hand-entered project with no room shapes and no
   * placed openings, so its greybox could only ever be evenly-spaced
   * guesses. Same editor, same toolbar, same panels, empty grid behind.
   */
  const blankCanvas = !referenceImage;

  const placedRooms: EditorRoom[] = rooms
    .filter((r): r is Room & { shape: NonNullable<Room["shape"]> } => !!r.shape)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      shape: r.shape,
      placedOpenings: r.placedOpenings ?? [],
      widthFt: r.width ?? DEFAULT_ROOM_SIZE_FT,
      depthFt: r.height ?? DEFAULT_ROOM_SIZE_FT,
    }));
  const unplacedRooms = rooms.filter((r) => !r.shape);

  // Section 5's validateOpenings is otherwise only consumed downstream (the
  // Furnish gallery badge, the per-room Furnish editor's hard block) — this
  // is the one screen that can actually move an opening, so it needs to
  // surface violations too, or a user hits the Furnish block with nothing
  // here telling them what's wrong. Same `?? 10` fallback wallLengthFtFor
  // (plan-editor-canvas.tsx) uses, so the two never disagree about a room
  // whose real dimensions aren't known yet.
  const selectedRoom = placedRooms.find((r) => r.id === selectedId);
  const selectedRoomViolations = selectedRoom
    ? validateOpenings(selectedRoom.placedOpenings, selectedRoom.widthFt ?? 10, selectedRoom.depthFt ?? 10)
    : [];

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

  const commitRooms = () => {
    if (placedRooms.length === 0) return;
    const derived = deriveOpenings(placedRooms);
    const finalRooms = rooms.map((r) => (r.shape ? { ...r, openings: derived[r.id] ?? [] } : r));
    // applyPlanLayout is a no-op on a project with no floorPlan at all, which
    // is reachable in blank-canvas mode: the entry point seeds an empty plan
    // (floor-plan/page.tsx's goManual), but a hand-typed /plan URL on a draft
    // project does not. Seeding one here rather than silently discarding
    // everything the user just drew. setFloorPlan's reset of roomCards/
    // designSpec costs nothing in that case — a project with no plan has none.
    if (!floorPlan) {
      setFloorPlan(projectId, { ...emptyPlan(), rooms: finalRooms });
      return;
    }
    applyPlanLayout(projectId, finalRooms);
  };

  const proceed = () => {
    commitRooms();
    // The Plan pill's only signal — see Project.planConfirmedAt. Set HERE
    // rather than on mount, so opening the editor and navigating away without
    // finishing does not count, exactly as confirmRooms works one step later.
    // This is the single exit from the page (Continue and the confirmed Skip
    // both route through it), so one call covers both.
    confirmPlan(projectId);
    router.push(`/projects/${projectId}/review`);
  };

  // Blank-canvas mode only. Whatever the user did draw before changing their
  // mind is still committed — the flag turns the greybox step off, it is not
  // a reason to throw away rooms they already placed.
  const confirmSkip = () => {
    setPlanSkipped(projectId, true);
    proceed();
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">
            {blankCanvas ? "Draw your rooms & openings" : "Confirm room & opening placement"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {blankCanvas
              ? "There's no plan image for this project, so draw it here. Add a room, drag it and its handles to the size and position you want, then place its doors and windows on its walls. This is what makes the generated image put them in the same place."
              : "We've placed your rooms and their doors/windows automatically from the plan. Check they look right, drag anything that's off, and add or delete rooms/openings we missed. This is what makes the generated image put them in the same place."}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[auto_2.4fr_1fr] lg:gap-6">
          <div className="flex flex-row items-center gap-1 rounded-xl border border-border bg-surface p-1 lg:flex-col lg:items-stretch lg:self-start">
            <ToolButton icon="Move" label="Select" active={tool === "select"} onClick={() => setTool("select")} />
            <ToolButton
              icon="DoorClosed"
              label="Add door"
              active={tool === "door"}
              activeColor={DOOR_COLOR}
              onClick={() => setTool("door")}
            />
            <ToolButton
              icon="PanelsTopLeft"
              label="Add window"
              active={tool === "window"}
              activeColor={WINDOW_COLOR}
              onClick={() => setTool("window")}
            />
            <ToolButton
              icon="Trash2"
              label="Delete"
              active={tool === "delete"}
              activeColor="#e35c5c"
              onClick={() => setTool("delete")}
            />
            <div className="mx-1 w-px self-stretch bg-border lg:mx-0 lg:my-1 lg:h-px lg:w-auto" />
            <Button
              size="icon"
              variant="ghost"
              icon="Undo2"
              aria-label="Undo"
              title="Undo"
              disabled={history.length === 0}
              onClick={undo}
            />
            <Button
              size="icon"
              variant="ghost"
              icon="Redo2"
              aria-label="Redo"
              title="Redo"
              disabled={future.length === 0}
              onClick={redo}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div
              className="relative w-full overflow-hidden rounded-2xl border border-border bg-grid bg-surface"
              style={{ aspectRatio: blankCanvas ? BLANK_CANVAS_ASPECT : (aspect ?? 4 / 3) }}
            >
              {/* Blank-canvas mode is the SAME editor with nothing behind
                  it: bg-grid on the box above is the whole background, and
                  the transparent PlanEditorCanvas below draws on it exactly
                  as it does over a plan image. */}
              {referenceImage && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={imgAttempt}
                  src={referenceImage}
                  alt="Uploaded floor plan"
                  draggable={false}
                  className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
                  onError={() => {
                    if (imgAttempt >= IMG_RETRY_SCHEDULE_MS.length) {
                      setImageFailed(true);
                      return;
                    }
                    imgRetryRef.current = setTimeout(() => setImgAttempt((a) => a + 1), IMG_RETRY_SCHEDULE_MS[imgAttempt]);
                  }}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
                  }}
                />
              )}
              <PlanEditorCanvas
                rooms={placedRooms}
                selectedId={selectedId}
                tool={tool}
                onSelect={setSelectedId}
                onShapeChange={(roomId, shape) => patchRoom(roomId, { shape })}
                onOpeningsChange={(roomId, placedOpenings) => patchRoom(roomId, { placedOpenings })}
                onInteractionStart={handleInteractionStart}
                onCommit={handleCommit}
              />
            </div>

            {selectedRoomViolations.length > 0 && (
              <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
                <div className="flex items-start gap-3">
                  <Icon name="CircleAlert" className="mt-0.5 size-5 shrink-0 text-danger" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {selectedRoom?.name || "This room"}&apos;s doors and windows need fixing
                    </p>
                    <ul className="mt-3 space-y-1.5 text-sm text-muted">
                      {selectedRoomViolations.map((v, i) => (
                        <li key={i}>{v.message}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-surface p-3.5">
              <h3 className="text-sm font-semibold">Rooms</h3>
              <p className="mt-1 text-xs text-faint">
                {tool === "select" &&
                  "Drag a room to move it, its handles to resize, or a placed door/window to reposition it."}
                {tool === "door" && "Click any room's edge to add a door there."}
                {tool === "window" && "Click any room's edge to add a window there."}
                {tool === "delete" && "Click any door or window to remove it."}
              </p>
              <div className="mt-2 flex items-center gap-4 text-xs text-faint">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-7 shrink-0 rounded-full" style={{ background: DOOR_COLOR }} />
                  Door
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-7 shrink-0 rounded-full" style={{ background: WINDOW_COLOR }} />
                  Window
                </span>
              </div>
              <div className="scrollbar-thin mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {placedRooms.map((r) => {
                  const doors = r.placedOpenings.filter((o) => o.type === "door").length;
                  const windows = r.placedOpenings.filter((o) => o.type === "window").length;
                  const violations = validateOpenings(r.placedOpenings, r.widthFt ?? 10, r.depthFt ?? 10);
                  return (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setSelectedId(r.id);
                      }}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                        r.id === selectedId ? "bg-accent/15 text-accent" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                      <span className="min-w-0 flex-1 truncate font-medium">{r.name || "Room"}</span>
                      <span className="shrink-0 text-faint">
                        {doors}D · {windows}W
                      </span>
                      {violations.length > 0 && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-danger/30 bg-danger px-1.5 py-0.5 text-[10px] font-medium text-white"
                          title="This room's doors/windows need fixing before it can be furnished"
                        >
                          <Icon name="CircleAlert" className="size-3" />
                          Fix openings
                        </span>
                      )}
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
                    </div>
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

            <div className="rounded-2xl border border-border bg-surface p-3.5">
              <h3 className="text-sm font-semibold">Keyboard shortcuts</h3>
              <dl className="mt-2.5 space-y-2">
                {SHORTCUTS.map((s) => (
                  <div key={s.label} className="flex items-center gap-2 text-xs">
                    <dt className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground"
                        >
                          {k}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="min-w-0 flex-1 text-faint">{s.label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>

        {/* Skip is offered ONLY on the blank-canvas path. With a real plan
            image in hand this step is mandatory: everything the greybox needs
            is right there on screen, so skipping it would throw away accuracy
            the user has already paid for by uploading. */}
        {blankCanvas && skipConfirming && (
          <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-xs text-warning">
            <Icon name="CircleAlert" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Skipping means the 3D greybox render step is skipped, sacrificing accuracy and the ability to
              customise furniture and its positions.
            </span>
            <button
              onClick={confirmSkip}
              className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
            >
              Skip anyway
            </button>
            <button
              onClick={() => setSkipConfirming(false)}
              className="cursor-pointer text-faint hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          {blankCanvas ? (
            <Button variant="ghost" onClick={() => setSkipConfirming(true)}>
              Skip for now
            </Button>
          ) : (
            <span />
          )}
          <Button iconRight="ArrowRight" onClick={proceed}>
            Continue to Room Confirmation
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToolButton({
  icon,
  label,
  active,
  activeColor,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  /** Tints the active state with the tool's own colour (door/window/delete) instead of the
   *  generic accent — so the toolbar itself previews what the cursor will look like. */
  activeColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex size-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg text-xs font-medium transition-colors lg:h-9 lg:w-full lg:justify-start lg:px-2.5 ${
        active ? "bg-surface-2" : "text-faint hover:bg-surface-2 hover:text-foreground"
      }`}
      style={active && activeColor ? { color: activeColor } : undefined}
    >
      <Icon name={icon} className="size-4 shrink-0" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
