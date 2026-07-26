# Extraction & Room Confirmation Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OCR+OpenCV+semantic+merge floor-plan pipeline with one Gemini Vision extraction call, and rebuild Upload/Room Confirmation/the no-floor-plan path around it with no spatial canvas anywhere.

**Architecture:** A new `extractFloorPlan` provider function (Gemini vision + JSON schema, in `src/lib/ai/provider.ts`) replaces four pipeline stages. A new orchestrator (`src/lib/pipeline/extract-plan.ts`) shapes its output into the existing `FloorPlan`/`Room` types and grid-packs cosmetic positions (nothing downstream needs real spatial geometry anymore, but `PlanThumb` on the dashboard project list still reads `room.x/y`, so positions stay populated, just not meaningful). The old async Inngest job path is retired — the new call is a single fast request, so `/api/parse-plan` becomes a plain synchronous route like `/api/design-plan`. Upload and Room Confirmation are rebuilt as plain, non-spatial screens.

**Tech Stack:** Next.js 16 App Router, TypeScript, Zustand (`useVasto` store), Gemini REST API via the existing `generateJson` client — no new dependencies.

## Global Constraints

- No test runner is configured in this repo (confirmed in `CLAUDE.md` and `package.json`). Every task below verifies behavior by running `npm run dev` and exercising the real flow in a browser, plus `npm run lint` and `npx tsc --noEmit` for static checks — there are no automated test files to write or run.
- `scripts/parse_plan.py`, `scripts/detect_rooms_labeled.py`, `src/lib/pipeline/opencv.ts` are explicitly **not touched** in this plan (user's own future call on wall detection). Do not delete or modify them.
- No em dashes in any UI copy. Every heading bold/big/confident. Every interactive element gets `.hover-lift`-style hover feedback. Follow the existing dark/premium visual language already in `src/app/globals.css` and the components read during planning — do not introduce a new design language.
- Room `x`/`y` positions produced by the new pipeline are **cosmetic grid placement only**, not real spatial geometry — never present them to the user as accurate layout (no canvas renders them in this plan).
- Commit after every task.

---

### Task 1: Shared room colour palette

**Files:**
- Modify: `src/lib/utils.ts`

**Interfaces:**
- Produces: `ROOM_PALETTE: string[]` (10 hex colours), exported from `src/lib/utils.ts` — consumed by Task 4 (extraction orchestrator) and Task 9 (Room Confirmation's "Add room" form, replacing its current local copy).

- [ ] **Step 1: Add the palette constant**

`src/lib/utils.ts` currently has no room-colour constant — it lives only as a local `const ROOM_PALETTE` inside `src/app/projects/[id]/review/page.tsx` today. Add this export (copy the existing 10 colours verbatim so no visual identity changes):

```typescript
/** Palette assigned to rooms by index — shared by the extraction pipeline and the Room Confirmation "Add room" form so a room's colour never changes as it moves between screens. */
export const ROOM_PALETTE = [
  "#e6a45c", "#6da8e2", "#5cc98a", "#d4972a", "#b98ce2",
  "#e27d9a", "#6dc7e2", "#8ac98a", "#c98a8a", "#8a9ec9",
] as const;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no new errors (the export is additive; nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/utils.ts
git commit -m "Add shared ROOM_PALETTE constant to utils"
```

---

### Task 2: `extractFloorPlan` provider function

**Files:**
- Modify: `src/lib/ai/provider.ts`

**Interfaces:**
- Consumes: `generateJson<T>(parts: GeminiPart[], opts: GenerateOptions): Promise<T | null>` and `type GeminiPart` from `src/lib/pipeline/gemini-client.ts` (existing, unchanged); `downscaleForGemini(bytes: Buffer): Promise<{ mimeType: string; data: string }>` from `src/lib/pipeline/image-utils.ts` (existing, already used by `pipeline/ocr.ts` the same way).
- Produces: `extractFloorPlan(bytes: Buffer, mimeType: string, roomTypeHints: string[], ctx?: CallContext): Promise<RawExtraction>` and `export interface RawExtraction { rooms: RawExtractedRoom[]; confidence: number; readable: boolean }` / `export interface RawExtractedRoom { name: string; type?: string; widthFt?: number; heightFt?: number; openings: RawOpening[] }` / `export interface RawOpening { kind: "door" | "window"; side: "north" | "south" | "east" | "west"; connectsTo?: string }` — all exported from `src/lib/ai/provider.ts`, consumed by Task 4's orchestrator.

- [ ] **Step 1: Add the import and types**

In `src/lib/ai/provider.ts`, add to the existing import block (near the top, alongside the other `pipeline/*` imports):

```typescript
import { downscaleForGemini } from "@/lib/pipeline/image-utils";
```

Then add these exported types, placed after the existing `GeneratedImage` interface (around where `generateImage` is defined):

```typescript
export interface RawOpening {
  kind: "door" | "window";
  side: "north" | "south" | "east" | "west";
  /** another room's name, "exterior", or omitted if the model couldn't tell */
  connectsTo?: string;
}

export interface RawExtractedRoom {
  /** verbatim as printed/labeled on the plan — never normalized */
  name: string;
  /** classified type, ideally one of the caller's roomTypeHints */
  type?: string;
  widthFt?: number;
  heightFt?: number;
  openings: RawOpening[];
}

export interface RawExtraction {
  rooms: RawExtractedRoom[];
  /** 0..1 overall extraction confidence, the model's own self-assessment */
  confidence: number;
  /** false when the model could not make sense of this as a floor plan at all */
  readable: boolean;
}
```

- [ ] **Step 2: Add the schema and function**

Add after the types from Step 1, still in `src/lib/ai/provider.ts`:

```typescript
const PLAN_EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    readable: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    rooms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          type: { type: "STRING" },
          widthFt: { type: "NUMBER" },
          heightFt: { type: "NUMBER" },
          openings: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                kind: { type: "STRING", enum: ["door", "window"] },
                side: { type: "STRING", enum: ["north", "south", "east", "west"] },
                connectsTo: { type: "STRING" },
              },
              required: ["kind", "side"],
            },
          },
        },
        required: ["name", "openings"],
      },
    },
  },
  required: ["readable", "confidence", "rooms"],
} as const;

interface RawExtractionResponse {
  readable?: boolean;
  confidence?: number;
  rooms?: {
    name?: string;
    type?: string;
    widthFt?: number;
    heightFt?: number;
    openings?: { kind?: string; side?: string; connectsTo?: string }[];
  }[];
}

/**
 * Single-call floor-plan extraction — replaces the old OCR + OpenCV geometry +
 * semantic + merge pipeline. Reads room names verbatim, classifies each into a
 * type (preferring roomTypeHints when the project's category has a fixed
 * list), reads printed dimensions where legible, and reports door/window
 * presence per room with a rough side and connection. `readable: false` is
 * the model's own signal that this image doesn't look like a floor plan it
 * can extract from — callers route that to manual entry, never a fabricated
 * result.
 */
export async function extractFloorPlan(
  bytes: Buffer,
  mimeType: string,
  roomTypeHints: string[],
  ctx?: CallContext,
): Promise<RawExtraction> {
  const img = await downscaleForGemini(bytes);
  const hints = roomTypeHints.length
    ? `Prefer one of these types when it fits: ${roomTypeHints.join(", ")}. If none fit, use your own best short label.`
    : `This project type has no fixed room-type list — use your own best short label (e.g. "Bedroom", "Kitchen").`;

  const prompt = `You are reading an architectural floor plan image to extract its rooms.

For each room you can identify, return:
- "name": the room's label EXACTLY as printed on the plan (e.g. "KIDS", "Hall", "M. Bedroom"). Never invent a name if none is printed — use a short generic description instead (e.g. "Unlabeled room").
- "type": a classification of what kind of room this is, based on its printed name and typical layout position. ${hints}
- "widthFt"/"heightFt": only if a dimension is actually printed near the room (e.g. "12'3\"X9'1\""), converted to decimal feet. Omit both if nothing is legible — never estimate or guess a size.
- "openings": every door and window you can see on this room's walls. For each: "kind" (door or window), "side" (which wall of the room it's on: north/south/east/west, using the plan's own up-is-north orientation), "connectsTo" (the name of the room on the other side of a door, or "exterior" for an outer wall or a window). Omit anything you can't confidently see.

Also return:
- "confidence": your own 0 to 1 confidence that this extraction is accurate and complete.
- "readable": false if this image does not look like a floor plan you can meaningfully extract rooms from at all (e.g. it's blank, unrelated, or too unclear to read), true otherwise.

Return only rooms you can actually identify. Never fabricate a room, dimension, or opening that isn't legible in the image.`;

  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: prompt },
  ];

  return instrumented("planning", process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash", ctx, async () => {
    const raw = await generateJson<RawExtractionResponse>(parts, {
      temperature: 0.1,
      responseSchema: PLAN_EXTRACTION_SCHEMA,
    });
    if (!raw) throw new ProviderError("AiProviderError", "floor plan extraction failed");

    const sides = new Set(["north", "south", "east", "west"]);
    const rooms: RawExtractedRoom[] = (raw.rooms ?? [])
      .filter((r): r is typeof r & { name: string } => !!r.name?.trim())
      .map((r) => ({
        name: r.name.trim(),
        type: r.type?.trim() || undefined,
        widthFt: typeof r.widthFt === "number" && r.widthFt > 0 ? r.widthFt : undefined,
        heightFt: typeof r.heightFt === "number" && r.heightFt > 0 ? r.heightFt : undefined,
        openings: (r.openings ?? [])
          .filter((o) => (o.kind === "door" || o.kind === "window") && sides.has(o.side ?? ""))
          .map((o) => ({
            kind: o.kind as "door" | "window",
            side: o.side as "north" | "south" | "east" | "west",
            connectsTo: o.connectsTo?.trim() || undefined,
          })),
      }));

    return {
      rooms,
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      readable: raw.readable !== false && rooms.length > 0,
    };
  });
}
```

Note: `instrumented`, `ProviderError`, `generateJson`, and `GeminiPart` are already imported/defined in this file (used by `generateStructured` just above) — no new imports needed for those.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `npm run lint`
Expected: clean (matches existing file's lint conventions).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/provider.ts
git commit -m "Add extractFloorPlan: single-call Gemini vision floor-plan extraction"
```

