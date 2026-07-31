# UI Stacking Bugs + Dimension Padding + Profile Render Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two confirmed CSS stacking-context bugs that make sidebar tooltips, the walkthrough-video modal, and (possibly) the delete-project menu render behind page content instead of on top of it; widen the still-too-narrow Room Confirmation dimension inputs further; and add a proper image lightbox for individual renders on the Profile page instead of the current "click any render → resume the whole project" behavior.

**Architecture:** Two of the three "renders behind cards" complaints trace to one shared mechanism each, root-caused by reading the actual CSS/DOM structure (not guessed): (1) `Sidebar`'s `.glass` class sets `backdrop-filter`, which — per the CSS spec — creates a new stacking context on the `<aside>` even though it has no `z-index`; since `<main>` is a *later* flex sibling with no competing stacking property, `<main>`'s content paints on top of the *entire* sidebar box, including anything that visually pokes out of it (the per-item hover tooltips). (2) The shared `Modal` component renders inline in the DOM (not via a portal) as `position: fixed`; per spec, a `position: fixed` element's containing block becomes its nearest ancestor with a `transform` (instead of the viewport) if one exists — and `.hover-lift`'s `:hover` state sets exactly that. Any `Modal` nested inside a `.hover-lift` card (e.g. the Profile page's walkthrough-video modal, which stays open while the user's cursor is over it — inside the same hover-lift `<Link>`) loses its full-viewport positioning and gets contained/clipped inside that one small card instead, which is why it reads as "behind" the page's other cards. Both are fixed at their true source (the reusable `Sidebar` and `Modal` components), not patched per-symptom. The third "still there" complaint (delete-project menu) and a related one (project-workspace header) get a verify-first task once the two root causes are fixed, since some/all of their symptoms may already resolve as a side effect.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind CSS v4 (utility classes + a few `@layer components` rules in `src/app/globals.css`), Zustand (`useVasto` store), no test runner — this repo's own verification convention (see `CLAUDE.md`) is `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus live browser verification where observable. Tasks below use that convention instead of a fabricated automated-test suite, since none exists in this repo.

## Global Constraints

- No em dashes in UI copy (repo-wide rule).
- Motion must be `transform`/`opacity` only, never `top`/`left`/`width`/`height`/`margin`.
- No test runner exists — verification is `npx tsc --noEmit` + `npm run lint` + `npm run build`, run from `P:\vastos-interior-main\vastos-interior-main`, after every task.
- Don't delete dormant/disabled code elsewhere in the repo; that convention isn't touched by this plan.
- Keep changes scoped to exactly what each task describes — no incidental refactors.

---

### Task 1: Widen the Room Confirmation dimension inputs further

The feet/inches boxes in Room Confirmation's per-room row were already widened once (`w-14`→`w-16` for feet, `w-12`→`w-14` for inches) but the user confirmed it's still not enough — the native number-input spinner arrows still crowd a two-digit value.

**Files:**
- Modify: `src/app/projects/[id]/review/page.tsx` (the `DimensionInline` component, `ft-in` branch — currently around lines 467-494)

**Interfaces:** None — this is a self-contained CSS-only change, no new props/exports.

- [ ] **Step 1: Locate the current widths**

Read `src/app/projects/[id]/review/page.tsx`, function `DimensionInline`, the `if (unit === "ft-in")` branch. Confirm the two `<input type="number">` elements currently have `className="input w-16"` (feet) and `className="input w-14"` (inches) — these are the values from the *previous* fix, already larger than the original `w-14`/`w-12`.

- [ ] **Step 2: Widen both boxes again, and hide the native spinner so digits get the full width instead of sharing it with browser-drawn arrows**

Replace:
```tsx
        <input
          type="number"
          value={ft ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches ?? 0))}
          className="input w-16"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(ft ?? 0, Number(e.target.value) || 0))}
          className="input w-14"
          aria-label={`${label} inches`}
        />
