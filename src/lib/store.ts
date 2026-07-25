"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useSyncExternalStore } from "react";
import type {
  Door,
  PlacedItem,
  Project,
  ProjectStatus,
  PropertyType,
  RenderJob,
  RenderVersion,
  Room,
  Window,
} from "./types";
import { CATALOG, CATALOG_BY_ID } from "./data";
import { uid } from "./utils";

interface VastoState {
  projects: Project[];

  createProject: (name: string, propertyType: PropertyType) => string;
  deleteProject: (id: string) => void;
  /** Merge projects pulled from Supabase; a remote project wins only if newer. */
  importProjects: (incoming: Project[]) => void;
  getProject: (id: string) => Project | undefined;
  patchProject: (id: string, patch: Partial<Project>) => void;

  setFloorPlan: (id: string, plan: Project["floorPlan"]) => void;
  updateRoom: (id: string, roomId: string, patch: Partial<Room>) => void;
  /** Append a room to the plan (lasso-extracted rooms). */
  addRoom: (id: string, room: Room) => void;
  /**
   * Parametric resize: change a room's width/height AND rescale the positions
   * of the furniture inside it (relative placement preserved, footprints kept).
   */
  resizeRoom: (id: string, roomId: string, size: { width?: number; height?: number }) => void;
  setStatus: (id: string, status: ProjectStatus) => void;
  setStyle: (id: string, styleId: string) => void;

  addItem: (id: string, item: PlacedItem) => void;
  /** Replace all placed items — used to seed furniture detected from the plan. */
  setItems: (id: string, items: PlacedItem[]) => void;
  updateItem: (id: string, itemId: string, patch: Partial<PlacedItem>) => void;
  removeItem: (id: string, itemId: string) => void;

  /** Doors/windows ("openings") on the plan's walls — placed & edited per room. */
  addDoor: (id: string, door: Door) => void;
  updateDoor: (id: string, doorId: string, patch: Partial<Door>) => void;
  removeDoor: (id: string, doorId: string) => void;
  addWindow: (id: string, win: Window) => void;
  updateWindow: (id: string, winId: string, patch: Partial<Window>) => void;
  removeWindow: (id: string, winId: string) => void;
  suggestFurniture: (id: string) => void;
  setGhostFurniture: (id: string, ghosts: PlacedItem[]) => void;
  acceptGhosts: (id: string) => void;
  clearGhosts: (id: string) => void;

  addRender: (id: string, render: RenderJob) => void;
  updateRender: (id: string, renderId: string, patch: Partial<RenderJob>) => void;
  addRenderVersion: (id: string, renderId: string, version: RenderVersion) => void;

  /**
   * Reference images keyed by furniture-item id / room id. Kept in memory only
   * (large data URLs — excluded from localStorage via `partialize`), so they
   * survive in-app navigation (rooms → render → back) instead of resetting.
   */
  itemRefs: Record<string, { url: string; name: string }>;
  roomRefs: Record<string, { url: string; name: string }>;
  setItemRef: (itemId: string, ref: { url: string; name: string } | null) => void;
  setRoomRef: (roomId: string, ref: { url: string; name: string } | null) => void;