---

### Task 3: Pipeline orchestrator — map extraction into `FloorPlan`

**Files:**
- Create: `src/lib/pipeline/extract-plan.ts`

**Interfaces:**
- Consumes: `extractFloorPlan(bytes, mimeType, roomTypeHints, ctx?)` from Task 2; `ROOM_PALETTE` from Task 1; `Room`, `FloorPlan`, `PlanMeta` from `src/lib/types.ts` (existing); `RoomOpening`, `OpeningSide` from `src/lib/pipeline/assign-openings.ts` (existing type only — the deterministic assignment function itself is no longer called, see Task 12).
- Produces: `runPlanExtraction(input: ExtractPlanInput): Promise<ExtractPlanResult>`, `export interface ExtractPlanInput { bytes: Buffer; mimeType: string; fileName: string; roomTypeHints: string[] }`, `export interface ExtractPlanResult { plan: FloorPlan; readable: boolean; confidence: number }` — consumed by Task 5 (`/api/parse-plan` route).

- [ ] **Step 1: Write the file**

```typescript
/**
 * Extraction pipeline orchestrator — the single entry point that replaces
 * the old OCR + OpenCV geometry + semantic + merge pipeline (see
 * docs/superpowers/specs/2026-07-26-fresh-start-frontend-and-extraction-design.md,
 * Section 1). Calls the one-shot Gemini extraction, maps its output onto the
 * existing FloorPlan/Room shape, and assigns each room a colour + a cosmetic
 * grid position (nothing in the new flow reads position spatially, but
 * `PlanThumb` on the dashboard project list still renders room.x/y, so a
 * position is always populated).
 */

import { randomUUID } from "node:crypto";
import { extractFloorPlan, type RawExtractedRoom } from "@/lib/ai/provider";
import { ROOM_PALETTE } from "@/lib/utils";
import type { FloorPlan, Room } from "@/lib/types";
import type { OpeningSide, RoomOpening } from "./assign-openings";

export interface ExtractPlanInput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  /** the active project category's room-type list, e.g. from getProjectTypeConfig(category).roomTypes */
  roomTypeHints: string[];
}

export interface ExtractPlanResult {
  plan: FloorPlan;
  /** false when the model couldn't read this as a floor plan at all */
  readable: boolean;
  confidence: number;
}

const DEFAULT_ROOM_SIZE_FT = 10;
/** Grid packing constants — cosmetic only, see file header. */
const GRID_GAP_FT = 2;
const GRID_COLS = 4;

export async function runPlanExtraction(input: ExtractPlanInput): Promise<ExtractPlanResult> {
  const raw = await extractFloorPlan(input.bytes, input.mimeType, input.roomTypeHints);

  if (!raw.readable || raw.rooms.length === 0) {
    return {
      plan: emptyPlan(),
      readable: false,
      confidence: raw.confidence,
    };
  }

  const rooms = packRoomsGrid(raw.rooms.map((r, i) => toRoom(r, i)));
  const planWidth = Math.max(...rooms.map((r) => r.x + r.width), DEFAULT_ROOM_SIZE_FT);
  const planHeight = Math.max(...rooms.map((r) => r.y + r.height), DEFAULT_ROOM_SIZE_FT);

  const plan: FloorPlan = {
    fileName: input.fileName,
    planWidth,
    planHeight,
    rooms,
    doors: [],
    windows: [],
    meta: {
      source: "manual",
      confidence: raw.confidence,
    },
  };

  return { plan, readable: true, confidence: raw.confidence };
}

/** An empty plan for the no-floor-plan path and the low-confidence fallback — both land here, then the user adds rooms manually. */
export function emptyPlan(fileName = ""): FloorPlan {
  return {
    fileName,
    planWidth: DEFAULT_ROOM_SIZE_FT,
    planHeight: DEFAULT_ROOM_SIZE_FT,
    rooms: [],
    doors: [],
    windows: [],
    meta: { source: "manual" },
  };
}

function toRoom(r: RawExtractedRoom, index: number): Room {
  const width = r.widthFt ?? DEFAULT_ROOM_SIZE_FT;
  const height = r.heightFt ?? DEFAULT_ROOM_SIZE_FT;
  return {
    id: randomUUID(),
    name: r.name,
    type: r.type,
    width,
    height,
    x: 0,
    y: 0,
    color: ROOM_PALETTE[index % ROOM_PALETTE.length],
    openings: r.openings.map((o) => toRoomOpening(o)),
  };
}

function toRoomOpening(o: RawExtractedRoom["openings"][number]): RoomOpening {
  return {
    type: o.kind,
    side: o.side as OpeningSide,
    connectsTo: o.connectsTo ?? null,
  };
}

/**
 * Lays rooms out left-to-right, wrapping every GRID_COLS, purely so the
 * dashboard's PlanThumb has non-overlapping boxes to draw — not a claim
 * about the plan's real layout. Room Confirmation's list UI never reads
 * these positions.
 */
function packRoomsGrid(rooms: Room[]): Room[] {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  return rooms.map((room, i) => {
    if (i > 0 && i % GRID_COLS === 0) {
      cursorX = 0;
      cursorY += rowHeight + GRID_GAP_FT;
      rowHeight = 0;
    }
    const placed = { ...room, x: cursorX, y: cursorY };
    cursorX += room.width + GRID_GAP_FT;
    rowHeight = Math.max(rowHeight, room.height);
    return placed;
  });
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no type errors. `RoomOpening`/`OpeningSide` import from `assign-openings.ts` must resolve — that file still exists at this point (it's deleted in Task 12, after this task).

- [ ] **Step 3: Commit**

```bash
git add src/lib/pipeline/extract-plan.ts
git commit -m "Add extraction pipeline orchestrator mapping Gemini output to FloorPlan"
```

---

### Task 4: Simplify `/api/parse-plan` to a plain synchronous route

**Files:**
- Modify: `src/app/api/parse-plan/route.ts`

**Interfaces:**
- Consumes: `runPlanExtraction(input: ExtractPlanInput): Promise<ExtractPlanResult>` from Task 3; `putObject(key: string, bytes: Buffer, mimeType: string): Promise<StorageRef>` from `src/lib/pipeline/storage.ts` (existing, unchanged).
- Produces: `POST /api/parse-plan` now returns `{ plan: FloorPlan; readable: boolean; confidence: number }` directly (200) or `{ error: string }` (4xx/5xx) — no `jobId`/`mode`, no `GET` handler. Consumed by Task 6 (`parse-plan-client.ts`).

- [ ] **Step 1: Replace the route**

The old route (Inngest job creation, `normalizePlanImage` upscaling, sync/async branching, `GET` polling) is replaced entirely. Image upscaling for small screenshots is still valuable (the old file's comment explains why — tiny CAD screenshots are illegible otherwise) and Gemini vision benefits from it the same way OCR did, so that logic is kept, trimmed to what this route needs:

```typescript
import sharp from "sharp";
import { runPlanExtraction } from "@/lib/pipeline/extract-plan";
import { putObject } from "@/lib/pipeline/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_LONG_SIDE = 1400;