```
with:
```tsx
        <input
          type="number"
          value={ft ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches ?? 0))}
          className="input w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches ?? ""}
          placeholder="—"
          onChange={(e) => onChange(ftInToFeet(ft ?? 0, Number(e.target.value) || 0))}
          className="input w-16 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          aria-label={`${label} inches`}
        />
```

This does two things at once: widens feet to `w-20` (80px, up from 64px) and inches to `w-16` (64px, up from 56px), AND removes the native up/down spinner entirely (`appearance: textfield` + the two webkit pseudo-element overrides — the standard cross-browser way to hide it) so every pixel of the box is available for the digits instead of being shared with browser-drawn arrows. The value is still fully editable by typing or using arrow keys; only the little clickable up/down buttons disappear. This directly removes the root cause of the clipping (competing for space with the spinner), not just papers over it with more width.

- [ ] **Step 3: Verify**

Run from `P:\vastos-interior-main\vastos-interior-main`:
```bash
npx tsc --noEmit
npm run lint
```
Both must be clean (no output / no errors). Then, if a live browser session with real login is available, open a project's Room Confirmation page, and confirm a two-digit inches value (e.g. type `11`) is fully visible in its box with no spinner artifact overlapping it.

- [ ] **Step 4: Commit**

No commit — this repo has no automated commit-per-task convention; changes are committed by the orchestrating session at the end per its own workflow.

---

### Task 2: Fix the sidebar's stacking-context bug (root cause: `backdrop-filter` isolates `<aside>` from `<main>`)

**Files:**
- Modify: `src/components/sidebar.tsx:31` (the `<aside>` element's `className`)

**Interfaces:** None — pure CSS class change, no prop/behavior change.

- [ ] **Step 1: Confirm the root cause in the actual files**

Read `src/components/sidebar.tsx` — the root `<aside>` has class `"glass my-3 ml-3 flex w-16 shrink-0 flex-col items-center gap-1 rounded-3xl py-4 shadow-2xl shadow-black/40"`. Read `src/app/globals.css` around the `.glass` rule (currently ~line 144) — it sets `backdrop-filter: blur(20px)`. Read `src/components/app-shell.tsx` — `<Sidebar>` and `<main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>` are plain flex siblings inside `<div className="flex h-dvh overflow-hidden">`, neither has an explicit `z-index`. Per the CSS stacking spec, `backdrop-filter` alone creates a new stacking context on `<aside>` — since `<main>` is a later sibling with no competing stacking property, it paints on top of the sidebar's *entire* box, including the per-nav-item hover tooltip (`sidebar.tsx`, the `<span className="... absolute left-full ml-3 ... z-50 ...">{item.label}</span>` inside each nav `<Link>`) which pokes out past the sidebar's own right edge into the space where `<main>`'s content (project cards, profile cards, workspace header) renders. The tooltip's own `z-50` cannot fix this — it's trapped comparing only against its *own* stacking context (the sidebar's), not against `<main>`.

- [ ] **Step 2: Give the sidebar an explicit stacking order above `<main>`**

In `src/components/sidebar.tsx`, change the `<aside>` element's className from:
```tsx
    <aside className="glass my-3 ml-3 flex w-16 shrink-0 flex-col items-center gap-1 rounded-3xl py-4 shadow-2xl shadow-black/40">
```
to:
```tsx
    <aside className="glass relative z-30 my-3 ml-3 flex w-16 shrink-0 flex-col items-center gap-1 rounded-3xl py-4 shadow-2xl shadow-black/40">
```
Adding `relative z-30` makes the *whole* sidebar box (its own stacking context, tooltip included) rank above `<main>`'s content, which has no `z-index` of its own (effectively stacks at level 0). `z-30` is chosen to stay comfortably below this app's modal/overlay layer (`Modal` uses `z-50`, and other page-level dropdowns use `z-20`), so the sidebar sits above ordinary page content but never covers an open modal.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```
Both clean. If a live browser session is available: hover each sidebar nav icon (Home, Projects, Profile, Sign out) on `/projects`, `/profile`, and a project workspace page, and confirm the tooltip label is fully visible on top of the page content next to it, not hidden behind it.

