"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useSyncExternalStore } from "react";
import type {
  Door,
  PlacedOpening,
  Project,
  ProjectStatus,
  PropertyType,
  Room,
  RoomCard,
  RoomGeneration,
  Walkthrough,
  Window,
} from "./types";
import { uid } from "./utils";
import { STANDARD_DOOR_WIDTH_FT, STANDARD_WINDOW_WIDTH_FT } from "./plan-editor/geometry";

interface VastoState {
  projects: Project[];

  createProject: (name: string, propertyType: PropertyType) => string;
  deleteProject: (id: string) => void;
  /** Wipes every project — irreversible, gated behind a confirm dialog in the UI. */
  clearAllProjects: () => void;
  /** Merge projects pulled from Supabase; a remote project wins only if newer. */
  importProjects: (incoming: Project[]) => void;
  getProject: (id: string) => Project | undefined;
  patchProject: (id: string, patch: Partial<Project>) => void;

  setFloorPlan: (id: string, plan: Project["floorPlan"]) => void;
  /**
   * Bulk-replaces the plan's room list — the Plan Editor's "Continue".
   * Unlike setFloorPlan, this does NOT reset roomCards/designSpec/
   * universalInput/walkthrough: a user can revisit Plan after Generate has
   * already run (e.g. fixing one missed opening), and that must not wipe
   * paid generation work just because room geometry changed.
   */
  applyPlanLayout: (id: string, rooms: Room[]) => void;
  updateRoom: (id: string, roomId: string, patch: Partial<Room>) => void;
  setRoomGreybox: (
    id: string,
    roomId: string,
    patch: Pick<
      Room,
      "furniture" | "greyboxKey" | "greyboxMaskKey" | "greyboxAnnotatedKey" | "greyboxHash" | "greyboxLedger"
    >,
  ) => void;
  /** Append a room to the plan. */
  addRoom: (id: string, room: Room) => void;
  /** Delete a room from the plan (Room Confirmation's room-list edit) and its generation history. */
  removeRoom: (id: string, roomId: string) => void;
  /** Change a room's width/height (Room Confirmation's edit-size field). */
  resizeRoom: (id: string, roomId: string, size: { width?: number; height?: number }) => void;
  /** Set the number of door/window openings on a room (Room Confirmation's editable count field) — pads with generic entries or truncates from the end. */
  setOpeningCount: (id: string, roomId: string, kind: "door" | "window", count: number) => void;
  /**
   * Marks that the user has actually confirmed their room list — sets
   * `Project.roomsConfirmedAt` to now. Called only from Room Confirmation's
   * Continue handler (review/page.tsx's `goToFurnish`), never on mount, so
   * merely visiting Room Confirmation without proceeding does not count as
   * confirmed. `computeDoneMap` in workspace-frame.tsx is the reader.
   */
  confirmRooms: (id: string) => void;
  /**
   * The Plan Editor's equivalent — sets `Project.planConfirmedAt` to now.
   * Called only from plan/page.tsx's `proceed()`, which is the single exit
   * from that page (both Continue and the confirmed Skip route through it),
   * never on mount. Its own entry point rather than a `patchProject` call at
   * the call site, for the same reason `confirmRooms` and `setPlanSkipped`
   * are: one named, greppable place per stepper signal.
   */
  confirmPlan: (id: string) => void;
  /**
   * Sets/clears `Project.planSkipped` — the Plan Editor's confirmed skip on
   * the blank-canvas path, and the Yes answer to "you skipped this page, do
   * you want to plan again?" that clears it again. Its own setter rather
   * than a `patchProject` call at each site because both call sites are
   * about the SAME flag and every downstream reader (the stepper's Furnish
   * pill, Review's Continue target, both generation paths' greybox calls)
   * keys off it — a single named entry point is what makes that greppable.
   */
  setPlanSkipped: (id: string, skipped: boolean) => void;
  setStatus: (id: string, status: ProjectStatus) => void;
  setStyle: (id: string, styleId: string) => void;
  /** Persists a Design Planning run's result (revamp Workstream 8): the global
   *  design selections plus the cached Universal Input + Design Specification
   *  every room's render prompt is built from. */
  setDesignPlan: (
    id: string,
    plan: Pick<
      Project,
      "subcategory" | "luxuryLevel" | "colourPalette" | "customColourHexes" | "designReference" | "additionalRequirements" | "universalInput" | "designSpec" | "designSignature"
    >,
  ) => void;