/** Upscale small plan uploads so printed text/dimensions are legible to Gemini vision — deterministic, no invented detail, just legibility. */
async function normalizePlanImage(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(bytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const long = Math.max(w, h);
    if (!long || long >= MIN_LONG_SIDE) return { bytes, mimeType };
    const factor = Math.min(4, Math.ceil(MIN_LONG_SIDE / long));
    const out = await sharp(bytes)
      .resize(w * factor, h * factor, { kernel: "lanczos3" })
      .png()
      .toBuffer();
    return { bytes: out, mimeType: "image/png" };
  } catch {
    return { bytes, mimeType };
  }
}

/**
 * POST — accept a floor-plan image, store it, extract its rooms in one
 * Gemini vision call. Always returns a plan: `readable: false` means the
 * model couldn't make sense of the image, and the caller routes to manual
 * entry rather than treating this as an error.
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file uploaded" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return Response.json(
        { error: "Only raster images (PNG/JPG) can be parsed. Export PDFs to PNG." },
        { status: 415 },
      );
    }

    const roomTypeHintsParam = form.get("roomTypeHints");
    const roomTypeHints =
      typeof roomTypeHintsParam === "string" && roomTypeHintsParam
        ? roomTypeHintsParam.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    const { bytes, mimeType } = await normalizePlanImage(
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );

    const storageKey = `plans/${crypto.randomUUID()}/${file.name}`;
    await putObject(storageKey, bytes, mimeType);

    const result = await runPlanExtraction({
      bytes,
      mimeType,
      fileName: file.name,
      roomTypeHints,
    });

    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Extraction failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no type errors from this file. (It will still fail overall if Task 6's client hasn't been updated yet — that's expected until Task 6 lands; check this file's own diagnostics specifically if the whole-project check is noisy: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "api/parse-plan"` should be empty.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/parse-plan/route.ts
git commit -m "Simplify /api/parse-plan to a plain synchronous single-call route"
```

---

### Task 5: Simplify `parse-plan-client.ts`

**Files:**
- Modify: `src/lib/parse-plan-client.ts`

**Interfaces:**
- Consumes: the new `POST /api/parse-plan` response shape from Task 4 (`{ plan, readable, confidence }`).
- Produces: `parsePlanViaApi(file: File, opts: ParseOptions): Promise<ParseResult>`, `export interface ParseResult { plan: FloorPlan; readable: boolean; confidence: number }`, `export interface ParseOptions { roomTypeHints?: string[] }` — consumed by Task 7 (Upload page rebuild). The `DetectProgress`/multi-stage callback is dropped entirely — replaced by nothing (Task 7 shows a single indeterminate "reading" animation with no staged percentage, per the design spec).

- [ ] **Step 1: Replace the file**

```typescript
/**
 * Client helper for floor-plan extraction. Posts the image to
 * `POST /api/parse-plan`, which returns the extracted plan in one call — no
 * polling, no staged progress (the old multi-stage pipeline this replaced
 * needed that; a single Gemini vision call doesn't).
 */

