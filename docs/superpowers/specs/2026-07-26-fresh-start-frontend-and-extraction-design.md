# Design: Fresh-Start Extraction, Room Confirmation & Generation Flow Redesign

## Context

`docs/VASTOS_REVAMP_PLAN.md` is the existing product plan. Auditing it against the live code (2026-07-26) found its own status lines stale — most of the frontend flow it lists as "in progress" is actually fully built and clean (no orphan buttons, no leftover furniture-studio code). That audit also surfaced one serious unflagged gap: projects are stored under an anonymous `localStorage` browser ID (`src/lib/project-sync.tsx`), not the real logged-in Supabase user, and no API route checks a session server-side.

Separately, the user corrected the scope of this work: this is a **total re-engineering**, not an incremental revamp, and it should be treated as a fresh start **from immediately after floor-plan upload/detection onward**. Two concrete problems drove this: the pixel-geometry OpenCV detection pipeline is fragile (five hand-tuned drawing-style heuristics that don't generalize), and Room Confirmation shipped with a draggable 2D canvas the user never asked for.

This document is the corrected design for everything from "user clicks Yes, I have a floor plan" through the final walkthrough video / PDF export, plus the Profile dashboard and the no-floor-plan path. It supersedes the relevant sections of `VASTOS_REVAMP_PLAN.md` (the "Full page-by-page flow" section, the room-structural-context/openings section, and the Workstream 8.5/8.6 checklist) without rewriting the sections that remain accurate (Universal JSON Architecture, Design Planning Layer, Prompt Builder, Admin console shape, Security section, Database model except as amended below).

## Scope boundary

**Unchanged, no objection raised:** Login, Dashboard/Welcome, New Project modal, the Floor Plan Yes/No screen's existence (behavior changes, see below), and the entire AI prompting architecture (Universal Input → Design Planning Layer → Prompt Builder → Gemini/Veo) — verified already matching a clean spec in the live code.

**Re-engineered:** floor-plan extraction, Room Confirmation, the no-floor-plan path, the Generate Gallery's loading/reveal behavior (not its backend mechanism), View & Edit's reveal behavior, Approve's feedback polish, Walkthrough's reordering interaction and Export folding, Profile's visual polish, and the backend data-ownership/auth layer.

## 1. Extraction — one Gemini Vision call replaces OCR + OpenCV + semantic + merge

**Why:** `scripts/parse_plan.py` routes every plan into one of five hardcoded drawing-style heuristics (pink CAD, yellow fill, black ink, gray render, blue/cyan CAD), each with dozens of hand-tuned pixel thresholds. It only works when a plan happens to match one of those five conventions. A hand sketch, a phone photo, or an unfamiliar CAD export falls outside all five and produces poor results — a permanent tuning burden, not a one-time build. Gemini vision is already used elsewhere in the pipeline and is strong exactly where OpenCV is weak (reading labels, general layout) while being weak exactly where OpenCV was needed (precise pixel geometry) — so this trade favors the simpler path.

**New pipeline:** a single Gemini Vision call (a new module, not `ocr.ts`/`semantic.ts`/`merge.ts` reused) takes the uploaded image and returns structured JSON:
- Room name, **verbatim as printed/labeled** on the plan (e.g. "KIDS", "Hall") — never normalized away.
- Room type, **classified** by the model from the verbatim name into a canonical type from the active project category's `roomTypes` (e.g. "KIDS" → Kids Room, "Hall" → Living Room) — name and type are stored separately, exactly like today's `Room.name`/`Room.type` fields.
- Dimensions, if legibly printed on the plan; otherwise omitted (never fabricated).
- Per room: door/window presence with a rough side (north/south/east/west) and, where inferable, what it connects to (another room name or "exterior") — same shape `RoomOpening` already defines in `src/lib/pipeline/assign-openings.ts`, just populated by the vision call directly instead of by pixel-geometry + point-to-edge-distance math. The deterministic `assign-openings.ts` geometry step is no longer in the critical path (openings arrive pre-assigned).

**OpenCV disposition:** `scripts/parse_plan.py`, `scripts/detect_rooms_labeled.py`, `src/lib/pipeline/opencv.ts` stay in the repository, untouched, **not deleted**. They go dormant — no longer called from the live upload flow. The user will make a final call on wall-detection later; nothing here forecloses that.

**`ocr.ts`/`semantic.ts`/`merge.ts` disposition:** these formed the old 3-stage text-extraction pipeline this replaces. Recommendation: delete them along with the old orchestration in `pipeline.ts` and `inngest/functions.ts` that calls them, once the new single-call extraction module is live and verified — this is a "total re-engineering, don't carry over old stuff unless necessary" case, not a "keep dormant" case like OpenCV, because nothing else in the new design depends on their specific output shape. Flagged here for explicit confirmation at plan review rather than deleted silently.

**Low-confidence / failed extraction:** no separate error dead-end. Routes straight into Room Confirmation, empty, in the same state as the no-floor-plan path (Section 3) — the user adds rooms manually via the same "Add room" mechanism that also catches anything the model missed on a partial success.

## 2. Upload screen — no separate results screen

**Current:** dropzone → preview + Analyze → progress bar tied to 4 backend stages → a distinct "Detected geometry" screen (image overlay, wall/door/window layers, confidence badge, stat tiles, room chip list) → manual "Continue to Room Confirmation" click.

**New:**
- Dropzone unchanged functionally; file selection crossfades into the preview card (no hard swap).
- "Analyze floor plan" triggers the single extraction call. While it runs: a soft light-sweep animation moves across the uploaded plan image itself (the document visibly being "read") — no percentage progress bar, since there's exactly one backend call now, not four stages to report progress across.
- On success: **no intermediate results screen.** Navigates directly into Room Confirmation with the extracted rooms already populated. The uploaded plan's thumbnail smoothly docks into a small static reference panel on the Room Confirmation screen (continuity, not a jump-cut).
- On failure/low confidence: one clear inline message + one button, "Switch to manual entry," which is really just navigating to the same empty Room Confirmation state as Section 3.

`DetectionOverlay` component (`src/components/project/detection-overlay.tsx`) becomes unused and is deleted as part of this work (not "kept dormant" — it's UI, not a detection engine, and the user does not want it back later per the "no orphan UI" rule already in the base plan doc).

## 3. Room Confirmation — rebuilt as a plain list, no canvas

**Current:** `PlanEditor` — a draggable 2D canvas where rooms are boxes the user repositions, plus "Isolate room" and "Tidy layout" buttons. Never requested; out of scope.

**New:** a single list, no spatial canvas anywhere on this screen.
- Each room is a row/card: colour tag dot (the same colour that already gets assigned per room and now carries through the whole flow — Upload's reference thumbnail uses the same palette, and later the Generate Gallery's loading tint uses this room's colour too, so identity is visually continuous across screens), name (inline-editable text), type (dropdown, pre-filled from the extraction's classification, editable), dimensions with the existing unit selector (ft/in default, decimal ft, m, cm), door/window count chips.
- Rows stagger in on load (60-80ms cascade), not a flat instant dump.
- **Delete room:** clicking delete opens a small confirm popup: *"This room will be deleted. You can still add it back with Add room."* — not silent, not a full blocking modal, just a lightweight confirm-before-destructive-action step.
- **Add room:** the existing simple inline form (name, type, width, height) is the single mechanism for two cases: a room the user wants to add that never existed on the plan, and a room the extraction missed entirely (the model didn't catch it, or it's a "coming soon"/manual project). Same form, same fields, both purposes — no separate "missed room" flow.
- A small, static, non-interactive thumbnail of the uploaded plan sits in a reference panel for visual context — not editable, not a detection overlay, purely "here's what you uploaded."
- "Continue to Design" stays pinned at the bottom, unchanged.
- No "Isolate room" or "Tidy layout" buttons — both were canvas-positioning concerns that no longer exist.

`PlanEditor`'s drag/position/tidy-layout code (`src/components/project/plan-editor.tsx` and the relevant parts of `src/lib/plan-geometry.ts` — `tidyLayout`, overlap/out-of-bounds analysis) is deleted, not kept dormant — it was purpose-built for the canvas this design removes and has no other caller.

## 4. No-floor-plan path — reuses Room Confirmation, no separate screen

**Current:** the Floor Plan screen's "No" choice shows a "coming soon" placeholder; nothing built beyond that.

**New:** "No, not yet" navigates straight into the same Room Confirmation screen from Section 3, starting with zero rooms and a prominent "Add your first room" prompt in place of the (now-empty) room list. This is the same screen serving three arrival paths — extracted rooms, a manually-started project, and the low-confidence-extraction fallback — rather than building a distinct sketch/manual-entry screen. No freehand boundary-drawing canvas is built (the earlier "Sketch Tool" canvas concept from `VASTOS_REVAMP_PLAN.md` is superseded by this simpler reuse).

## 5. Design screen

Content unchanged (Aesthetic, Luxury Level, Colour Palette, one global Additional Requirements box, per-project-category subcategory chips) — already matches spec cleanly in the live code. Polish only: swatch/style cards get dimensional hover feedback (lift + border glow, not a flat colour swap). "Confirm & plan design" shows an inline label change ("Composing your design language…") during the one Design Planning call, then navigates straight to the Generate Gallery — no interstitial loading screen.

## 6. Generate Gallery — auto-parallel generation with progressive reveal

**Current:** cards start empty; user clicks Generate on each individually; a spinner runs; the image appears abruptly.

**New:**
- Confirming Design **is** the trigger — there is no separate "now click Generate" step for the first image on any room.
- The moment the Design Specification returns, all rooms' image-generation calls fire **in parallel** (one request per room, concurrently, not sequentially) — total wait is roughly the slowest single room, not every room stacked end to end.
- Each card, while generating, shows a soft blurred/shimmering placeholder **tinted with that room's own colour** (the same colour tag from Room Confirmation) — animated, not a static gray box or bare spinner.
- Cards reveal independently: the moment a given room's image is ready, that card crossfades from blur to sharp. Rooms do not wait for each other.
- A quiet status line at the top ("Generating 3 of 6 rooms…") gives overall progress without blocking anything.
- Already-finished cards are fully interactive (View/Edit) while others are still generating. "Continue to Approval" stays disabled until every room has at least one image — same gating rule as before, just not a forced blocking wait screen.
- **Generate More** gets identical treatment: the card's current image blurs in place (not replaced by a spinner) and crossfades to the new version when ready.

Mechanism note for the eventual implementation plan: this is achievable purely client-side (the gallery page fires N concurrent `fetch` calls to the existing `/api/generate-room-image` route on mount when it detects a fresh Design Specification with no generations yet) — no async job infrastructure needed for this UX, consistent with the base plan's "image generation stays synchronous for MVP" decision.

## 7. View & Edit

Mechanism unchanged (up to 2 numbered lasso regions, one combined edit call). Reveal polish: while the edit call runs, the image stays visible under a soft blur-pulse rather than being replaced by a spinner (it's an edit, not a fresh generation — it should read as the photo developing, not vanishing). Region markers ①② get a subtle live glow. New versions slide into the thumbnail strip with auto-scroll to the newest.

## 8. Approve

Structure unchanged. Feedback polish: the approved thumbnail gets a glowing ring + gentle scale-up instead of a flat border-colour swap. "Include in walkthrough" becomes a custom toggle switch instead of a native checkbox, matching the rest of the product's visual language.

## 9. Walkthrough — rebuilt as a drag-to-reorder timeline

**Current:** a vertical list with chevron move-up/move-down buttons.

**New:** a horizontal, video-editing-timeline-style strip of room clips. Each clip is a thumbnail card with a small title (e.g. "Hall"). The user holds and drags a clip to any position in the sequence; the rest of the clips slide over (left/right) to make room, with spring-physics motion — deliberately playful, distinct from the flat, mechanical reorder buttons it replaces. This is a different interaction from the floor-plan canvas drag the user rejected earlier (repositioning rooms in 2D space) — this is ordering a short list, the same family of interaction as reordering clips in a video editor or tracks in a playlist.

Generation reveal: while the walkthrough assembles (several Veo calls plus `ffmpeg` concatenation, meaningfully longer than a single image), the approved room thumbnails light up in sequence like a filmstrip being assembled, rather than one static "Generating…" spinner — communicates that multiple pieces are being stitched together, not one atomic operation. The finished video scales/fades in rather than snapping into place.

Once the video is ready, three actions sit together on this same screen: **Download**, **Get shareable link** (unchanged, stable `share_token`), and **Export PDF** (new, see Section 10) — no separate Export screen.

## 10. Export — folded into Walkthrough, not a separate screen

The base plan describes Export as its own screen/step. Superseded: once a project's walkthrough is complete, an **Export PDF** button appears alongside Download/Get shareable link on the Walkthrough screen. Clicking it shows an inline "Preparing PDF…" state, then triggers a browser download — no navigation away, no dedicated Export page. Backend: a new route (e.g. `POST /api/export-pdf`) assembling cover page, client name, project details, approved room renders, chosen aesthetic, colour palette, and the walkthrough video link — content unchanged from the base plan, only the screen it lives on changes.

## 11. Profile dashboard

No structural or feature changes — already functionally complete (account card + project list). Visual polish only, for consistency with the rest of the redesigned product: a bold confident heading (matching the "every heading is bold, big, confident" hard rule already in the base design system), hover-lift on each project row, status badges styled consistently with badges used elsewhere.

## 12. Backend: real per-user data ownership + Admin console (bundled)

**Problem:** `src/lib/project-sync.tsx` persists every project under a random `localStorage`-held anonymous ID, not the authenticated Supabase user — real login exists but is disconnected from where project data actually lives. Separately, no API route (`/api/generate-room-image`, `/api/render`, `/api/edit-room-image`, `/api/generate-walkthrough`, `/api/design-plan`, `/api/parse-plan`, the new extraction route, the new export route) checks a session server-side.

**Fix, bundled with building the Admin console** (per user decision — this is where per-user data starts mattering for a real "Users" table anyway):
- Wire the already-existing `projects.status`/`projects.manifest` schema (built in the base plan's Workstream 3, never wired to a live page) into the real flow, keyed to `auth.users.id` instead of the anonymous browser ID. This is the point `project_snapshots`/`project-sync.tsx`'s anonymous-owner model gets retired for logged-in usage.
- Every API route above gets a server-side `requireUser()`/`requireRole()` check (`src/lib/auth/session.ts` already has these helpers, just unused in API routes today).
- `/api/render`'s `GET` handler gets an auth check and moves toward signed/expiring URLs (or an authenticated proxy), per the base plan's Security section — currently fully open to anyone with a key.
- Admin console (`app/console/`, gated `role = 'master'`): Users tab (search, status, generation count, lifetime cost, Trial/Suspend/Activate/Extend/Delete, "New User" using `supabase.auth.admin.createUser`), Prompt Management tab (view/edit/publish `prompt_templates`), Project Monitoring tab (browse all clients' projects/status, drill into generation logs), stat cards (Users, Spend by period, Lifetime spend, Pending approvals), Approvals tab present but stubbed (matches the base plan's reasoning — no self-serve signup exists to populate it).

## 13. Remaining backend items (unchanged from base plan, reordered)

- **Version history** (`generations` table) — currently version arrays live only in the client-side store; move to a real table so Approve's thumbnail strips and Admin's Project Monitoring read from the same durable source.
- **Remaining security hardening**: per-user rate limiting on AI-triggering routes, CSRF same-origin checks on state-changing routes, an audit that no API response leaks prompt text/Design Specification contents/provider identifiers.
- **Targeted cleanup** (confirmed scope — not a full repo sweep): the stale comment in `src/lib/ai/provider.ts` claiming `flux-client.ts` is "deliberately left as-is" (the file is already gone); the `approvals` table referenced in `VASTOS_REVAMP_PLAN.md`'s prose but absent from `supabase/schema.sql`; unused legacy tables left over from the destroyed old 3D studio (`placed_items`, `scenes`, `renders`, `render_versions`) — confirm nothing reads/writes them, then drop in a migration; delete `DetectionOverlay`, `PlanEditor`'s canvas/drag code, and (pending final confirmation) `ocr.ts`/`semantic.ts`/`merge.ts` per Section 1.

## Build order

1. Extraction re-engineer (Section 1) + Upload screen changes (Section 2) + Room Confirmation rebuild (Section 3) + no-floor-plan reuse (Section 4) — the foundational fresh-start boundary; everything downstream consumes this shape.
2. Generate Gallery auto-parallel generation + blur/reveal motion system (Section 6) — build the reusable "generating card" component here since Sections 7-9 reuse its visual language.
3. View & Edit and Approve polish (Sections 7-8) — smaller, reuses the Section 2 component.
4. Walkthrough timeline rebuild + Export fold-in (Sections 9-10) — new drag-reorder interaction, new PDF route.
5. Profile dashboard polish (Section 11) — trivial, do anytime, listed last only because it's lowest-stakes.
6. Real auth/data-ownership + Admin console (Section 12).
7. Version history + remaining security hardening (Section 13).
8. Targeted cleanup (Section 13), including the final call on `ocr.ts`/`semantic.ts`/`merge.ts` deletion.

## Design system (carried forward, unchanged)

Dark, premium, minimal. Google Sans typography. Every heading bold/big/confident. Every interactive element responds to the cursor (`.hover-lift` pattern, hover-lift + border-glow, 200-300ms ease-out). Small purposeful icons only. Mild gradients only, never neon. No em dashes in UI copy. No orphan buttons — everything shipped here maps to a concrete job above. New addition from this pass: AI-wait states are shown as something visibly forming (blur-to-crossfade, colour-tinted per room, filmstrip sequencing) rather than blocking spinners, consistently across Sections 2, 6, 7, and 9. All motion uses `transform`/`opacity` only (no layout-triggering properties) and respects `prefers-reduced-motion`.
