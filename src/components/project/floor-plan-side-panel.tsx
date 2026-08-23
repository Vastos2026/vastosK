"use client";

import { useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { RetryImg } from "@/components/ui/retry-img";
import { cn } from "@/lib/utils";
import type { FloorPlan } from "@/lib/types";

/**
 * One shared key, not scoped per-project. Collapsing this panel is a
 * personal UI preference ("I don't want a plan thumbnail eating gallery
 * space") rather than project data, so it should stay collapsed the next
 * time the user opens ANY project's Furnish or Generate gallery, the same
 * way the persisted Zustand store (store.ts's "vasto-store-v1") uses
 * localStorage rather than sessionStorage for durable, cross-visit state.
 * sessionStorage would forget the preference the moment the tab closes,
 * which is a worse default for something this low-stakes but repeatedly
 * annoying if it resets.
 */
const COLLAPSE_STORAGE_KEY = "vastos:floor-plan-panel-collapsed";

/**
 * Read/write helpers for the collapse preference, wired through
 * useSyncExternalStore below rather than "read localStorage in a useEffect
 * then setState" — that more obvious-looking approach renders once as
 * expanded (SSR default), then desyncs into a second render the moment the
 * effect fires, which is exactly the setState-in-effect cascading-render
 * pattern this repo's ESLint config (react-hooks/set-state-in-effect) flags,
 * and is also what Modal.tsx's own useHydrated hook already avoids the same
 * way. useSyncExternalStore is the sanctioned React API for "a value that
 * only exists on the client, must not mismatch the server-rendered HTML on
 * first paint, and needs to re-render when it changes" — precisely this.
 * The listener set exists only so `toggle` (below) can notify every mounted
 * instance of this hook in the SAME tab; localStorage's own "storage" event
 * only fires in OTHER tabs, never the one that made the write.
 */
const collapseListeners = new Set<() => void>();
function subscribeCollapsed(listener: () => void) {
  collapseListeners.add(listener);
  return () => collapseListeners.delete(listener);
}
function getCollapsedSnapshot() {
  return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
}
function getCollapsedServerSnapshot() {
  return false;
}
function setCollapsedPref(next: boolean) {
  window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
  collapseListeners.forEach((listener) => listener());
}

/**
 * Floor-plan reference panel, shared by the Furnish gallery
 * (furnish/page.tsx) and the Generate gallery (generate/page.tsx). Both
 * pages work room-by-room, far removed from the original upload step, so a
 * quick glance back at the source plan (and a way to blow it up full size)
 * saves a trip back to Room Confirmation just to look at it.
 *
 * Retrieval mirrors review/page.tsx and plan/page.tsx exactly: a real
 * uploaded photo (`plan.meta.storageKey`, set by /api/parse-plan) is served
 * back through `GET /api/render?key=`, the same durable path every other
 * stored image in this app uses; `plan.previewUrl` is a blob: URL from the
 * browser tab that did the upload and only survives that one tab's
 * lifetime, kept only as a same-tab fallback for a project whose upload
 * hasn't finished persisting yet.
 *
 * Renders nothing (not an empty frame, not a broken-image box) whenever
 * there's no image to show at all — a manually-created project, or one
 * whose extraction failed before a storageKey was ever assigned. A stored
 * key that fails to LOAD (since-deleted object, transient network blip) is
 * a different case, left to RetryImg's own retry-then-placeholder-icon
 * behavior rather than hiding the whole panel, since that failure is
 * usually transient and the panel reappearing on its own once the image
 * loads is better than it staying hidden for the rest of the visit.
 */
export function FloorPlanSidePanel({ plan, className }: { plan?: FloorPlan; className?: string }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, getCollapsedSnapshot, getCollapsedServerSnapshot);
  const [modalOpen, setModalOpen] = useState(false);

  const toggle = () => setCollapsedPref(!collapsed);

  const referenceImage = plan?.meta?.storageKey
    ? `/api/render?key=${encodeURIComponent(plan.meta.storageKey)}`
    : plan?.previewUrl;

  if (!referenceImage) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Show floor plan panel"
        title="Show floor plan"
        className={cn(
          "flex w-full shrink-0 cursor-pointer items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground",
          "xl:w-9 xl:justify-center xl:rounded-lg xl:px-0 xl:py-2.5",
          className,
        )}
      >
        <span className="flex items-center gap-2 xl:hidden">
          <Icon name="Ruler" className="size-3.5" />
          Floor plan
        </span>
        {/* Chevron points the direction the panel expands FROM its collapsed
            edge, matching this app's other collapse affordances (e.g. the
            phase stepper's own left/right chevrons): right = "open me". */}
        <Icon name="ChevronRight" className="hidden size-4 xl:block" />
        <Icon name="ChevronDown" className="size-3.5 xl:hidden" />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "w-full shrink-0 rounded-2xl border border-border bg-surface p-3",
        "xl:sticky xl:top-6 xl:w-56",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted">
          <Icon name="Ruler" className="size-3.5" />
          Floor plan
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Hide floor plan panel"
          title="Hide floor plan panel"
          className="grid size-6 cursor-pointer place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-foreground"
        >
          <Icon name="ChevronLeft" className="size-4" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setModalOpen(true)}
        aria-label="View floor plan full size"
        className="group relative block aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-grid bg-bg transition-colors hover:border-accent/50"
      >
        <RetryImg
          src={referenceImage}
          alt="Uploaded floor plan"
          loading="eager"
          className="absolute inset-0 h-full w-full object-contain"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
          <Icon name="Maximize2" className="size-4 text-white" />
        </span>
      </button>
      <p className="mt-2 text-[11px] leading-snug text-faint">
        Reference only, not used for generation.
      </p>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Uploaded Floor Plan"
        className="max-w-3xl"
      >
        <div className="p-6 pt-4">
          {/* Fixed-height box rather than an intrinsic-size <img> — RetryImg's
              inner <img> is always position:absolute + inset-0 (see that
              component's own doc comment), so it needs a sized ancestor to
              fill; a plain height-auto box would collapse to nothing. */}
          <div className="relative mx-auto h-[70vh] w-full">
            <RetryImg
              src={referenceImage}
              alt="Uploaded floor plan"
              className="absolute inset-0 h-full w-full object-contain"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