import type { FloorPlan } from "./types";

export interface ParseResult {
  plan: FloorPlan;
  /** false when the model couldn't read this as a floor plan at all */
  readable: boolean;
  confidence: number;
}

export interface ParseOptions {
  /** the active project category's room types, so extraction can classify into them */
  roomTypeHints?: string[];
}

export async function parsePlanViaApi(file: File, opts: ParseOptions = {}): Promise<ParseResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts.roomTypeHints?.length) form.append("roomTypeHints", opts.roomTypeHints.join(","));

  const res = await fetch("/api/parse-plan", { method: "POST", body: form });
  if (!res.ok) {
    let msg = `Extraction returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  return (await res.json()) as ParseResult;
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: errors remain in `upload/page.tsx` (Task 7 hasn't updated its usage yet) — that's expected at this point in the plan. No errors in `parse-plan-client.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/lib/parse-plan-client.ts
git commit -m "Simplify parse-plan-client to the single-call extraction shape"
```

---

### Task 6: Delete `DetectionOverlay`

**Files:**
- Delete: `src/components/project/detection-overlay.tsx`

**Interfaces:**
- None — this component is deleted, not replaced. Task 7 removes its only import.

- [ ] **Step 1: Confirm it will have no remaining callers after Task 7**

Run: `grep -rn "DetectionOverlay" src --include=*.tsx --include=*.ts`
Expected right now: one hit in `src/app/projects/[id]/upload/page.tsx` (removed in Task 7) and the definition itself in `detection-overlay.tsx`.

- [ ] **Step 2: Delete the file**

```bash
git rm src/components/project/detection-overlay.tsx
```

- [ ] **Step 3: Commit**

(Combine with Task 7's commit if executing sequentially without a gap — otherwise commit standalone:)

```bash
git commit -m "Delete DetectionOverlay (superseded by direct-to-Room-Confirmation flow)"
```

---

### Task 7: Rebuild the Upload page

**Files:**
- Modify: `src/app/projects/[id]/upload/page.tsx`

**Interfaces:**
- Consumes: `parsePlanViaApi(file, opts)` / `ParseResult` from Task 5; `useProject`, `useVasto` from `src/lib/store.ts` (existing `setFloorPlan`, `setStatus`); `categoryForPropertyType`, `getProjectTypeConfig` from `src/lib/project-types/config.ts` (existing).
- Produces: on successful readable extraction, calls `router.push(`/projects/${id}/review`)` directly (no intermediate results screen). On `readable: false`, shows an inline message with a "Switch to manual entry" button that also navigates to `/review` (with an empty floor plan already set via Task 3's `emptyPlan()`, applied in Task 9's review-page empty state — this task only needs to navigate there, Task 9 handles what an empty arrival looks like).

- [ ] **Step 1: Replace the file**

```tsx
"use client";

import { useCallback, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { parsePlanViaApi } from "@/lib/parse-plan-client";
import { emptyPlan } from "@/lib/pipeline/extract-plan";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Stage = "idle" | "selected" | "detecting";

interface Selected {
  file: File;
  name: string;
  url?: string;
  isImage: boolean;
}

export default function UploadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);

  const [stage, setStage] = useState<Stage>("idle");
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const url = isImage ? URL.createObjectURL(file) : undefined;
    setSelected({ file, name: file.name, url, isImage });
    setError(null);
    setUnreadable(false);
    setStage("selected");
  }, []);

  const runDetection = useCallback(async () => {
    if (!selected || !project) return;
    setError(null);
    setUnreadable(false);

    if (!selected.isImage) {
      setError("PDFs can't be analyzed yet — export the plan as a PNG or JPG and re-import.");
      return;
    }

    setStatus(id, "parsing");
    setStage("detecting");
    try {
      const category = categoryForPropertyType(project.propertyType);
      const roomTypeHints = getProjectTypeConfig(category)?.roomTypes ?? [];
      const result = await parsePlanViaApi(selected.file, { roomTypeHints });
      if (!result.readable) {
        setUnreadable(true);
        setStatus(id, "draft");
        setStage("selected");
        return;
      }
      setFloorPlan(id, result.plan);
      setStatus(id, "parsed");
      router.push(`/projects/${id}/review`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed");
      setStatus(id, "draft");
      setStage("selected");
    }
  }, [selected, project, id, setFloorPlan, setStatus, router]);

  const goManual = useCallback(() => {
    setFloorPlan(id, emptyPlan());
    setStatus(id, "parsed");
    router.push(`/projects/${id}/review`);
  }, [id, setFloorPlan, setStatus, router]);

  const reset = useCallback(() => {
    setSelected(null);
    setError(null);
    setUnreadable(false);
    setStage("idle");
  }, []);

  if (!project) return null;

  // ---- DETECTING: single-call extraction in flight ----
  if (stage === "detecting") {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-md">
          <div className="relative mx-auto mb-8 aspect-[16/10] w-full overflow-hidden rounded-2xl border border-border bg-grid bg-bg">
            {selected?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selected.url}
                alt=""
                className="absolute inset-0 h-full w-full object-contain opacity-60"
              />
            )}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute inset-x-0 h-1/3 animate-[vasto-sweep_1.8s_ease-in-out_infinite] bg-gradient-to-b from-transparent via-accent/25 to-transparent" />
            </div>
            <div className="absolute inset-0 ring-1 ring-inset ring-accent/30" />
          </div>
          <p className="flex items-center justify-center gap-2 text-sm font-medium">
            <Icon name="Sparkles" className="size-4 text-accent" />
            Reading your floor plan…
          </p>
          <p className="mt-2 text-center text-xs text-faint">
            Finding rooms, dimensions, doors and windows.
          </p>
        </div>
      </div>
    );
  }

  // ---- SELECTED: preview + Analyze button (also the low-confidence retry state) ----
  if (stage === "selected" && selected) {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-xl">
          <div className="hover-lift rounded-2xl border border-border bg-surface p-4 transition-colors">
            <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border bg-grid bg-bg">
              {selected.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.url}
                  alt={selected.name}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center">
                  <div className="text-center">
                    <Icon name="FileUp" className="mx-auto size-10 text-faint" />
                    <p className="mt-2 text-sm text-muted">PDF document</p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center gap-2 text-sm">
              <Icon name="Image" className="size-4 text-accent" />
              <span className="truncate font-medium">{selected.name}</span>
            </div>

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
                <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {unreadable && (
              <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-3 text-sm text-warning">
                <p className="flex items-center gap-2 font-medium">
                  <Icon name="CircleAlert" className="size-4 shrink-0" />
                  This plan couldn&apos;t be read automatically.
                </p>
                <p className="mt-1 text-xs">
                  Try a clearer image, or switch to manual entry and add your rooms yourself.
                </p>
                <Button size="sm" variant="outline" className="mt-2.5" icon="ListPlus" onClick={goManual}>
                  Switch to manual entry
                </Button>
              </div>
            )}

            {!selected.isImage && (
              <p className="mt-2 text-xs text-warning">
                PDFs can&apos;t be analyzed automatically. Export the plan as a PNG or JPG.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="ghost" icon="ArrowLeft" onClick={reset}>
                Choose another
              </Button>
              <Button icon="Sparkles" onClick={runDetection}>
                Analyze floor plan
              </Button>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            Reads rooms, dimensions, doors and windows automatically — everything is
            reviewable and editable on the next screen.
          </p>
        </div>
      </div>
    );
  }

  // ---- IDLE: dropzone ----
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-2xl">
        <div className="mb-7 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Upload your floor plan</h2>
          <p className="mt-2 text-muted">Vastos reads rooms, dimensions and openings automatically.</p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "group cursor-pointer rounded-3xl border-2 border-dashed bg-surface/40 px-6 py-20 text-center transition-all duration-200",
            drag
              ? "scale-[1.01] border-accent bg-accent/5"
              : "border-border hover:border-border-strong hover:bg-surface/60",
          )}
        >
          <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-accent/10 text-accent transition-transform duration-200 group-hover:scale-110">
            <Icon name="Upload" className="size-8" />
          </div>
          <p className="mt-4 text-lg font-medium">
            Drag & drop, or <span className="text-accent">browse</span>
          </p>
          <p className="mt-1 text-sm text-muted">Supports JPG, PNG and PDF · up to 25 MB</p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the sweep keyframe**