  /**
   * Per-room 3D screenshots (data URIs) of the LEFT/RIGHT/BACK wall cameras,
   * captured when the front photo is rendered (the room page has the 3D scene).
   * The render page later uses them to DERIVE the Left/Right/Back stills (each
   * screenshot = the camera; the edited front = the styleRef). In memory only.
   */
  roomCaptures: Record<string, { left?: string; right?: string; back?: string }>;
  setRoomCapture: (roomId: string, caps: { left?: string; right?: string; back?: string }) => void;
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
 * Union two render lists by id. A render present on only one side ALWAYS
 * survives — long render jobs (the ~100s Veo walkthrough) race snapshot pulls,
 * and whole-project last-write-wins used to silently discard the records (and
 * with them, paid Veo output). For the same id, keep the richer record.
 */
const mergeRenders = (preferred: RenderJob[], other: RenderJob[]): RenderJob[] => {
  const richer = (a: RenderJob, b: RenderJob): RenderJob => {
    if ((a.versions?.length ?? 0) !== (b.versions?.length ?? 0))
      return (a.versions?.length ?? 0) > (b.versions?.length ?? 0) ? a : b;
    if ((a.status === "completed") !== (b.status === "completed"))
      return a.status === "completed" ? a : b;
    return a;
  };
  const byId = new Map<string, RenderJob>();
  for (const r of other) byId.set(r.id, r);
  for (const r of preferred) {
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? richer(r, prev) : r);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
};

/** Order-independent fingerprint of a render list, to detect merge additions. */
const rendersSig = (rs: RenderJob[]): string =>
  rs
    .map((r) => `${r.id}:${r.versions?.length ?? 0}:${r.status}`)
    .sort()
    .join("|");

const r1 = (n: number) => Math.round(n * 10) / 10;
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const useVasto = create<VastoState>()(
  persist(
    (set, get) => ({
      projects: [],
      itemRefs: {},
      roomRefs: {},
      roomCaptures: {},

      createProject: (name, propertyType) => {
        const id = uid("proj");
        const project: Project = {
          id,
          name,
          propertyType,
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          placedItems: [],
          renders: [],
        };
        set((s) => ({ projects: [project, ...s.projects] }));
        return id;
      },

      deleteProject: (id) =>
        set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),

      importProjects: (incoming) =>
        set((s) => {
          const byId = new Map(s.projects.map((p) => [p.id, p]));
          for (const remote of incoming) {
            const local = byId.get(remote.id);
            if (!local) {
              byId.set(remote.id, remote);
              continue;
            }
            // Keep whichever project was touched last — but NEVER drop render
            // records only the losing side has (see mergeRenders). If the merge
            // actually added something, bump updatedAt so the sync layer pushes
            // the union back up instead of leaving Supabase behind.
            const winner = remote.updatedAt > local.updatedAt ? remote : local;
            const loser = winner === remote ? local : remote;
            const renders = mergeRenders(winner.renders ?? [], loser.renders ?? []);
            const merged =
              rendersSig(renders) === rendersSig(winner.renders ?? [])
                ? winner
                : touch({ ...winner, renders });
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
            p.id === id ? touch({ ...p, floorPlan: plan }) : p,
          ),
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

      resizeRoom: (id, roomId, size) =>
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== id || !p.floorPlan) return p;
            const room = p.floorPlan.rooms.find((r) => r.id === roomId);
            if (!room) return p;
            const width = Math.max(2, r1(size.width ?? room.width));
            const height = Math.max(2, r1(size.height ?? room.height));
            const kx = room.width > 0 ? width / room.width : 1;
            const ky = room.height > 0 ? height / room.height : 1;
            const rooms = p.floorPlan.rooms.map((r) =>
              r.id === roomId ? { ...r, width, height } : r,
            );
            // Furniture keeps its real-world footprint; only its position
            // scales with the room so the arrangement stays proportional.
            const placedItems = p.placedItems.map((it) => {
              if (it.roomId !== roomId) return it;
              const nx = room.x + (it.x - room.x) * kx;
              const ny = room.y + (it.y - room.y) * ky;
              return {
                ...it,
                x: clampN(r1(nx), room.x, Math.max(room.x, room.x + width - it.w)),
                y: clampN(r1(ny), room.y, Math.max(room.y, room.y + height - it.d)),
              };
            });
            return touch({ ...p, floorPlan: { ...p.floorPlan, rooms }, placedItems });
          }),
        })),

      setStatus: (id, status) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, status }) : p)),
        })),

      setStyle: (id, styleId) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? touch({ ...p, styleId }) : p)),
        })),

      addItem: (id, item) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? touch({ ...p, placedItems: [...p.placedItems, item] }) : p,
          ),
        })),

      setItems: (id, items) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? touch({ ...p, placedItems: items }) : p,
          ),
        })),

      updateItem: (id, itemId, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  placedItems: p.placedItems.map((it) =>
                    it.id === itemId ? { ...it, ...patch } : it,
                  ),
                })
              : p,
          ),
        })),

      removeItem: (id, itemId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({ ...p, placedItems: p.placedItems.filter((it) => it.id !== itemId) })
              : p,
          ),
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

      suggestFurniture: (id) => {
        const project = get().getProject(id);
        if (!project?.floorPlan) return;
        const ghosts: PlacedItem[] = [];
        for (const room of project.floorPlan.rooms) {
          const picks = SUGGESTIONS_BY_ROOM(room.name);
          picks.forEach((catalogId, i) => {
            const c = CATALOG_BY_ID[catalogId];
            if (!c) return;
            ghosts.push({
              id: uid("ghost"),
              catalogId,
              name: c.name,
              roomId: room.id,
              x: room.x + 1 + (i % 2) * Math.min(room.width - c.w - 2, 4),
              y: room.y + 1 + Math.floor(i / 2) * 3,
              rotation: 0,
              w: c.w,
              d: c.d,
              h: c.h,
              color: c.color,
              ghost: true,
            });
          });
        }
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  placedItems: [...p.placedItems.filter((it) => !it.ghost), ...ghosts],
                })
              : p,
          ),
        }));
      },

      setGhostFurniture: (id, ghosts) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  placedItems: [...p.placedItems.filter((it) => !it.ghost), ...ghosts],
                })
              : p,
          ),
        })),

      acceptGhosts: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  placedItems: p.placedItems.map((it) =>
                    it.ghost ? { ...it, ghost: false } : it,
                  ),
                })
              : p,
          ),
        })),

      clearGhosts: (id) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({ ...p, placedItems: p.placedItems.filter((it) => !it.ghost) })
              : p,
          ),
        })),

      addRender: (id, render) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? touch({ ...p, renders: [render, ...p.renders] }) : p,
          ),
        })),

      updateRender: (id, renderId, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  renders: p.renders.map((r) =>
                    r.id === renderId ? { ...r, ...patch } : r,
                  ),
                })
              : p,
          ),
        })),

      addRenderVersion: (id, renderId, version) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? touch({
                  ...p,
                  renders: p.renders.map((r) =>
                    r.id === renderId ? { ...r, versions: [...r.versions, version] } : r,
                  ),
                })
              : p,
          ),
        })),

      setItemRef: (itemId, ref) =>
        set((s) => {
          const next = { ...s.itemRefs };
          if (ref) next[itemId] = ref;
          else delete next[itemId];
          return { itemRefs: next };
        }),

      setRoomRef: (roomId, ref) =>
        set((s) => {
          const next = { ...s.roomRefs };
          if (ref) next[roomId] = ref;
          else delete next[roomId];
          return { roomRefs: next };
        }),

      setRoomCapture: (roomId, caps) =>
        set((s) => ({ roomCaptures: { ...s.roomCaptures, [roomId]: caps } })),
    }),
    {
      name: "vasto-store-v1",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // Reference images are large in-memory data URLs — never persist them.
      partialize: (s) => ({ projects: s.projects }),
      // v2: drop the old seeded demo projects so only real, user-created
      // projects remain. Matches them by their fixed seed ids.
      migrate: (persisted, fromVersion) => {
        const state = persisted as { projects?: Project[] } | undefined;
        if (fromVersion < 2 && state?.projects) {
          const SEED_IDS = new Set(["proj_villa", "proj_apt", "proj_office", "proj_retail"]);
          state.projects = state.projects.filter((p) => !SEED_IDS.has(p.id));
        }
        return state as VastoState;
      },
      // The persisted slice is only { projects } (refs are excluded by partialize),
      // and rehydration REPLACES the store state. Without re-supplying them here,
      // `itemRefs` / `roomRefs` come back undefined and a read like `roomRefs[id]`
      // crashes. Keep the live in-memory refs and take only `projects` from storage.
      merge: (persisted, current) => ({
        ...(current as VastoState),
        ...(persisted as Partial<VastoState>),
        itemRefs: (current as VastoState).itemRefs ?? {},
        roomRefs: (current as VastoState).roomRefs ?? {},
        roomCaptures: (current as VastoState).roomCaptures ?? {},
      }),
    },
  ),
);

/** Naive room-name → suggested catalog ids mapping for the "Suggest Layout" feature. */
function SUGGESTIONS_BY_ROOM(name: string): string[] {
  const n = name.toLowerCase();
  if (n.includes("living")) return ["sofa-3", "coffee-table", "tv-unit", "plant"];
  if (n.includes("master") || n.includes("bedroom")) return ["bed-queen", "wardrobe"];
  if (n.includes("dining")) return ["dining-table", "dining-chair"];
  if (n.includes("pooja")) return ["pooja-unit"];
  if (n.includes("kitchen")) return ["bookshelf"];
  return [];
}

export const ALL_CATALOG = CATALOG;

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