  /** Doors/windows ("openings") on the plan's walls. */
  addDoor: (id: string, door: Door) => void;
  updateDoor: (id: string, doorId: string, patch: Partial<Door>) => void;
  removeDoor: (id: string, doorId: string) => void;
  addWindow: (id: string, win: Window) => void;
  updateWindow: (id: string, winId: string, patch: Partial<Window>) => void;
  removeWindow: (id: string, winId: string) => void;

  /** Room Generation Gallery — appends a new version, creating the room's card on first call. */
  addGeneration: (id: string, roomId: string, generation: RoomGeneration) => void;
  /** Final Image Selection — mark one generation as this room's approved image. */
  setApproved: (id: string, roomId: string, generationId: string) => void;
  /** Final Image Selection — include/exclude a room from the walkthrough. */
  setIncluded: (id: string, roomId: string, included: boolean) => void;
  /** Walkthrough screen — full replace (generating/completed/failed states). */
  setWalkthrough: (id: string, walkthrough: Walkthrough) => void;

  /** In-flight generation COUNT per room, per project — projectId -> roomId
   *  -> number of generations currently running for that room. Was a deduped
   *  `Record<string, string[]>` (room id present or absent, i.e. a boolean),
   *  which could not represent "Generate More" firing a second generation on
   *  a room that already has one in flight (from Design's auto-fire loop, or
   *  a previous Generate More click, or "Adjust with 3D"'s Save+Generate).
   *  Included in `partialize` below so the shape round-trips through storage
   *  cleanly, but reset to empty on every rehydration — see the
   *  `onRehydrateStorage` comment for why a flag that survives a real reload
   *  can never be trusted anyway. Client-side (soft) navigation between pages
   *  never touches this at all — the store is a module-level singleton, so
   *  plain in-memory state already survives route changes with no
   *  persistence involved. */
  generatingRoomIds: Record<string, Record<string, number>>;
  /** Increments the room's in-flight count. */
  startGenerating: (projectId: string, roomId: string) => void;
  /** Decrements the room's in-flight count, deleting the room's entry once it
   *  hits zero rather than leaving a stale `0` around — never goes negative. */
  stopGenerating: (projectId: string, roomId: string) => void;
}

/**
 * Bump updatedAt MONOTONICALLY. Two mutations in the same millisecond used to
 * produce identical timestamps; the sync layer dedupes pushes by updatedAt
 * equality, so the second mutation was never mirrored to Supabase — and
 * equal-timestamp conflict resolution in importProjects was ambiguous.
 */
const touch = (p: Project): Project => {
  const prev = Date.parse(p.updatedAt) || 0;
  return { ...p, updatedAt: new Date(Math.max(Date.now(), prev + 1)).toISOString() };
};

/**
 * Union two projects' room cards by roomId, and each room's generations by id.
 * A generation present on only one side ALWAYS survives — paid AI output
 * should never be silently dropped by a last-write-wins merge.
 */
const mergeRoomCards = (preferred: RoomCard[], other: RoomCard[]): RoomCard[] => {
  const byRoom = new Map<string, RoomCard>(other.map((c) => [c.roomId, c]));
  for (const c of preferred) {
    const prev = byRoom.get(c.roomId);
    if (!prev) {
      byRoom.set(c.roomId, c);
      continue;
    }
    const seen = new Set(prev.generations.map((g) => g.id));
    const generations = [...prev.generations, ...c.generations.filter((g) => !seen.has(g.id))];
    byRoom.set(c.roomId, { ...c, generations });
  }
  return [...byRoom.values()];
};