Search `src/app/globals.css` for the existing `vasto-pulse` keyframe (used by the old detecting state) and add a sibling `vasto-sweep` keyframe next to it:

```css
@keyframes vasto-sweep {
  0% { top: -34%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, open a project through to `/projects/[id]/upload`.
- Drop/select an image → preview shows, no console errors.
- Click "Analyze floor plan" → the sweep animation plays (not a percentage bar), then either lands on `/review` with rooms populated, or (if `GEMINI_API_KEY` is unset, which makes `extractFloorPlan` throw inside `generateJson` returning null → `ProviderError`) shows the inline error state — confirm the error path renders without crashing.
- Confirm no reference to `DetectionOverlay` or `DetectProgress` remains anywhere in this file.

- [ ] **Step 4: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors in `upload/page.tsx`.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/projects/[id]/upload/page.tsx src/app/globals.css
git commit -m "Rebuild Upload page: single-call extraction, no detected-geometry screen"
```

---

### Task 8: Add `ft-in` unit helper check (no-op verification)

Skip — `src/lib/units.ts` (`formatLength`, `feetToFtIn`, `ftInToFeet`, `fromFeet`, `toFeet`) is unchanged by this plan and already used correctly by the current Room Confirmation; Task 9 reuses it as-is. This task intentionally left as a placeholder-free no-op is itself a violation of the "no placeholders" rule, so it is removed — proceed directly to Task 9.

---

### Task 9: Rebuild Room Confirmation as a plain list

**Files:**
- Modify: `src/app/projects/[id]/review/page.tsx`

**Interfaces:**
- Consumes: `useProject`, `useVasto` (`updateRoom`, `removeRoom`, `addRoom`, `patchProject`) from `src/lib/store.ts` (existing, unchanged signatures); `formatLength`, `fromFeet`, `ftInToFeet`, `feetToFtIn`, `toFeet` from `src/lib/units.ts` (existing, unchanged); `categoryForPropertyType`, `getProjectTypeConfig` from `src/lib/project-types/config.ts` (existing); `ROOM_PALETTE` from `src/lib/utils.ts` (Task 1, replaces the local copy); `UNITS` from `src/lib/data.ts` (existing).
- Produces: no new exports — this is a page component. Removes the `PlanEditor`/`analyzePlan`/`tidyLayout`/`plan-geometry` imports entirely (Task 10 deletes their source files once this is the last caller).

