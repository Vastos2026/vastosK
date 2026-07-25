"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { STYLES, STYLE_BY_ID, CATALOG, FURNITURE_CATEGORIES } from "@/lib/data";
import { generateRender as apiGenerateRender } from "@/lib/render-client";
import { suggestFurnitureAI } from "@/lib/suggest-furniture-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RenderStatusBadge } from "@/components/ui/badge";
import { cn, timeAgo, uid } from "@/lib/utils";
import { fitViolations, roundFt as r1 } from "@/lib/furniture-fit";
import {
  detectRoomFeatures,
  isGenericRoomName,
  printedRoomBox,
  toRoomRecords,
} from "@/lib/detect-room-client";
import {
  DEFAULT_WINDOW_LEN,
  onRoomPerimeter,
  toLocalDoor,
  toLocalWindow,
  type WallSnap,
} from "@/lib/openings";
import { PlanEditor } from "@/components/project/plan-editor";
import { OpeningEditor } from "@/components/project/opening-editor";
import type { CaptureFn } from "@/components/project/scene-3d";
import type { PlacedItem } from "@/lib/types";

const Scene3D = dynamic(() => import("@/components/project/scene-3d"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-muted">
      <Icon name="Box" className="size-7 animate-pulse text-accent" />
    </div>
  ),
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Room render = ONE photo, the FRONT view (Nano Banana, the general dimensional
// prompt + the selected style). The orbit VIDEO + the Left/Right/Back frames are a
// SEPARATE, later step the user triggers on the render page AFTER lasso-editing the
// front photo (so the video is built from the FINAL front image). See room-video.ts.

// Stable seed per room so the front photo renders the SAME design each time.
function seedFromRoom(roomId: string): number {
  let h = 0;
  for (const c of roomId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2_000_000_000;
}

/** Read an image File, downscale to <=max px, and return a JPEG data URL. */
function downscaleImageFile(file: File, max = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return reject(new Error("empty"));
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export default function RoomDesignPage() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  const project = useProject(id);
  const addItem = useVasto((s) => s.addItem);
  const removeItem = useVasto((s) => s.removeItem);
  const updateItem = useVasto((s) => s.updateItem);
  const updateRoom = useVasto((s) => s.updateRoom);
  const setStyle = useVasto((s) => s.setStyle);
  const addRender = useVasto((s) => s.addRender);
  const updateRender = useVasto((s) => s.updateRender);
  const addRenderVersion = useVasto((s) => s.addRenderVersion);
  const setStatus = useVasto((s) => s.setStatus);
  const setRoomCapture = useVasto((s) => s.setRoomCapture);
  const addDoor = useVasto((s) => s.addDoor);
  const updateDoor = useVasto((s) => s.updateDoor);
  const removeDoor = useVasto((s) => s.removeDoor);
  const addWindow = useVasto((s) => s.addWindow);
  const updateWindow = useVasto((s) => s.updateWindow);
  const removeWindow = useVasto((s) => s.removeWindow);

  const [busy, setBusy] = useState(false);
  const [mode2d, setMode2d] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOpeningId, setSelectedOpeningId] = useState<string | null>(null);
  // Per-furniture reference images (itemId → {url,name}); the render makes each
  // piece match its reference. Per-session (not persisted).
  // Reference images live in the store so they survive in-app navigation
  // (rooms → render → back) instead of resetting; kept in memory, not persisted.
  const itemRefs = useVasto((s) => s.itemRefs) ?? {};
  const roomRefs = useVasto((s) => s.roomRefs) ?? {};
  const setItemRef = useVasto((s) => s.setItemRef);
  const setRoomRef = useVasto((s) => s.setRoomRef);
  const refTargetRef = useRef<string | null>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const roomRefInputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<CaptureFn | null>(null);

  if (!project) return null;
  const room = project.floorPlan?.rooms.find((r) => r.id === roomId);
  if (!project.floorPlan || !room) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-7 text-muted" />
          <p className="mt-3 text-sm text-muted">Room not found.</p>
          <Link href={`/projects/${id}/rooms`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">Back to rooms</Button>
          </Link>
        </div>
      </div>
    );
  }

  const plan = project.floorPlan;
  // Persisted on the room (not page state) so a reload can't silently drop the
  // brief mid-design — losing it degraded renders with no visible cause.
  const brief = room.brief ?? "";
  const style = STYLE_BY_ID[project.styleId ?? ""] ?? STYLES[0];
  const roomItems = project.placedItems.filter((it) => it.roomId === room.id && !it.ghost);
  const roomRenders = project.renders.filter((r) => r.roomId === room.id);
  // Crowding check: the summed floor footprint of the furniture vs the room's
  // floor area. Over 100% means the pieces can't all sit flat without
  // overlapping — the aggregate version of the per-piece fit check.
  const roomArea = room.width * room.height;
  const usedFootprint = roomItems.reduce((sum, it) => sum + it.w * it.d, 0);
  const overcrowded = roomArea > 0 && usedFootprint > roomArea + 0.05;
  const roomRef = roomRefs[roomId] ?? null;

  // Doors + windows on THIS room's walls, in room-local coords for the 2D editor.
  // An opening belongs to the room when it sits on its perimeter; edits translate
  // back to plan space (add room.x/room.y) before persisting.
  const roomDoors = plan.doors.filter((d) => onRoomPerimeter(d.x, d.y, room)).map((d) => toLocalDoor(d, room));
  const roomWindows = (plan.windows ?? [])
    .filter((w) => onRoomPerimeter(w.x, w.y, room))
    .map((w) => toLocalWindow(w, room));

  const onChangeDoor = (doorId: string, s: WallSnap) =>
    updateDoor(id, doorId, { x: r1(s.x + room.x), y: r1(s.y + room.y), orientation: s.orientation });
  const onChangeWindow = (winId: string, s: WallSnap) =>
    updateWindow(id, winId, { x: r1(s.x + room.x), y: r1(s.y + room.y), orientation: s.orientation });

  // New openings land centred on the room's FRONT (top) wall, then the user drags
  // them wherever they belong. Plan coords = room origin + local wall position.
  const placeDoor = () => {
    const newId = uid("door");
    addDoor(id, { id: newId, x: r1(room.x + room.width / 2), y: r1(room.y), orientation: "h" });
    setSelectedOpeningId(newId);
  };
  const placeWindow = () => {
    const newId = uid("win");
    addWindow(id, {
      id: newId,
      x: r1(room.x + room.width / 2),
      y: r1(room.y),
      orientation: "h",
      length: DEFAULT_WINDOW_LEN,
    });
    setSelectedOpeningId(newId);
  };
  const selectedOpeningIsWindow = roomWindows.some((w) => w.id === selectedOpeningId);
  const deleteSelectedOpening = () => {
    if (!selectedOpeningId) return;
    if (selectedOpeningIsWindow) removeWindow(id, selectedOpeningId);
    else removeDoor(id, selectedOpeningId);
    setSelectedOpeningId(null);
  };

  // Attach a downscaled reference image to the furniture item in refTargetRef.
  const onPickItemRef = (file?: File) => {
    const targetId = refTargetRef.current;
    if (!file || !targetId) return;
    if (!file.type.startsWith("image/")) return setError("Reference must be an image (PNG/JPG/WebP).");
    if (file.size > 10 * 1024 * 1024) return setError("Reference image is too large (max 10 MB).");
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        let url = dataUrl;
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          url = canvas.toDataURL("image/jpeg", 0.85);
        }
        setItemRef(targetId, { url, name: file.name });
      };
      img.onerror = () => setItemRef(targetId, { url: dataUrl, name: file.name });
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const removeItemRef = (itemId: string) => setItemRef(itemId, null);

  // Whole-room reference image (guides the overall render look).
  const onPickRoomRef = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Reference must be an image (PNG/JPG/WebP).");
    if (file.size > 10 * 1024 * 1024) return setError("Reference image is too large (max 10 MB).");
    try {
      const url = await downscaleImageFile(file);
      setRoomRef(roomId, { url, name: file.name });
      setError(null);
    } catch {
      setError("Couldn't read that image.");
    }
  };

  const addFromCatalog = (catalogId: string) => {
    const c = CATALOG.find((x) => x.id === catalogId);
    if (!c) return;
    const item = {
      id: uid("pi"),
      catalogId,
      name: c.name,
      roomId: room.id,
      x: clamp(room.x + room.width / 2 - c.w / 2, room.x, Math.max(room.x, room.x + room.width - c.w)),
      y: clamp(room.y + room.height / 2 - c.d / 2, room.y, Math.max(room.y, room.y + room.height - c.d)),
      rotation: 0,
      w: c.w,
      d: c.d,
      h: c.h,
      color: c.color,
    };
    addItem(id, item);
    setSelectedId(item.id);
  };

  /**
   * Read what's actually DRAWN in this room on the original plan image: crop the
   * source to this room and let vision report its doors/windows/furniture PLUS
   * the room's printed label ("BEDROOM 12'3\"X9'1\""). The printed size is the
   * architect's own number — it replaces the eroded pixel-box dimensions (which
   * ran ~1-1.5 ft short on real uploads, skewing every placement), and generic
   * parser names ("Room 4") take the printed name. Detection REPLACES this
   * room's previous parse contents — it's a re-read of the room, and stacking
   * both copies would double every piece. Everything stays editable after.
   */
  const detectFromPlan = async () => {
    if (detecting) return;
    const m = plan.meta;
    if (!m?.storageKey || !m.ftPerPxX || !m.ftPerPxY || m.originPxX === undefined || m.originPxY === undefined) {
      setError(
        "This plan was imported before per-room detection existed, so it has no link back to its source image. Re-import the plan to enable it.",
      );
      return;
    }
    setDetecting(true);
    setError(null);
    try {
      const { items: found, label } = await detectRoomFeatures({
        storageKey: m.storageKey,
        originPxX: m.originPxX,
        originPxY: m.originPxY,
        ftPerPxX: m.ftPerPxX,
        ftPerPxY: m.ftPerPxY,
        imageWidth: m.imageWidth,
        imageHeight: m.imageHeight,
        room: { x: room.x, y: room.y, width: room.width, height: room.height, name: room.name, type: room.type },
      });

      // 1) The room's printed truth: correct the box to the printed size (centre
      //    kept) and adopt the printed name over a generic "Room N".
      const corrected = printedRoomBox(room, label);
      const rename = label.name && isGenericRoomName(room.name) ? label.name : undefined;
      const patch: Partial<typeof room> = { ...(corrected ?? {}), ...(rename ? { name: rename } : {}) };
      if (Object.keys(patch).length) updateRoom(id, room.id, patch);
      const box = { ...room, ...(corrected ?? {}) };

      const rec = toRoomRecords(found, box);
      const n = rec.doors.length + rec.windows.length + rec.items.length;
      if (!n && !corrected && !rename) {
        setError("Nothing detected in this room — the plan may not draw furniture or openings here.");
        return;
      }
      // 2) Replace, don't stack: this room's previous furniture and perimeter
      //    openings came from the same plan and are superseded by this re-read.
      if (n) {
        roomItems.forEach((it) => removeItem(id, it.id));
        (plan.doors ?? []).filter((d) => onRoomPerimeter(d.x, d.y, box)).forEach((d) => removeDoor(id, d.id));
        (plan.windows ?? []).filter((w) => onRoomPerimeter(w.x, w.y, box)).forEach((w) => removeWindow(id, w.id));
        rec.doors.forEach((d) => addDoor(id, d));
        rec.windows.forEach((w) => addWindow(id, w));
        rec.items.forEach((it) => addItem(id, it));
        setMode2d(true); // show what landed, ready to adjust
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setDetecting(false);
    }
  };

  const suggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const ghosts = await suggestFurnitureAI({ ...plan, rooms: [room] }, style.name);
      if (ghosts?.length) ghosts.forEach((g) => addItem(id, { ...g, ghost: false }));
    } catch {
      /* best-effort */
    } finally {
      setSuggesting(false);
    }
  };

  // Per-room render — render ONLY the FRONT photo (Nano Banana) from the general
  // dimensional prompt + the selected style. The orbit VIDEO and the Left/Right/Back
  // frames are a SEPARATE step the user triggers on the render page AFTER lasso-editing
  // this front photo, so the video is built from the FINAL front image.
  const generate = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(id, "rendered");

    const seed = seedFromRoom(room.id);
    const frontImage = captureRef.current?.("front") ?? undefined;
    // Stash the LEFT/RIGHT/BACK wall 3D screenshots now (only this page has the 3D
    // scene). The render page derives those squared-up stills from them — each
    // screenshot is the exact camera, the edited front is the style reference.
    setRoomCapture(room.id, {
      left: captureRef.current?.("left") ?? undefined,
      right: captureRef.current?.("right") ?? undefined,
      back: captureRef.current?.("back") ?? undefined,
    });
    const frontId = uid("rnd");
    addRender(id, {
      id: frontId,
      view: "front",
      styleId: style.id,
      roomId: room.id,
      status: "processing",
      createdAt: new Date().toISOString(),
      progress: 0,
      versions: [],
    });

    const references = roomItems
      .filter((it) => itemRefs[it.id])
      .map((it) => ({ label: it.name, image: itemRefs[it.id].url }));

    void (async () => {
      try {
        const front = await apiGenerateRender({
          projectId: id,
          view: "front",
          style,
          propertyType: project.propertyType,
          plan: { ...plan, rooms: [room] },
          items: roomItems,
          image: frontImage,
          seed,
          notes: brief.trim() || undefined,
          references: references.length ? references : undefined,
          styleRef: roomRef?.url,
          noFluxFallback: true,
        });
        addRenderVersion(id, frontId, {
          id: uid("v"),
          label: "v1",
          createdAt: new Date().toISOString(),
          note: `${room.name} · Front`,
          styleId: style.id,
          imageUrl: front.imageUrl,
          imageKey: front.key,
          prompt: front.prompt,
          checklist: front.checklist,
          extras: front.extras,
        });
        updateRender(id, frontId, { status: "completed", progress: 100 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Front render failed";
        updateRender(id, frontId, { status: "failed", error: msg });
        setError(msg);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex h-full">
      {/* Room viewport — 3D (always mounted: it provides the capture for the front
          render) with an optional 2D top-down plan overlaid for furniture dragging. */}
      <div className="relative min-w-0 flex-1 bg-bg">
        <Scene3D
          plan={plan}
          items={roomItems}
          style={style}
          selectedId={selectedId}
          onSelectItem={setSelectedId}
          captureRef={captureRef}
          focusRoom={{ x: room.x, y: room.y, width: room.width, height: room.height, ceilingFt: room.ceilingFt }}
        />

        {/* 2D plan: drag furniture on the X/Y plane within this room (like 2D Review
            does for rooms). Coords are room-local here, translated back on change.
            The OpeningEditor overlays doors + windows on the same viewBox. */}
        {mode2d && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-bg p-8">
            {/* opening toolbar — bottom-centred so it clears the room-size pill
                (top) and the All-rooms / 3D-2D controls (top corners). */}
            <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-xl border border-border bg-surface/90 px-2 py-1.5 backdrop-blur">
              <button
                onClick={placeDoor}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/60 hover:text-accent cursor-pointer"
              >
                <Icon name="DoorClosed" className="size-3.5" /> Add door
              </button>
              <button
                onClick={placeWindow}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/60 hover:text-accent cursor-pointer"
              >
                <Icon name="Frame" className="size-3.5" /> Add window
              </button>
              {selectedOpeningId && (
                <button
                  onClick={deleteSelectedOpening}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 cursor-pointer"
                >
                  <Icon name="Trash2" className="size-3.5" /> Delete {selectedOpeningIsWindow ? "window" : "door"}
                </button>
              )}
            </div>
            <div className="relative aspect-square h-full max-h-full w-auto max-w-full">
              <PlanEditor
                plan={{
                  ...plan,
                  planWidth: Math.max(2, room.width),
                  planHeight: Math.max(2, room.height),
                  rooms: [{ ...room, x: 0, y: 0 }],
                  doors: [],
                  walls: [],
                  windows: [],
                }}
                selectedId={null}
                onSelect={() => {}}
                onChangeRoom={() => {}}
                items={roomItems.map((it) => ({
                  ...it,
                  x: Math.round((it.x - room.x) * 10) / 10,
                  y: Math.round((it.y - room.y) * 10) / 10,
                }))}
                selectedItemId={selectedId}
                onSelectItem={setSelectedId}
                onChangeItem={(itemId, patch) => {
                  const p: Partial<PlacedItem> = {};
                  if (typeof patch.x === "number") p.x = Math.round((patch.x + room.x) * 10) / 10;
                  if (typeof patch.y === "number") p.y = Math.round((patch.y + room.y) * 10) / 10;
                  if (Object.keys(p).length) updateItem(id, itemId, p);
                }}
              />
              <OpeningEditor
                planWidth={Math.max(2, room.width)}
                planHeight={Math.max(2, room.height)}
                doors={roomDoors}
                windows={roomWindows}
                selectedId={selectedOpeningId}
                onSelect={setSelectedOpeningId}
                onChangeDoor={onChangeDoor}
                onChangeWindow={onChangeWindow}
              />
            </div>
          </div>
        )}

        <Link
          href={`/projects/${id}/rooms`}
          className="absolute left-4 top-4 z-30 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-3 py-1.5 text-xs font-medium backdrop-blur hover:bg-surface-2"
        >
          <Icon name="ArrowLeft" className="size-3.5" /> All rooms
        </Link>

        {/* 3D / 2D toggle */}
        <div className="absolute right-4 top-4 z-30 flex overflow-hidden rounded-lg border border-border bg-surface/80 text-xs backdrop-blur">
          <button
            onClick={() => setMode2d(false)}
            className={cn("cursor-pointer px-2.5 py-1.5", !mode2d ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-2")}
          >
            3D
          </button>
          <button
            onClick={() => setMode2d(true)}
            className={cn("cursor-pointer px-2.5 py-1.5", mode2d ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-2")}
          >
            2D plan
          </button>
        </div>

        <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-xl border border-border bg-surface/80 px-3 py-1.5 text-xs backdrop-blur">
          <span className="font-medium">{room.name}</span>
          <span className="text-muted"> · {Math.round(room.width)} × {Math.round(room.height)} ft{mode2d ? " · drag furniture, doors & windows" : ""}</span>
        </div>
      </div>

      {/* Right panel */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          {/* Design style — choose the look this room is rendered in. */}
          <div className="mb-4">
            <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Design style
            </p>
            <select
              value={project.styleId ?? style.id}
              onChange={(e) => setStyle(id, e.target.value)}
              className="input w-full cursor-pointer"
            >
              {STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="mt-1.5 flex h-4 overflow-hidden rounded">
              {style.palette.map((c, i) => (
                <div key={i} className="flex-1" style={{ background: c }} />
              ))}
            </div>
            <p className="mt-1 px-1 text-[11px] text-faint">{style.tagline}</p>
          </div>

          {/* Ceiling height — feeds the render dimensions + the 3D wall height
              (was hardcoded to 9 ft). */}
          <div className="mb-4">
            <label className="mb-1.5 block px-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Ceiling height (ft)
            </label>
            <input
              type="number"
              min={6}
              max={20}
              step={0.5}
              value={room.ceilingFt ?? 9}
              onChange={(e) =>
                updateRoom(id, room.id, { ceilingFt: Math.max(6, Math.min(20, Number(e.target.value) || 9)) })
              }
              className="input w-full"
            />
            <p className="mt-1 px-1 text-[11px] text-faint">
              Used for the rendered ceiling + the room&apos;s 3D walls. Default 9 ft.
            </p>
          </div>

          {/* Optional design brief — when given, it leads the render prompt. */}
          <div className="mb-4">
            <label className="mb-1.5 block px-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Design brief <span className="font-normal normal-case text-faint">(optional)</span>
            </label>
            <textarea
              value={brief}
              onChange={(e) => updateRoom(id, room.id, { brief: e.target.value })}
              rows={3}
              placeholder="Describe the look, e.g. “warm teak panelling, brass accents, indirect cove lighting, a reading nook by the window”."
              className="input w-full resize-none text-sm"
            />
            <p className="mt-1 px-1 text-[11px] text-faint">If filled in, the renders follow it.</p>
          </div>

          {/* Whole-room reference image — guides the overall render look. Always
              available (the per-piece refs below need furniture placed first). */}
          <div className="mb-4">
            <label className="mb-1.5 block px-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Reference image <span className="font-normal normal-case text-faint">(optional)</span>
            </label>
            <input
              ref={roomRefInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                onPickRoomRef(e.target.files?.[0]);
                if (roomRefInputRef.current) roomRefInputRef.current.value = "";
              }}
            />
            {roomRef ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={roomRef.url}
                  alt=""
                  className="size-12 shrink-0 rounded object-cover ring-1 ring-accent/50"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{roomRef.name}</span>
                <button
                  onClick={() => setRoomRef(roomId, null)}
                  className="text-danger hover:opacity-80 cursor-pointer"
                  aria-label="Remove reference image"
                >
                  <Icon name="Trash2" className="size-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => roomRefInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-accent cursor-pointer"
              >
                <Icon name="ImagePlus" className="size-4" /> Add reference image
              </button>
            )}
            <p className="mt-1 px-1 text-[11px] text-faint">
              The render matches this room&apos;s overall style, materials &amp; mood to it.
            </p>
          </div>

          {/* Read what the PLAN actually draws for this room (openings + any
              furniture). Distinct from "Suggest furniture", which INVENTS a
              layout — this one only reports what's really on the drawing. */}
          <Button
            className="mb-2 w-full"
            variant="secondary"
            icon="Eye"
            onClick={detectFromPlan}
            loading={detecting}
            disabled={detecting || !plan.meta?.storageKey}
          >
            {detecting ? "Reading the plan…" : "Detect from plan (AI)"}
          </Button>
          <p className="mb-3 px-1 text-[11px] text-faint">
            Finds the doors, windows &amp; furniture actually drawn in this room on the
            uploaded plan, then you fine-tune them in 2D.
          </p>

          <Button
            className="w-full"
            variant="secondary"
            icon="Wand2"
            onClick={suggest}
            loading={suggesting}
            disabled={suggesting}
          >
            {suggesting ? "Designing…" : "Suggest furniture (AI)"}
          </Button>

          {roomItems.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                In this room · {roomItems.length}
              </p>
              <p className="mb-1.5 px-1 text-[11px] text-faint">
                Tap a piece to resize it (W/D/H) or add a reference image.
              </p>
              {overcrowded && (
                <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
                  <Icon name="CircleAlert" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Furniture floor area ({r1(usedFootprint)} ft²) exceeds this room (
                    {r1(roomArea)} ft²) — pieces will overlap. Remove or shrink some to fit.
                  </span>
                </div>
              )}
              {/* one hidden picker, targeted at whichever item's button was clicked */}
              <input
                ref={refInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  onPickItemRef(e.target.files?.[0]);
                  if (refInputRef.current) refInputRef.current.value = "";
                }}
              />
              <div className="space-y-1">
                {roomItems.map((it) => {
                  const ref = itemRefs[it.id];
                  const violations = fitViolations(it, room);
                  const overDims = new Set(violations.map((v) => v.dim));
                  return (
                    <div key={it.id}>
                      <div
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm",
                          it.id === selectedId ? "bg-accent/10" : "hover:bg-surface-2",
                        )}
                      >
                        <button
                          onClick={() => setSelectedId(it.id === selectedId ? null : it.id)}
                          className="flex min-w-0 items-center gap-2 text-left cursor-pointer"
                        >
                          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: it.color }} />
                          <span className="truncate">{it.name}</span>
                          {violations.length > 0 && (
                            <span
                              className="inline-flex shrink-0"
                              title={`Too big for the room — ${violations
                                .map((v) => `${v.full.toLowerCase()} exceeds ${v.against}`)
                                .join(", ")}`}
                            >
                              <Icon name="CircleAlert" className="size-3.5 text-warning" />
                            </span>
                          )}
                        </button>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {ref ? (
                            <button
                              onClick={() => removeItemRef(it.id)}
                              title={`Reference: ${ref.name} — click to remove`}
                              className="relative cursor-pointer"
                              aria-label={`Remove reference for ${it.name}`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={ref.url}
                                alt=""
                                className="size-6 rounded object-cover ring-1 ring-accent/60"
                              />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                refTargetRef.current = it.id;
                                refInputRef.current?.click();
                              }}
                              title={`Add reference image for ${it.name}`}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/60 hover:text-accent cursor-pointer"
                              aria-label={`Add reference image for ${it.name}`}
                            >
                              <Icon name="ImagePlus" className="size-3.5" /> Ref
                            </button>
                          )}
                          <button
                            onClick={() => removeItem(id, it.id)}
                            className="text-danger hover:opacity-80 cursor-pointer"
                            aria-label={`Remove ${it.name}`}
                          >
                            <Icon name="Trash2" className="size-3.5" />
                          </button>
                        </div>
                      </div>
                      {/* Dimension editor for the selected piece — the same W/D/H
                          controls as 2D Review, so furniture can be resized here
                          too. Updates flow to the 3D scene live. */}
                      {it.id === selectedId && (
                        <div className="mb-1 mt-1 rounded-lg bg-surface-2 px-2.5 py-2">
                          <div className="grid grid-cols-3 gap-2">
                            {(["w", "d", "h"] as const).map((dim) => (
                              <label key={dim} className="block">
                                <span className="mb-1 block text-[10px] uppercase tracking-wide text-faint">
                                  {dim} (ft){dim === "h" && " · ceiling"}
                                </span>
                                <input
                                  type="number"
                                  min={0.5}
                                  step={0.5}
                                  value={it[dim]}
                                  onChange={(e) =>
                                    updateItem(id, it.id, { [dim]: Number(e.target.value) || 0 })
                                  }
                                  aria-invalid={overDims.has(dim)}
                                  className={cn(
                                    "input w-full",
                                    overDims.has(dim) &&
                                      "border-warning text-warning focus:border-warning",
                                  )}
                                />
                              </label>
                            ))}
                          </div>
                          {violations.length > 0 && (
                            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
                              <Icon name="CircleAlert" className="mt-0.5 size-3.5 shrink-0" />
                              <span>
                                {violations
                                  .map(
                                    (v) =>
                                      `${v.full} ${r1(v.value)} ft exceeds ${v.against} ${r1(v.limit)} ft`,
                                  )
                                  .join("; ")}
                                . It won&apos;t fit — reduce it to place the piece correctly.
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-4">
            <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">Add furniture</p>
            <div className="space-y-3">
              {FURNITURE_CATEGORIES.map((cat) => {
                const items = CATALOG.filter((c) => c.category === cat.id);
                if (!items.length) return null;
                return (
                  <div key={cat.id}>
                    <p className="mb-1.5 px-1 text-[11px] text-faint">{cat.label}</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {items.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => addFromCatalog(c.id)}
                          title={c.name}
                          className="group flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface-2 p-1 text-center transition-colors hover:border-accent/50 hover:bg-surface-3 cursor-pointer"
                        >
                          <Icon name={c.icon} className="size-5 text-muted group-hover:text-accent" />
                          <span className="line-clamp-2 text-[10px] leading-tight text-muted">{c.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {roomRenders.length > 0 && (
            <div className="mt-5">
              <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                Renders · {roomRenders.length}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {roomRenders.map((r) => {
                  const img = r.versions.at(-1)?.imageUrl;
                  const isVideo = !!img && img.includes(".mp4");
                  const card = (
                    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
                      <div className="relative aspect-[4/3] bg-grid bg-bg">
                        {img && isVideo ? (
                          <video src={img} className="absolute inset-0 h-full w-full object-cover" muted loop autoPlay playsInline />
                        ) : img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={img} alt="render" className="absolute inset-0 h-full w-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 grid place-items-center">
                            <RenderStatusBadge status={r.status} />
                          </div>
                        )}
                      </div>
                      <p className="px-2 py-1 text-[11px] text-muted">{timeAgo(r.createdAt)}</p>
                    </div>
                  );
                  return r.status === "completed" ? (
                    <Link key={r.id} href={`/projects/${id}/renders/${r.id}`}>{card}</Link>
                  ) : (
                    <div key={r.id}>{card}</div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border p-4">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}
          <Button className="w-full" icon="Camera" onClick={generate} loading={busy} disabled={busy}>
            {busy ? "Rendering front view…" : "Render front view"}
          </Button>
          <p className="mt-2 text-center text-[11px] text-faint">
            Renders the FRONT photo from the room&apos;s real dimensions. Open it, fine-tune
            with the lasso, then generate the walkthrough video (Left / Right / Back) there.
          </p>
        </div>
      </aside>
    </div>
  );
}