const cardsSig = (cards: RoomCard[]): string =>
  cards
    .map((c) => `${c.roomId}:${c.generations.length}`)
    .sort()
    .join("|");

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * PERF: debounces the actual `localStorage.setItem` disk write behind
 * persist's storage adapter — the in-memory zustand `set()` (and every
 * subscribed component's re-render) stays perfectly synchronous; only the
 * browser-storage write is deferred.
 *
 * Measured cause: several fields dispatch straight to a store setter on
 * every keystroke with no local-state buffering first — e.g. the room name
 * input in review/page.tsx (`onChange={(e) => updateRoom(id, room.id, {
 * name: e.target.value })}`), plus the width/height and door/window count
 * fields on the same page. `createJSONStorage` (zustand/middleware) calls
 * `storage.setItem(name, JSON.stringify(wholeState))` synchronously inside
 * every one of those `set()` calls, and `partialize` below persists the
 * FULL `projects` array — every project's roomCards/generations included,
 * not just the one being edited. Typing a 12-character room name meant 12
 * synchronous whole-store JSON.stringify + localStorage.setItem calls, on
 * the same tick as the keystroke that triggered each one.
 *
 * Coalescing those into one write ~300ms after the last mutation removes
 * the per-keystroke main-thread write without changing what ends up on
 * disk (the debounced write always carries the latest state — nothing is
 * merged or dropped) or how the app reads it back (`getItem` is untouched,
 * so a fresh tab / hard reload always rehydrates correctly). `flush` also
 * runs on `pagehide`/tab-hide so navigating away or closing the tab mid-
 * debounce-window never silently drops the last edit.
 */
function debouncedStorage(storage: Storage, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { name: string; value: string } | null = null;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) {
      storage.setItem(pending.name, pending.value);
      pending = null;
    }
  };

  if (typeof window !== "undefined") {
    // pagehide covers tab close / bfcache navigation (mobile Safari does not
    // reliably fire beforeunload); visibilitychange covers a backgrounded
    // tab, which mobile OSes can suspend or kill without ever firing pagehide.
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  return {
    getItem: (name: string) => storage.getItem(name),
    setItem: (name: string, value: string) => {
      pending = { name, value };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name: string) => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = null;
      storage.removeItem(name);
    },
  };
}