- [ ] **Step 1: Replace the file**

```tsx
"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { formatLength, fromFeet, ftInToFeet, feetToFtIn, toFeet } from "@/lib/units";
import { UNITS } from "@/lib/data";
import { ROOM_PALETTE, cn, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Room, Unit } from "@/lib/types";

function openingCounts(room: Room) {
  const openings = room.openings ?? [];
  return {
    doors: openings.filter((o) => o.type === "door").length,
    windows: openings.filter((o) => o.type === "window").length,
  };
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const updateRoom = useVasto((s) => s.updateRoom);
  const removeRoom = useVasto((s) => s.removeRoom);
  const addRoom = useVasto((s) => s.addRoom);
  const patchProject = useVasto((s) => s.patchProject);
  const [addingRoom, setAddingRoom] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  if (!project) return null;

  const plan = project.floorPlan;
  const rooms = plan?.rooms ?? [];
  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];
  const referenceImage = plan?.previewUrl;

  const goToDesign = () => router.push(`/projects/${id}/design`);

  const confirmDelete = (roomId: string) => {
    removeRoom(id, roomId);
    setPendingDeleteId(null);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-2 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Room Confirmation</h2>
            <p className="mt-1 text-sm text-muted">
              {rooms.length > 0
                ? `${rooms.length} room${rooms.length === 1 ? "" : "s"} found — review and correct anything below.`
                : "No rooms yet — add your first one below."}
            </p>
          </div>
          <UnitSelect value={unit} onChange={(u) => patchProject(id, { units: u })} />
        </div>

        {referenceImage && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
            <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-grid bg-bg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceImage} alt="Uploaded floor plan" className="h-full w-full object-contain" />
            </div>
            <p className="text-xs text-muted">Your uploaded plan, for reference only.</p>
          </div>
        )}

        <div className="space-y-2.5">
          {rooms.map((room, i) => {
            const { doors, windows } = openingCounts(room);
            return (
              <div
                key={room.id}
                className="hover-lift animate-fade-up rounded-2xl border border-border bg-surface p-4 transition-colors"
                style={{ animationDelay: `${Math.min(i, 10) * 60}ms` }}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="size-3 shrink-0 rounded-sm" style={{ background: room.color }} />

                  <input
                    value={room.name}
                    onChange={(e) => updateRoom(id, room.id, { name: e.target.value })}
                    className="input min-w-0 flex-1 font-medium"
                    aria-label="Room name"
                  />

                  <select
                    value={room.type ?? ""}
                    onChange={(e) => updateRoom(id, room.id, { type: e.target.value || undefined })}
                    className="input w-40 shrink-0 cursor-pointer"
                    aria-label="Room type"
                  >
                    <option value="">Unset type</option>
                    {roomTypes.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>

                  <DimensionInline
                    label="W"
                    feet={room.width}
                    unit={unit}
                    onChange={(v) => updateRoom(id, room.id, { width: v })}
                  />
                  <DimensionInline
                    label="H"
                    feet={room.height}
                    unit={unit}
                    onChange={(v) => updateRoom(id, room.id, { height: v })}
                  />

                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
                    <Icon name="DoorClosed" className="size-3" /> {doors}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
                    <Icon name="Frame" className="size-3" /> {windows}
                  </span>

                  <Button
                    size="icon"
                    variant="ghost"
                    icon="Trash2"
                    aria-label="Delete room"
                    onClick={() => setPendingDeleteId(room.id)}
                  />
                </div>

                {pendingDeleteId === room.id && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                    <Icon name="CircleAlert" className="size-3.5 shrink-0" />
                    <span className="flex-1">
                      This room will be deleted. You can still add it back with Add room.
                    </span>
                    <button
                      onClick={() => confirmDelete(room.id)}
                      className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setPendingDeleteId(null)}
                      className="cursor-pointer text-faint hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {rooms.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center">
              <Icon name="ListPlus" className="mx-auto size-7 text-faint" />
              <p className="mt-3 text-sm text-muted">Add your first room to get started.</p>
            </div>
          )}
        </div>

        <div className="mt-4">
          {addingRoom ? (
            <AddRoomForm
              roomTypes={roomTypes}
              paletteIndex={rooms.length}
              onAdd={(room) => {
                addRoom(id, room);
                setAddingRoom(false);
              }}
              onCancel={() => setAddingRoom(false)}
            />
          ) : (
            <button
              onClick={() => setAddingRoom(true)}
              className="hover-lift flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface/60 py-4 text-sm font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              <Icon name="Plus" className="size-4" /> Add room
            </button>
          )}
        </div>

        <div className="mt-8 flex justify-end">
          <Button iconRight="ArrowRight" disabled={rooms.length === 0} onClick={goToDesign}>
            Continue to Design
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddRoomForm({
  roomTypes,
  paletteIndex,
  onAdd,
  onCancel,
}: {
  roomTypes: string[];
  paletteIndex: number;
  onAdd: (room: Room) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [width, setWidth] = useState("10");
  const [height, setHeight] = useState("10");

  const submit = () => {
    const w = Math.max(2, Number(width) || 10);
    const h = Math.max(2, Number(height) || 10);
    onAdd({
      id: uid("room"),
      name: name.trim() || "New room",
      type: type || undefined,
      x: 0,
      y: 0,
      width: w,
      height: h,
      color: ROOM_PALETTE[paletteIndex % ROOM_PALETTE.length],
    });
  };

  return (
    <div className="space-y-2.5 rounded-2xl border border-border bg-surface-2 p-4">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Room name"
        className="input"
      />
      <div className="grid grid-cols-3 gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="input cursor-pointer">
          <option value="">Type</option>
          {roomTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="number"
          inputMode="decimal"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="Width ft"
          className="input"
        />
        <input
          type="number"
          inputMode="decimal"
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          placeholder="Height ft"
          className="input"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" icon="Plus" onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}

function UnitSelect({ value, onChange }: { value: Unit; onChange: (u: Unit) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Unit)}
      className="input cursor-pointer !py-1.5 text-xs"
      aria-label="Units"
    >
      {UNITS.map((u) => (
        <option key={u.id} value={u.id}>{u.label}</option>
      ))}
    </select>
  );
}

function DimensionInline({
  label,
  feet,
  unit,
  onChange,
}: {
  label: string;
  feet: number;
  unit: Unit;
  onChange: (feet: number) => void;
}) {
  if (unit === "ft-in") {
    const { ft, inches } = feetToFtIn(feet);
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
        {label}
        <input
          type="number"
          value={ft}
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches))}
          className="input w-14"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches}
          onChange={(e) => onChange(ftInToFeet(ft, Number(e.target.value) || 0))}
          className="input w-12"
          aria-label={`${label} inches`}
        />
        <span className="text-faint">in</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
      {label}
      <input
        type="number"
        value={fromFeet(feet, unit)}
        onChange={(e) => onChange(toFeet(Number(e.target.value) || 0, unit))}
        className="input w-16"
        aria-label={label}
      />
      <span className="text-faint">{unit}</span>
    </span>
  );
}
```