---

### Task 3: Render the shared `Modal` component via a React portal (root cause: `position: fixed` inside a `transform`-bearing ancestor loses viewport-relative positioning)

**Files:**
- Modify: `src/components/ui/modal.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: same public API as today (`open`, `onClose`, `title`, `description`, `children`, `className` props, unchanged) — every existing call site (walkthrough modal in `profile-project-card.tsx`, the "Upload a new plan?" confirm in `workspace-frame.tsx`, `new-project-modal.tsx`, delete-room confirm in `review/page.tsx`, etc.) needs zero changes.

- [ ] **Step 1: Confirm the root cause**

`Modal` (`src/components/ui/modal.tsx`) returns `<div className="fixed inset-0 z-50 ...">` directly in the component tree, wherever it's invoked — it is NOT rendered through `createPortal`. Per the CSS spec, a `position: fixed` element's containing block is normally the viewport, UNLESS an ancestor has `transform` (or `filter`/`perspective`/`will-change: transform`), in which case that ancestor becomes the containing block instead. `src/components/profile-project-card.tsx` wraps its whole card (including the walkthrough `<Modal>`, nested near the bottom of the JSX) in `<Link className="group hover-lift block ...">`, and `.hover-lift:hover { transform: translateY(-2px); }` (`globals.css` ~line 155) applies exactly while the user's cursor is over that card — which it typically still is while watching/interacting with the just-opened walkthrough video. In that state, the Modal's `fixed inset-0` resolves against the hovered card's own small box instead of the full viewport, breaking the intended full-screen overlay and making it read as clipped/behind other page content. Any other `Modal` usage nested inside a `.hover-lift` (or any future transformed) ancestor has the same latent bug, whether or not it's visibly triggered yet.

- [ ] **Step 2: Write the failing-by-inspection reproduction note (no test runner, so this is a manual repro, documented for the reviewer)**

Manual repro (no automated test exists in this repo): open `/profile` in a real logged-in session, hover a project card that has a completed walkthrough, click its video thumbnail to open the modal, and — while the modal is open and the cursor is still over the original card — observe that the modal does not cover the full viewport / appears constrained to the card's own area instead of centered full-screen. This is the bug Step 3 fixes.

- [ ] **Step 3: Port `Modal` to `createPortal`**

Replace the full contents of `src/components/ui/modal.tsx` with:
```tsx
"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  // Portals must not render on the server (no document there) and must wait
  // for the client to mount before touching document.body, to avoid an
  // SSR/CSR hydration mismatch — same reasoning as this codebase's existing
  // useHydrated() gate in store.ts, applied here for the same class of issue.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  // Rendered via a portal straight into document.body — a Modal invoked from
  // deep inside any component (e.g. a `.hover-lift` card, whose `:hover`
  // state sets a `transform` and would otherwise become this element's
  // `position: fixed` containing block instead of the viewport) always gets
  // genuine full-viewport positioning, immune to any ancestor's CSS.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-up"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl animate-fade-up",
          className,
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div>
              {title && <h2 className="text-lg font-semibold">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
              aria-label="Close"
            >
              <Icon name="X" className="size-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Verify the reproduction from Step 2 no longer happens**

```bash
npx tsc --noEmit
npm run lint
npm run build
```
All clean (the build step matters here specifically because `react-dom`'s `createPortal` must resolve correctly in a "use client" component — same class of client/server-boundary issue this repo's CLAUDE.md already calls out `npm run build` for). Then, if live browser access is available, repeat the Step 2 repro and confirm the modal now covers the full viewport, centered, regardless of hover state on the originating card. Also spot-check one other `Modal` call site (e.g. the "Upload a new plan?" confirm in a project workspace) still opens/closes/Escape-closes correctly — the public API didn't change, so this should need no code changes at those call sites, only a visual re-check.

---

### Task 4: Re-verify the Projects-grid delete-project menu now that Tasks 2-3 have landed, and fix it further if it's still broken

The delete-project dropdown (`src/components/project-card.tsx`) was already changed once this session from `top-8` (opening downward, past the card's own bottom edge into the row below) to `bottom-8` (opening upward, staying within the card's own thumbnail area) — but the user reported it as still broken. Neither of Task 2's or Task 3's root causes directly explain this one (the dropdown is `position: absolute`, not `fixed`, so Task 3's containing-block mechanism doesn't apply to it; and it isn't a sidebar tooltip, so Task 2 doesn't directly apply either) — so this task starts from a live re-check, not an assumed fix.

**Files:**
- Modify (only if Step 1 finds a real remaining bug): `src/components/project-card.tsx:51` (the dropdown `<div>`'s className)

**Interfaces:** None.

- [ ] **Step 1: Re-check the current state**

Read `src/components/project-card.tsx`. Confirm the dropdown `<div>` (around line 51) currently reads:
```tsx
            <div className="absolute bottom-8 right-0 z-20 w-40 overflow-hidden rounded-xl border border-border bg-surface-3 py-1 shadow-2xl">
```
If a live browser session is available, open `/projects` with at least 2 rows of project cards, click the "⋮" menu on a card in the FIRST row (not the last), and confirm the "Delete project" menu renders fully visible, contained within/above that card, not clipped by or hidden behind any neighboring card.

- [ ] **Step 2: If still broken, diagnose the real cause before changing anything**

If Step 1's live check still shows the menu hidden or clipped, the most likely remaining cause is the same class of stacking-context trap Task 2/3 fixed elsewhere: `src/components/project-card.tsx`'s outer card `<div>` has `className="group hover-lift relative ..."` — `.hover-lift:hover { transform: translateY(-2px) }` makes a HOVERED card its own stacking context. If the dropdown's own card is hovered (it is, since you have to hover to see the "⋮" button at all — it's `opacity-0 group-hover:opacity-100`) while an UNHOVERED sibling card is later in DOM order and visually overlaps where the dropdown extends, the sibling can paint on top of the dropdown despite `z-20`, the same painting-order mechanism documented in Task 2. Confirm this by temporarily giving the outer card `<div>` (line ~19) a permanent `z-30` only while its own dropdown menu is open (i.e. conditional on `menu` state), which forces that specific card above all its siblings for as long as the menu is showing:
```tsx
    <div
      className={cn(
        "group hover-lift relative animate-fade-up rounded-2xl border border-border bg-surface",
        menu && "z-30",
      )}
    >
```
(This requires importing `cn` from `@/lib/utils`, already used elsewhere in this file's sibling components — check the file's existing imports and add `import { cn } from "@/lib/utils";` if not already present.)

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```
Both clean. Re-run the live Step 1 repro if possible and confirm the menu is now fully visible regardless of which row/column the card is in.

---

### Task 5: Harden the project-workspace header's stacking order and verify/fix the back-arrow / status-badge overlap at narrow widths

The user's screenshots (a project named "asd") show the "Back one step" arrow button appearing to overlap the project title text, and the "Parsed" status badge appearing to overlap the floor-plan preview — both at what looks like a narrow browser width. Reading `src/components/project/workspace-frame.tsx`'s structure, the back-arrow button (`position: absolute`, inside `<div className="relative min-h-0 flex-1">`, which is a *sibling that comes after* `<header>` in the DOM) should not overlap the header under normal flow — so this task starts from a live, narrow-viewport repro rather than an assumed fix, same approach as Task 4.

**Files:**
- Modify (only if Step 1 finds a real bug): `src/components/project/workspace-frame.tsx`

**Interfaces:** None.

- [ ] **Step 1: Reproduce at the width shown in the screenshots**

If a live browser session is available, open any project's workspace page (e.g. Design or Review) and use the browser tool's window-resize action to set the viewport to roughly 700-980px wide (matching the cropped screenshots). Check:
(a) Does the "Back one step" arrow button (bottom-left `ArrowLeft` icon button) visually overlap the header's project name / "Residential Home" text?
(b) Does the project's `StatusBadge` ("Parsed", etc., in the header) visually overlap the floor-plan preview content below it?

- [ ] **Step 2: If (a) reproduces, fix the header/back-arrow relationship directly**

The header (`src/components/project/workspace-frame.tsx`, the `<header className="flex items-center gap-4 border-b border-border px-5 py-3">` block) has no `flex-wrap`, so at narrow widths its children (home icon, title block, centered `PhaseStepper`, "Saved" indicator) are forced to shrink/overflow rather than wrap — this can visually compress the title block's available width down to near zero, which combined with `truncate` on `<h1>` could make the title *look* like it's sitting right behind the back-arrow button positioned in the content area just below, even though they're not technically in the same stacking context. Give the header an explicit stacking order above the content area, and make sure the header can never be compressed to zero width:
```tsx
      <header className="relative z-20 flex items-center gap-4 border-b border-border px-5 py-3">
```
and give the title block (currently `<div className="min-w-0 items-center gap-3">` — check the exact className at the call site) a `min-w-0` (likely already present) plus confirm `truncate` is on the `<h1>` (already present) so it degrades by ellipsis rather than by visually colliding with anything else.

- [ ] **Step 3: If (b) reproduces, fix the status badge**

If the `StatusBadge` in the header visually overlaps content further down the page (not just the header's own siblings), that also points to the header needing its own explicit stacking order — Step 2's `relative z-20` on `<header>` should resolve this too, since it makes the whole header (badge included) paint above `{children}`'s content area. If it does not, read `src/components/project/floor-plan-thumb-or-empty.tsx` and whatever renders the "Parsed" plan preview on the specific page shown in the screenshot (likely `src/app/projects/[id]/upload/page.tsx` or `review/page.tsx`) for any `position: fixed`/`sticky` element with a `z-index` at or above 20, and lower it or scope it so it can't climb above the header.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm run lint
```
Both clean. Re-run the Step 1 repro at the same narrow width and confirm both (a) and (b) no longer show any overlap. If neither (a) nor (b) reproduces at Step 1, leave the code untouched (don't guess-fix a bug that doesn't reproduce) and note in the task's completion report that this was checked live and found not currently reproducible, same posture this project's own `context.md` already uses for its documented "sharp ERR_DLOPEN_FAILED" investigation (workstream 13) — a real check that didn't find what it was looking for is still a useful, honestly-reported result, not a failure to hide.

---

### Task 6: Profile page — clicking an individual render opens an image lightbox instead of resuming the project; "Go to project" inside it resumes normally

Today, `src/components/profile-project-card.tsx` wraps the *entire* card (including every individual render thumbnail) in one `<Link href={projectHref(project)}>` — clicking a specific render image just resumes the project like clicking anywhere else on the card. The user wants clicking a render to open *that image* on its own (view + a "Go to project" button), while clicking anywhere else on the card keeps resuming the project exactly as it does today. Confirmed via `AskUserQuestion`: the lightbox needs nothing beyond the image and a "Go to project" button (no download/delete), and "Go to project" should go to the same resume point clicking the card already goes to (`projectHref(project)`) — not a different page.

**Depends on:** Task 3 (the lightbox uses `Modal`, which must already be portal-based so it isn't affected by this same card's `.hover-lift` transform while the lightbox is open and hovered).

**Files:**
- Modify: `src/components/profile-project-card.tsx`

**Interfaces:**
- Consumes: `Modal` (`src/components/ui/modal.tsx`, unchanged public API after Task 3), `projectHref` (`src/lib/nav.ts`, unchanged).
- Produces: nothing new consumed elsewhere — this is a self-contained UI change to one component.

- [ ] **Step 1: Read the current render-thumbnail markup**

In `src/components/profile-project-card.tsx`, the render thumbnails are rendered at (current line numbers, re-check before editing since Task 1-5 may have shifted other files but not this one):
```tsx
                {generations.map((g) => (
                  <div
                    key={g.id}
                    className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2 sm:size-20"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.imageUrl} alt="" className="size-full object-cover" />
                  </div>
                ))}
```
Note the existing `stopLinkNav` helper (`e.preventDefault(); e.stopPropagation();`) already used by the walkthrough-video button and the Export PDF button to prevent the card's own outer `<Link>` navigation from firing — the same pattern is needed here.

- [ ] **Step 2: Add lightbox state and imports**

At the top of the component function (after the existing `const [showWalkthrough, setShowWalkthrough] = useState(false);` line), add:
```tsx
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
```
No new imports are needed — `Modal`, `Link`, `Icon`, `Button` are already imported in this file; `projectHref` is already imported too (used by the outer `<Link href={projectHref(project)}>`).

- [ ] **Step 3: Make each render thumbnail open the lightbox instead of falling through to the card's Link**

Replace the `generations.map(...)` block from Step 1 with:
```tsx
                {generations.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={(e) => {
                      stopLinkNav(e);
                      setLightboxImage(g.imageUrl);
                    }}
                    className="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-2 sm:size-20"
                    aria-label="View render"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.imageUrl} alt="" className="size-full object-cover" />
                  </button>
                ))}
```
(Changed the wrapping `<div>` to a `<button type="button">` with an `onClick` that calls the existing `stopLinkNav` — same pattern the walkthrough-video thumbnail already uses just below it in this same file — then opens the lightbox by storing that render's `imageUrl`.)

- [ ] **Step 4: Render the lightbox modal**

Add this JSX right after the existing walkthrough `Modal` block (after its closing `)}` near the end of the component, still inside the outer `<Link>` return):
```tsx
      {lightboxImage && (
        <div onClick={stopLinkNav}>
          <Modal open={!!lightboxImage} onClose={() => setLightboxImage(null)} className="max-w-2xl">
            <div className="p-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightboxImage}
                alt="Render"
                className="max-h-[70vh] w-full rounded-xl border border-border object-contain"
              />
              <div className="mt-4 flex justify-end">
                <Link href={projectHref(project)}>
                  <Button icon="ArrowRight">Go to project</Button>
                </Link>
              </div>
            </div>
          </Modal>
        </div>
      )}
```
This mirrors the existing walkthrough-modal block's structure exactly (an outer `onClick={stopLinkNav}` wrapper so clicks inside the modal never bubble up to the card's own `<Link>`, same as the walkthrough modal already does). No `title`/`description` props are passed to `Modal` since the design decision (confirmed via `AskUserQuestion`) is "just view + Go to project" — no extra chrome.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
```
All clean. If a live browser session is available: on `/profile`, click an individual render thumbnail on a project card — confirm it opens the lightbox with just that image and a "Go to project" button, and does NOT navigate into the project. Click "Go to project" inside the lightbox — confirm it navigates to the same page clicking anywhere else on that card would (i.e. `projectHref(project)`, the project's current resume point — no special-casing needed, per the user's own confirmed answer). Separately, confirm clicking the card OUTSIDE any render thumbnail (e.g. the project name, the floor-plan thumbnail on the left) still resumes the project exactly as it does today — this task must not change that existing behavior.

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the padding-widen ask. Tasks 2-5 cover "these issues are still there" (sidebar tooltips confirmed root-caused and fixed in Task 2; walkthrough-video-behind-card confirmed root-caused and fixed in Task 3; delete-menu and workspace-header re-verified live in Tasks 4-5 rather than blind-patched again, since one blind patch already didn't fully resolve the user's report). Task 6 covers the full render-click lightbox spec confirmed via `AskUserQuestion` (view-only + Go to project; resume-point target; no back-navigation special-casing needed since the answer was "normal per-phase logic," i.e. no code change required for that part).
- **Placeholder scan:** No TBD/TODO; every step has literal code or a literal live-repro procedure appropriate to this repo's no-test-runner convention.
- **Type consistency:** `lightboxImage: string | null`, `setLightboxImage` used consistently in Task 6. `Modal`'s public prop names (`open`, `onClose`, `title`, `description`, `children`, `className`) are unchanged by Task 3 and used identically in Task 6.