export const useVasto = create<VastoState>()(
  persist(
    (set, get) => ({
      projects: [],
      generatingRoomIds: {},

      createProject: (name, propertyType) => {
        const id = uid("proj");
        const project: Project = {
          id,
          name,
          propertyType,
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          roomCards: [],
        };
        set((s) => ({ projects: [project, ...s.projects] }));
        return id;
      },

      deleteProject: (id) =>
        set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),

      /** Wipes every project. The existing ProjectSync subscriber (project-sync.tsx)
       *  already reacts to any known id disappearing from `projects` by firing a
       *  DELETE per id, so clearing the array here is enough to propagate to
       *  Supabase too — no separate bulk-sync code needed. */
      clearAllProjects: () => set({ projects: [], generatingRoomIds: {} }),

      importProjects: (incoming) =>
        set((s) => {
          const byId = new Map(s.projects.map((p) => [p.id, p]));
          for (const remote of incoming) {
            const local = byId.get(remote.id);
            if (!local) {
              byId.set(remote.id, remote);
              continue;
            }
            // Keep whichever project was touched last — but NEVER drop
            // generation records only the losing side has (see mergeRoomCards).
            // If the merge actually added something, bump updatedAt so the
            // sync layer pushes the union back up instead of leaving Supabase behind.
            const winner = remote.updatedAt > local.updatedAt ? remote : local;
            const loser = winner === remote ? local : remote;
            const roomCards = mergeRoomCards(winner.roomCards ?? [], loser.roomCards ?? []);
            const merged =
              cardsSig(roomCards) === cardsSig(winner.roomCards ?? [])
                ? winner
                : touch({ ...winner, roomCards });
            byId.set(remote.id, merged);
          }
          return {
            projects: [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
          };
        }),

      getProject: (id) => get().projects.find((p) => p.id === id),

      patchProject: (id, patch) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, ...patch }) : p)),
        })),

      setFloorPlan: (id, plan) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  floorPlan: plan,
                  roomCards: [],
                  designSpec: undefined,
                  universalInput: undefined,
                  walkthrough: undefined,
                })
              : p,
          ),
          generatingRoomIds: { ...s.generatingRoomIds, [id]: {} },
        })),

      applyPlanLayout: (id, rooms) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms } });
          }),
        })),

      updateRoom: (id, roomId, patch) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            return touch({
              ...p,
              floorPlan: {
                ...p.floorPlan,
                rooms: p.floorPlan.rooms.map((r) =>
                  r.id === roomId ? { ...r, ...patch } : r,
                ),
              },
            });
          }),
        })),

      setRoomGreybox: (id, roomId, patch) => get().updateRoom(id, roomId, patch),

      addRoom: (id, room) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            return touch({
              ...p,
              floorPlan: { ...p.floorPlan, rooms: [...p.floorPlan.rooms, room] },
            });
          }),
        })),

      removeRoom: (id, roomId) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            return touch({
              ...p,
              floorPlan: {
                ...p.floorPlan,
                rooms: p.floorPlan.rooms.filter((r) => r.id !== roomId),
              },
              roomCards: p.roomCards.filter((c) => c.roomId !== roomId),
            });
          }),
        })),

      resizeRoom: (id, roomId, size) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            const room = p.floorPlan.rooms.find((r) => r.id === roomId);
            if (!room) return p;
            // Each field is edited independently (Room Confirmation calls this
            // with only `width` or only `height`) — falling back to the OTHER
            // field's current value when it's still undefined (dimensions
            // never given) would turn `undefined` into `NaN` via r1(). Leave
            // an untouched, still-missing dimension untouched instead.
            const width = size.width !== undefined ? Math.max(2, r1(size.width)) : room.width;
            const height = size.height !== undefined ? Math.max(2, r1(size.height)) : room.height;
            const rooms = p.floorPlan.rooms.map((r) =>
              r.id === roomId ? { ...r, width, height } : r,
            );
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms } });
          }),
        })),

      setOpeningCount: (id, roomId, kind, count) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            const room = p.floorPlan.rooms.find((r) => r.id === roomId);
            if (!room) return p;
            const target = Math.min(20, Math.max(0, Math.round(count)));
            const current = room.openings ?? [];
            const ofKind = current.filter((o) => o.type === kind);
            const others = current.filter((o) => o.type !== kind);
            let nextOfKind: typeof ofKind;
            if (ofKind.length > target) {
              nextOfKind = ofKind.slice(0, target);
            } else {
              nextOfKind = [
                ...ofKind,
                ...Array.from({ length: target - ofKind.length }, () => ({
                  type: kind,
                  side: "north" as const,
                  connectsTo: null,
                })),
              ];
            }
            const rooms = p.floorPlan.rooms.map((r) =>
              r.id === roomId ? { ...r, openings: [...others, ...nextOfKind] } : r,
            );
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms } });
          }),
        })),

      confirmRooms: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? touch({ ...p, roomsConfirmedAt: new Date().toISOString() }) : p,
          ),
        })),

      confirmPlan: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? touch({ ...p, planConfirmedAt: new Date().toISOString() }) : p,
          ),
        })),

      setPlanSkipped: (id, skipped) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            // Written as `undefined` rather than `false` when cleared so a
            // project that never skipped and one that un-skipped serialise
            // identically — nothing reads this as a tri-state, and leaving a
            // literal `false` behind would be the only difference between
            // them in the persisted snapshot.
            p.id === id ? touch({ ...p, planSkipped: skipped || undefined }) : p,
          ),
        })),

      setStatus: (id, status) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, status }) : p)),
        })),

      setStyle: (id, styleId) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, styleId }) : p)),
        })),

      setDesignPlan: (id, plan) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, ...plan }) : p)),
        })),

      // --- Openings (doors + windows) — operate on the plan's arrays ----------
      addDoor: (id, door) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({ ...p, floorPlan: { ...p.floorPlan, doors: [...p.floorPlan.doors, door] } })
              : p,
          ),
        })),

      updateDoor: (id, doorId, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({
                  ...p,
                  floorPlan: {
                    ...p.floorPlan,
                    doors: p.floorPlan.doors.map((d) => (d.id === doorId ? { ...d, ...patch } : d)),
                  },
                })
              : p,
          ),
        })),

      removeDoor: (id, doorId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({
                  ...p,
                  floorPlan: { ...p.floorPlan, doors: p.floorPlan.doors.filter((d) => d.id !== doorId) },
                })
              : p,
          ),
        })),

      addWindow: (id, win) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({
                  ...p,
                  floorPlan: { ...p.floorPlan, windows: [...(p.floorPlan.windows ?? []), win] },
                })
              : p,
          ),
        })),

      updateWindow: (id, winId, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({
                  ...p,
                  floorPlan: {
                    ...p.floorPlan,
                    windows: (p.floorPlan.windows ?? []).map((w) =>
                      w.id === winId ? { ...w, ...patch } : w,
                    ),
                  },
                })
              : p,
          ),
        })),

      removeWindow: (id, winId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id && p.floorPlan
              ? touch({
                  ...p,
                  floorPlan: {
                    ...p.floorPlan,
                    windows: (p.floorPlan.windows ?? []).filter((w) => w.id !== winId),
                  },
                })
              : p,
          ),
        })),

      addGeneration: (id, roomId, generation) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id) return p;
            // A generation that was in flight when its room got deleted
            // (Room Confirmation's delete) resolves after the fact — without
            // this guard it silently recreates an orphaned roomCards entry
            // for a room no longer in floorPlan.rooms (found in a 2026-07-27
            // code review).
            if (p.floorPlan && !p.floorPlan.rooms.some((r) => r.id === roomId)) return p;
            const existing = p.roomCards.find((c) => c.roomId === roomId);
            const roomCards = existing
              ? p.roomCards.map((c) =>
                  c.roomId === roomId
                    ? {
                        ...c,
                        generations: [...c.generations, generation],
                        approvedId: c.approvedId ?? generation.id,
                      }
                    : c,
                )
              : [
                  ...p.roomCards,
                  { roomId, generations: [generation], approvedId: generation.id, included: true },
                ];
            return touch({ ...p, roomCards });
          }),
        })),

      setApproved: (id, roomId, generationId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  roomCards: p.roomCards.map((c) =>
                    c.roomId === roomId ? { ...c, approvedId: generationId, approvedByUser: true } : c,
                  ),
                })
              : p,
          ),
        })),

      setIncluded: (id, roomId, included) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  roomCards: p.roomCards.map((c) => (c.roomId === roomId ? { ...c, included } : c)),
                })
              : p,
          ),
        })),

      setWalkthrough: (id, walkthrough) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, walkthrough }) : p)),
        })),

      startGenerating: (projectId, roomId) =>
        set((s) => {
          const existing = s.generatingRoomIds[projectId] ?? {};
          const count = (existing[roomId] ?? 0) + 1;
          return {
            generatingRoomIds: { ...s.generatingRoomIds, [projectId]: { ...existing, [roomId]: count } },
          };
        }),

      stopGenerating: (projectId, roomId) =>
        set((s) => {
          const existing = s.generatingRoomIds[projectId];
          if (!existing?.[roomId]) return s;
          const count = existing[roomId] - 1;
          if (count <= 0) {
            // Drop the key entirely rather than leaving a `0` behind — keeps
            // `Object.keys(generatingRoomIds[projectId])` a true "which rooms
            // are generating right now" list for any future reader that
            // enumerates it instead of indexing a known room id.
            const { [roomId]: _done, ...rest } = existing;
            return { generatingRoomIds: { ...s.generatingRoomIds, [projectId]: rest } };
          }
          return {
            generatingRoomIds: { ...s.generatingRoomIds, [projectId]: { ...existing, [roomId]: count } },
          };
        }),
    }),
    {
      name: "vasto-store-v1",
      storage: createJSONStorage(() => debouncedStorage(localStorage, 300)),
      version: 4,
      partialize: (s) => ({ projects: s.projects, generatingRoomIds: s.generatingRoomIds }),
      // Reset generatingRoomIds the moment rehydration finishes, rather than
      // trusting whatever was on disk. This looks like it defeats the point
      // of persisting the field at all, but it's the correct call, not just
      // a defensive one: "generating" in this app always means "a fetch the
      // CURRENT page is awaiting" (see generateMore in generate/page.tsx and
      // the auto-fire loop in design/page.tsx) — there is no server-tracked
      // job backing it the way render_jobs backs Veo video generation. A
      // real page reload (or the tab being closed and reopened) tears down
      // that JS execution entirely, which both aborts the in-flight request
      // AND destroys the only code path that would ever call
      // stopGenerating() for it. So a flag that survives into a freshly
      // rehydrated store is never describing a generation that's actually
      // still running — keeping it (even for a bounded "expire after 5
      // minutes" window) would just mean showing a spinner over a request
      // that no longer exists, for however long that window is. Clearing
      // unconditionally avoids that permanent-or-bounded fake spinner
      // outright, at zero cost, since there was never a real "still
      // generating" state to preserve across a reload in the first place.
      // (Soft, in-app navigation between pages needs none of this — the
      // store is a module-level singleton, so it never rehydrates and never
      // loses generatingRoomIds just from a route change.)
      onRehydrateStorage: () => (state) => {
        if (state) state.generatingRoomIds = {};
      },
      // v2: drop the old seeded demo projects so only real, user-created
      // projects remain. v3: the Workstream 8.5 rebuild destroyed the 3D
      // furniture-placement studio and the multi-view render pipeline —
      // `placedItems`/`renders` on any persisted project are stale shapes
      // the new code no longer reads or writes; drop them rather than carry
      // dead fields forward indefinitely. v4: PlacedOpening.span (a 0..1
      // wall-length fraction) was renamed to widthFt (a fixed real-world
      // width, in feet — see lib/types.ts's doc comment). No shipped build
      // on main ever persisted the old field (PlacedOpening didn't exist
      // there yet), so this isn't a real migration path — it's a safety
      // net for a dev/tester browser that ran this WORKTREE branch before
      // the rename: any placedOpening still carrying the stale `span`
      // field (and lacking `widthFt`) gets a STANDARD_*_WIDTH_FT default
      // instead of silently NaN-ing out downstream (Math.min(L, undefined)
      // etc. everywhere widthFt is now read) — re-adjustable by hand in
      // the Plan Editor afterward, same as any other placed opening.
      migrate: (persisted, fromVersion) => {
        const state = persisted as { projects?: (Project & { placedItems?: unknown; renders?: unknown })[] } | undefined;
        if (fromVersion < 2 && state?.projects) {
          const SEED_IDS = new Set(["proj_villa", "proj_apt", "proj_office", "proj_retail"]);
          state.projects = state.projects.filter((p) => !SEED_IDS.has(p.id));
        }
        if (fromVersion < 3 && state?.projects) {
          state.projects = state.projects.map((p) => {
            const { placedItems: _placedItems, renders: _renders, ...rest } = p;
            return { ...rest, roomCards: rest.roomCards ?? [] };
          });
        }
        if (fromVersion < 4 && state?.projects) {
          state.projects = state.projects.map((p) => {
            if (!p.floorPlan) return p;
            return {
              ...p,
              floorPlan: {
                ...p.floorPlan,
                rooms: p.floorPlan.rooms.map((r) => {
                  if (!r.placedOpenings?.length) return r;
                  return {
                    ...r,
                    placedOpenings: r.placedOpenings.map((o) => {
                      const legacy = o as PlacedOpening & { span?: number };
                      if (typeof legacy.widthFt === "number") return o;
                      const { span: _span, ...rest } = legacy;
                      return { ...rest, widthFt: legacy.type === "door" ? STANDARD_DOOR_WIDTH_FT : STANDARD_WINDOW_WIDTH_FT };
                    }),
                  };
                }),
              },
            };
          });
        }
        return state as VastoState;
      },
    },
  ),
);

/** Subscribe to a single project by id. */
export function useProject(id: string) {
  return useVasto((s) => s.projects.find((p) => p.id === id));
}

/**
 * Returns true once the persisted store has rehydrated on the client.
 * Gate persisted-data UI on this to avoid SSR/CSR hydration mismatches.
 */
const subscribeNever = () => () => {};

export function useHydrated() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}