Note: `formatLength` is imported but only used if you want a read-only summary line — this rebuild keeps dimensions always editable inline (matching the design spec's "dimensions with the existing unit selector" requirement) so `formatLength` ends up unused; remove that import if `tsc`/lint flags it as unused after Step 2 below.

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors in `review/page.tsx`. If `formatLength` is reported unused, remove it from the import line.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, navigate to `/projects/[id]/review` for a project with rooms already in the store (or run the Upload flow from Task 7 first).
- Rows render, staggered fade-in visible.
- Edit name/type/dimensions inline, confirm the store updates (check via React DevTools or by navigating away and back).
- Click delete on a room → confirm popup appears with the exact copy "This room will be deleted. You can still add it back with Add room." → Cancel keeps it, Delete removes it.
- Click "Add room" → fill the form → new room appears in the list.
- Confirm there is no draggable canvas, no "Isolate room" button, no "Tidy layout" button anywhere on this screen.
- "Continue to Design" is disabled with zero rooms, enabled once one exists.

- [ ] **Step 4: Commit**

```bash
git add src/app/projects/[id]/review/page.tsx
git commit -m "Rebuild Room Confirmation as a plain list, no canvas, with delete-confirm popup"
```

---

### Task 10: Delete `PlanEditor` and trim `plan-geometry.ts`

**Files:**
- Delete: `src/components/project/plan-editor.tsx`
- Modify: `src/lib/plan-geometry.ts` (remove `tidyLayout`; `analyzePlan` stays for now — still used by `pipeline/validate.ts`, retired in Task 12)

**Interfaces:**
- None produced — pure deletion/trim. Confirms Task 9 was the last caller of `PlanEditor`/`tidyLayout`.

- [ ] **Step 1: Confirm no remaining callers**

Run: `grep -rn "PlanEditor\|tidyLayout" src --include=*.tsx --include=*.ts`
Expected: only the definitions themselves (`plan-editor.tsx`, `plan-geometry.ts`) — no callers, since Task 9 already removed `review/page.tsx`'s usage.

- [ ] **Step 2: Delete `PlanEditor`**

```bash
git rm src/components/project/plan-editor.tsx
```

- [ ] **Step 3: Remove `tidyLayout` from `plan-geometry.ts`**

Delete the `tidyLayout` function (and its private helpers `gridlines`/`snap`, if `grep -n "gridlines\|snap(" src/lib/plan-geometry.ts` shows they're only used inside `tidyLayout`) from `src/lib/plan-geometry.ts`, keeping `analyzePlan`, `PlanIssues`, and `overlapArea` — `pipeline/validate.ts` still imports `analyzePlan` until Task 12 retires it.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plan-geometry.ts
git commit -m "Delete PlanEditor and tidyLayout (no spatial canvas in the rebuilt flow)"
```

---

### Task 11: Wire "No, not yet" to Room Confirmation directly

**Files:**
- Modify: `src/app/projects/[id]/floor-plan/page.tsx`

**Interfaces:**
- Consumes: `useVasto` (`setFloorPlan`, `setStatus`) from `src/lib/store.ts`; `emptyPlan()` from `src/lib/pipeline/extract-plan.ts` (Task 3) — reused here so the no-floor-plan path and the low-confidence-extraction fallback (Task 7) produce the identical empty-plan shape.

- [ ] **Step 1: Update the "No" branch**

In `src/app/projects/[id]/floor-plan/page.tsx`, replace the `choice === "no"` block (currently a static "Sketch tool coming soon" message) and its button wiring so choosing "No" sets an empty floor plan and navigates straight to Room Confirmation, matching the "Yes" branch's shape:

```tsx
"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { emptyPlan } from "@/lib/pipeline/extract-plan";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export default function FloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);

  if (!project) return null;

  const goManual = () => {
    setFloorPlan(id, emptyPlan());
    setStatus(id, "parsed");
    router.push(`/projects/${id}/review`);
  };

  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-lg text-center">
        <h2 className="text-2xl font-bold tracking-tight">Do you have a floor plan?</h2>
        <p className="mt-2 text-sm text-muted">
          A real plan gives the most accurate rooms, dimensions and openings.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-4">
          <button
            onClick={() => setChoice("yes")}
            className={cn(
              "hover-lift group flex flex-col items-center gap-3 rounded-2xl border px-6 py-8 transition-colors cursor-pointer",
              choice === "yes" ? "border-accent/60 bg-accent/5" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="grid size-12 place-items-center rounded-xl bg-accent/10 text-accent transition-transform group-hover:scale-110">
              <Icon name="FileUp" className="size-6" />
            </span>
            <span className="font-medium">Yes, I have one</span>
          </button>
          <button
            onClick={() => setChoice("no")}
            className={cn(
              "hover-lift group flex flex-col items-center gap-3 rounded-2xl border px-6 py-8 transition-colors cursor-pointer",
              choice === "no" ? "border-accent/60 bg-accent/5" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="grid size-12 place-items-center rounded-xl bg-surface-2 text-muted transition-transform group-hover:scale-110">
              <Icon name="Pencil" className="size-6" />
            </span>
            <span className="font-medium">No, not yet</span>
          </button>
        </div>

        {choice === "no" && (
          <Button className="mt-6" iconRight="ArrowRight" onClick={goManual}>
            Add rooms manually
          </Button>
        )}

        {choice === "yes" && (
          <Button
            className="mt-6"
            iconRight="ArrowRight"
            onClick={() => router.push(`/projects/${id}/upload`)}
          >
            Continue to upload
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify in the browser**

Run: `npm run dev`, create a new project, choose "No, not yet" → "Add rooms manually" → confirm landing on `/review` with the empty state from Task 9 ("Add your first room to get started.").

- [ ] **Step 3: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/projects/[id]/floor-plan/page.tsx
git commit -m "Wire the no-floor-plan path directly into Room Confirmation"
```

---

### Task 12: Retire the old pipeline and async job infrastructure

**Files:**
- Delete: `src/lib/pipeline/ocr.ts`, `src/lib/pipeline/semantic.ts`, `src/lib/pipeline/merge.ts`, `src/lib/pipeline/pipeline.ts`, `src/lib/pipeline/assign-openings.ts`'s function (keep its types, see Step 2), `src/lib/pipeline/validate.ts`, `src/lib/pipeline/job-store.ts`, `src/lib/inngest/` (entire directory), `src/app/api/inngest/route.ts`
- Modify: `src/lib/pipeline/assign-openings.ts` (keep only the `OpeningSide`/`RoomOpening` type exports Task 3 depends on; delete the deterministic assignment logic), `package.json` (remove `dev:inngest` script and the `inngest` dependency), `.env.example` and `CLAUDE.md`/`README.md` (remove now-false `INNGEST_ENABLED` documentation)

**Interfaces:**
- None produced — this is a deletion pass. Confirms nothing outside the deleted files still imports them.

- [ ] **Step 1: Confirm blast radius before deleting**

Run each of these and confirm the only hits are inside the files about to be deleted (or, for `assign-openings.ts`, only the type imports from Task 3):

```bash
grep -rln "pipeline/ocr\"" src
grep -rln "pipeline/semantic\"" src
grep -rln "pipeline/merge\"" src
grep -rln "pipeline/pipeline\"" src
grep -rln "pipeline/validate\"" src
grep -rln "pipeline/job-store\"" src
grep -rln "lib/inngest" src
grep -rln "assignOpenings" src
```

Expected for the last one: only `src/lib/pipeline/assign-openings.ts` itself and `src/lib/pipeline/pipeline.ts`/`src/lib/inngest/functions.ts` (both being deleted this task) — `extract-plan.ts` (Task 3) imports only the `OpeningSide`/`RoomOpening` *types*, not the `assignOpenings` function.

- [ ] **Step 2: Trim `assign-openings.ts` to types only**

Replace the file's contents, keeping only what Task 3 needs:

```typescript
/**
 * Shared opening types. The deterministic point-to-room-edge assignment
 * algorithm that used to live here is retired — the new extraction pipeline
 * (src/lib/pipeline/extract-plan.ts) gets door/window side + connection
 * directly from Gemini vision instead of computing it from pixel geometry.
 */

export type OpeningSide = "north" | "south" | "east" | "west";

export interface RoomOpening {
  type: "door" | "window";
  side: OpeningSide;
  /** another room's name, "exterior", or null if not confidently determined */
  connectsTo: string | null;
}
```

- [ ] **Step 3: Delete the retired files**

```bash
git rm src/lib/pipeline/ocr.ts src/lib/pipeline/semantic.ts src/lib/pipeline/merge.ts src/lib/pipeline/pipeline.ts src/lib/pipeline/validate.ts src/lib/pipeline/job-store.ts
git rm -r src/lib/inngest
git rm src/app/api/inngest/route.ts
```

- [ ] **Step 4: Clean up `package.json`**

Remove the `"dev:inngest"` script entry. Run `npm uninstall inngest` to drop the now-unused dependency.

- [ ] **Step 5: Update docs**

In `.env.example`, `CLAUDE.md`, and `README.md`, remove the `INNGEST_ENABLED`/`npm run dev:inngest` documentation (search each file for `INNGEST` / `Inngest` / `dev:inngest`) and the "Floor-plan parsing pipeline" stage tables' `OCR`/`Gemini Flash`/`OpenCV`/`Merge Engine`/`Openings` rows in `CLAUDE.md` and `README.md` — replace with a short note pointing at `src/lib/pipeline/extract-plan.ts` and `src/lib/ai/provider.ts`'s `extractFloorPlan` as the new single-call extraction path. Leave `DETECTOR=labeled`/`DETECTION_MODE=gemini` documentation as-is (they describe the still-present, still-dormant OpenCV path per this plan's constraint against touching it) but note it is currently unused by the live app.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in the project.

Run: `npm run lint`
Expected: clean.

Run: `npm run build`
Expected: succeeds (confirms no route still references the deleted Inngest handler or old pipeline modules).

- [ ] **Step 7: Full end-to-end verification**

Run: `npm run dev`. Walk the complete rebuilt flow: create a project → Floor Plan "Yes" → Upload → Analyze → land on Room Confirmation with real rooms → edit a room → delete a room (confirm popup copy) → Add room manually → Continue to Design (confirms the rest of the existing flow, untouched by this plan, still works with rooms produced by the new pipeline). Separately: create a second project → Floor Plan "No, not yet" → confirm landing on an empty Room Confirmation → Add room → Continue to Design.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Retire the old OCR/OpenCV/semantic/merge pipeline and Inngest job path"
```

---

## Self-review notes (for the plan author, not a task)

- **Spec coverage**: Section 1 (extraction) → Tasks 1-5, 12. Section 2 (Upload) → Tasks 6-7. Section 3 (Room Confirmation) → Tasks 9-10. Section 4 (no-floor-plan reuse) → Task 11. Sections 5-13 of the design spec (Design screen onward, Admin console, etc.) are explicitly out of scope for this plan — each becomes its own plan per the spec's "Build order," following the Scope Check guidance that multi-subsystem specs get split rather than one giant plan.
- **OpenCV/scripts**: untouched throughout, per the Global Constraints — confirmed no task deletes or modifies `scripts/*.py` or `opencv.ts`.
- **`x`/`y` cosmetic positions**: Task 3's grid-packer exists specifically so `PlanThumb`/`project-card.tsx` (outside this plan's scope) keep working unchanged — confirmed by checking its only caller before writing the task.
