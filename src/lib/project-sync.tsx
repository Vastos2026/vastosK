"use client";

/**
 * Bridges the local-first zustand store to Supabase (`/api/projects`):
 *   - on mount, hydrates projects belonging to the signed-in user;
 *   - thereafter mirrors every project change up (debounced) and propagates
 *     deletes. All network calls are best-effort — the store stays authoritative,
 *     so the app is unaffected if Supabase is unconfigured or offline.
 *
 * Mounted once at the root, given `userId` from a Server Component
 * (`getCurrentUser()` in layout.tsx) — no-ops entirely when signed out, since
 * `/api/projects` now requires auth (it used to accept a client-supplied
 * "owner" id with no auth check at all, a real vulnerability; ownership is
 * now the real Supabase Auth user id end to end, not a pre-auth localStorage
 * device id).
 */

import { useEffect, useRef } from "react";
import { useVasto } from "./store";
import { supabaseBrowser } from "./supabase/browser";
import type { Project } from "./types";

export function ProjectSync({ userId }: { userId: string | null }) {
  const importProjects = useVasto((s) => s.importProjects);
  const ready = useRef(false);
  const lastSynced = useRef(new Map<string, string>()); // id → last-pushed updatedAt
  const knownIds = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 1) Hydrate from Supabase once, then seed the sync baseline so we don't
  //    immediately re-push everything we just pulled.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      // What Supabase currently has, so we can tell "in sync" from "local is
      // ahead" after the merge below.
      const remoteStamp = new Map<string, string>();
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          const { projects } = (await res.json()) as { projects?: Project[] };
          if (!cancelled && projects?.length) {
            for (const p of projects) remoteStamp.set(p.id, p.updatedAt);
            importProjects(projects);
          }
        }
      } catch {
        /* offline / unconfigured — store stays authoritative */
      } finally {
        if (!cancelled) {
          const st = useVasto.getState();
          for (const p of st.projects) {
            lastSynced.current.set(p.id, p.updatedAt);
            // Seeding used to mark EVERY local project as already-synced, which
            // silently orphaned local-only work (it was never pushed until the
            // next local mutation). Push anything Supabase doesn't have at this
            // exact version.
            if (remoteStamp.get(p.id) !== p.updatedAt) {
              void fetch("/api/projects", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: p }),
              }).catch(() => {});
            }
          }
          knownIds.current = new Set(st.projects.map((p) => p.id));
          ready.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importProjects, userId]);

  // 2) Mirror store changes up: debounced upsert per changed project + deletes.
  useEffect(() => {
    const unsub = useVasto.subscribe((state) => {
      if (!ready.current) return;
      const ids = new Set(state.projects.map((p) => p.id));

      // Propagate deletes.
      for (const id of knownIds.current) {
        if (!ids.has(id)) {
          lastSynced.current.delete(id);
          void fetch(`/api/projects?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
            () => {},
          );
        }
      }
      knownIds.current = ids;

      // Upsert only projects whose updatedAt changed (debounced per project).
      for (const p of state.projects) {
        if (lastSynced.current.get(p.id) === p.updatedAt) continue;
        lastSynced.current.set(p.id, p.updatedAt);
        const prev = timers.current.get(p.id);
        if (prev) clearTimeout(prev);
        timers.current.set(
          p.id,
          setTimeout(() => {
            void fetch("/api/projects", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project: p }),
            }).catch(() => {});
          }, 800),
        );
      }
    });
    return () => unsub();
  }, []);

  // 3) Realtime: apply changes pushed from other tabs/sessions for this user.
  //    Echoes of our own writes are no-ops (importProjects only takes strictly
  //    newer rows, and we pre-seed lastSynced to skip re-pushing them).
  useEffect(() => {
    if (!userId) return;
    const sb = supabaseBrowser();
    if (!sb) return;
    const channel = sb
      .channel("project_snapshots_sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "project_snapshots",
          filter: `anon_owner=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const appId = (payload.old as { app_id?: string }).app_id;
            if (appId && useVasto.getState().projects.some((p) => p.id === appId)) {
              useVasto.getState().deleteProject(appId);
            }
            return;
          }
          const project = (payload.new as { data?: Project }).data;
          if (project?.id) {
            lastSynced.current.set(project.id, project.updatedAt);
            useVasto.getState().importProjects([project]);
          }
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [userId]);

  return null;
}
