# Runware Image/Video Provider Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Runware.ai (FLUX.2 for images, Wan 2.7 for video) as a toggleable alternative to Gemini for `generateImage`/`editImage`/`generateVideo`, selected via env vars, without removing or degrading the existing Gemini code paths. OCR (`extractFloorPlan`) and Design Planning (`generateStructured`) stay on Gemini unconditionally — not in scope.

**Architecture:** New `src/lib/render/runware-client.ts` implements the three Runware calls (image inference, FLUX Fill masked edit, Wan video inference + async poll) as standalone functions returning the same `{bytes, contentType}` shape the Gemini paths already return. `src/lib/ai/provider.ts`'s three public functions each branch on an env var (`IMAGE_PROVIDER` / `VIDEO_PROVIDER`, default `"runware"`) between the existing Gemini call and the new Runware call — the Gemini code is relocated into a same-named private helper, not deleted or altered in behavior.

**Tech Stack:** Next.js 16 API routes (Node runtime), raw `fetch` (no Runware SDK, matching this codebase's existing raw-fetch pattern for Gemini/Veo), no new dependencies.

## Global Constraints

- Do not delete or functionally change any existing Gemini code path — every current Gemini call must still work byte-for-byte the same when its provider env var is set to `"gemini"`.
- No test runner exists in this repo. Verification is `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus manual `curl`/browser checks against the running dev server (`http://localhost:3000`, already running throughout this session).
- No em dashes in UI copy (repo-wide rule) — not applicable here, no UI copy changes in this plan.
- Never commit unless the user explicitly asks (repo-wide rule, already confirmed this session).

---

### Task 1: Runware REST client

**Files:**
- Create: `src/lib/render/runware-client.ts`

**Interfaces:**
- Consumes: nothing from other tasks (foundational).
- Produces:
  - `runwareConfigured(): boolean`
  - `generateImageWithRunware(prompt: string): Promise<{bytes: Buffer; contentType: string}>`
  - `editImageWithRunware(baseDataUri: string, maskDataUri: string, instruction: string): Promise<{bytes: Buffer; contentType: string}>`
  - `generateVideoWithRunware(imageDataUri: string, prompt: string, opts: {durationSeconds?: number}): Promise<{bytes: Buffer; contentType: string}>`
  - Each throws a plain `Error` with a descriptive message on any failure (unconfigured key, HTTP error, missing output, poll timeout) — `provider.ts` (Task 2) wraps these into `ProviderError` itself, matching how it already wraps `render/gemini-image.ts`'s `null`-return convention (this file uses throw instead of `null` since there's no legacy call-site relying on `null`).

- [ ] **Step 1: Write the module**

```typescript
/**
 * Runware.ai REST client (https://runware.ai/docs) — raw fetch, no SDK,
 * matching this codebase's existing pattern for Gemini/Veo
 * (render/gemini-image.ts, render/veo-client.ts).
 *
 * One HTTP endpoint for every task type: POST an ARRAY of task objects to
 * `https://api.runware.ai/v1`, get back `{ data: [...] }` (or `{ errors: [...] }`).
 * Image inference responds synchronously; video inference is long-running, so
 * video requests set `deliveryMethod: "async"` and are polled via a
 * `getResponse` task keyed by `taskUUID` until `status` is `"success"` or
 * `"error"`.
 *
 * Model choice is env-overridable so a slug can be pinned/swapped without a
 * code change, same convention as `GEMINI_IMAGE_MODEL`/`GEMINI_VIDEO_MODEL`:
 *   RUNWARE_IMAGE_MODEL — default `runware:400@1` (FLUX.2 [dev], text-to-image)
 *   RUNWARE_EDIT_MODEL  — default `runware:102@1` (FLUX Fill, masked inpainting —
 *                          purpose-built for the lasso edit's seed+mask shape,
 *                          unlike FLUX.2 [dev]'s generic reference-image editing)
 *   RUNWARE_VIDEO_MODEL — default `alibaba:wan@2.7` (Wan 2.7, image-to-video)
 */

import { randomUUID } from "node:crypto";

const API_BASE = "https://api.runware.ai/v1";

const IMAGE_MODEL = process.env.RUNWARE_IMAGE_MODEL?.trim() || "runware:400@1";
const EDIT_MODEL = process.env.RUNWARE_EDIT_MODEL?.trim() || "runware:102@1";
const VIDEO_MODEL = process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7";

export function runwareConfigured(): boolean {
  return !!process.env.RUNWARE_API_KEY?.trim();
}

function apiKey(): string {
  const key = process.env.RUNWARE_API_KEY?.trim();
  if (!key) throw new Error("RUNWARE_API_KEY is not configured");
  return key;
}

interface RunwareTaskResult {
  taskType?: string;
  taskUUID?: string;
  status?: "processing" | "success" | "error";
  imageURL?: string;
  videoURL?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

interface RunwareResponse {
  data?: RunwareTaskResult[];
  errors?: { message?: string; taskUUID?: string }[];
}

/** POST one or more task objects, return the `data` array. Throws on transport/API error. */
async function submit(tasks: Record<string, unknown>[]): Promise<RunwareTaskResult[]> {
  let res: Response;
  try {
    res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify(tasks),
    });
  } catch (e) {
    throw new Error(`Runware request failed: ${(e as Error).message}`);
  }
  const payload = (await res.json().catch(() => null)) as RunwareResponse | null;
  if (!res.ok || !payload) {
    throw new Error(`Runware ${res.status}: ${payload ? JSON.stringify(payload) : await res.text().catch(() => "")}`);
  }
  if (payload.errors?.length) {
    throw new Error(`Runware error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data ?? [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `getResponse` for `taskUUID` until the task reports success/error, or
 * `maxWaitMs` elapses. Exponential-ish backoff starting at 2s, capped at 8s.
 */
async function pollUntilDone(taskUUID: string, maxWaitMs: number): Promise<RunwareTaskResult> {
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < maxWaitMs) {
    await sleep(delay);
    delay = Math.min(delay + 1000, 8000);
    const [result] = await submit([{ taskType: "getResponse", taskUUID }]);
    if (!result) continue;
    if (result.status === "success") return result;
    if (result.status === "error") {
      throw new Error(`Runware task ${taskUUID} failed: ${result.errorMessage ?? "unknown error"}`);
    }
  }
  throw new Error(`Runware task ${taskUUID} timed out after ${maxWaitMs}ms`);
}

/** Download a Runware output URL into bytes (their URLs are unauthenticated, time-limited). */
async function download(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Runware output download → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

/** Text-to-image via FLUX.2. Synchronous — Runware returns the imageURL directly. */
export async function generateImageWithRunware(
  prompt: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: IMAGE_MODEL,
      positivePrompt: prompt,
      width: 1024,
      height: 1024,
      outputType: "URL",
      outputFormat: "PNG",
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware imageInference returned no imageURL");
  const out = await download(result.imageURL);
  return { bytes: out.bytes, contentType: out.contentType.startsWith("image/") ? out.contentType : "image/png" };
}

/**
 * Masked region edit via FLUX Fill. `maskDataUri` follows this codebase's
 * existing convention (see api/edit-room-image/route.ts): white = edit this
 * region, black = leave untouched — passed straight through as `maskImage`,
 * no crop/composite step needed (unlike the Gemini path), since FLUX Fill
 * does masked inpainting natively.
 */
export async function editImageWithRunware(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const [result] = await submit([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: EDIT_MODEL,
      positivePrompt: instruction,
      seedImage: baseDataUri,
      maskImage: maskDataUri,
      outputType: "URL",
      outputFormat: "PNG",
    },
  ]);
  if (!result?.imageURL) throw new Error("Runware FLUX Fill returned no imageURL");
  const out = await download(result.imageURL);
  return { bytes: out.bytes, contentType: out.contentType.startsWith("image/") ? out.contentType : "image/png" };
}

/** Image-to-video via Wan 2.7. Async — submits, then polls `getResponse` until done. */
export async function generateVideoWithRunware(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; maxWaitMs?: number } = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  const [submitted] = await submit([
    {
      taskType: "videoInference",
      taskUUID: randomUUID(),
      model: VIDEO_MODEL,
      positivePrompt: prompt,
      frameImages: [imageDataUri],
      ...(opts.durationSeconds ? { duration: opts.durationSeconds } : {}),
      outputType: "URL",
      outputFormat: "MP4",
      deliveryMethod: "async",
    },
  ]);
  if (!submitted?.taskUUID) throw new Error("Runware videoInference returned no taskUUID");

  const done =
    submitted.status === "success" && submitted.videoURL
      ? submitted
      : await pollUntilDone(submitted.taskUUID, opts.maxWaitMs ?? 4 * 60_000);
  if (!done.videoURL) throw new Error("Runware video generation finished without a videoURL");
  const out = await download(done.videoURL);
  return { bytes: out.bytes, contentType: out.contentType.startsWith("video/") ? out.contentType : "video/mp4" };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from the new file (the module isn't imported anywhere yet, so this only checks it's internally well-typed).

---

### Task 2: Wire the provider switch into `provider.ts`

**Files:**
- Modify: `src/lib/ai/provider.ts`

**Interfaces:**
- Consumes: `runwareConfigured`, `generateImageWithRunware`, `editImageWithRunware`, `generateVideoWithRunware` from Task 1 (`@/lib/render/runware-client`).
- Produces: `generateImage`, `editImage`, `generateVideo` keep their exact existing exported signatures — no caller (any API route) needs to change.

- [ ] **Step 1: Add the import and two provider-selector helpers**

Add near the top of `src/lib/ai/provider.ts`, after the existing imports (after line 27, before `export interface CallContext`):

```typescript
import {
  runwareConfigured,
  generateImageWithRunware,
  editImageWithRunware,
  generateVideoWithRunware,
} from "@/lib/render/runware-client";

/**
 * Provider toggle — flip back to Gemini any time by setting the env var to
 * "gemini" (or unsetting RUNWARE_API_KEY, which forces the Gemini path
 * regardless of the env var, so a half-configured Runware setup never
 * silently breaks generation). Documented in CLAUDE.md's "Env vars" section
 * and .env.example. Defaults to Runware — this is a deliberate temporary
 * testing setup, not a permanent architecture decision (see context.md).
 */
function imageProvider(): "gemini" | "runware" {
  const wanted = (process.env.IMAGE_PROVIDER?.trim().toLowerCase() || "runware") as "gemini" | "runware";
  return wanted === "runware" && runwareConfigured() ? "runware" : "gemini";
}

function videoProvider(): "gemini" | "runware" {
  const wanted = (process.env.VIDEO_PROVIDER?.trim().toLowerCase() || "runware") as "gemini" | "runware";
  return wanted === "runware" && runwareConfigured() ? "runware" : "gemini";
}
```

- [ ] **Step 2: Split `generateImage` into a Gemini-branch helper + provider switch**

Replace the existing `generateImage` function (current lines 279-311) with:

```typescript
/** The original Gemini text-to-image call, unchanged — kept as its own function so the Runware branch can sit next to it without touching this logic. */
async function generateImageWithGemini(prompt: string): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("AiProviderError", "GEMINI_API_KEY is not configured");

  const url = `${API_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
  } catch (e) {
    throw new ProviderError("AiProviderError", `request failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError("AiProviderError", `${IMAGE_MODEL} ${res.status}: ${body}`);
  }
  const payload = (await res.json().catch(() => null)) as GeminiImageResponse | null;
  const b64 = payload?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new ProviderError("AiProviderError", `${IMAGE_MODEL} returned no image part`);
  return { bytes: Buffer.from(b64, "base64"), contentType: "image/png" };
}

/**
 * Plain text-to-image generation for the new flow's room images — the Prompt
 * Builder hands this a fully-assembled natural-language prompt; this layer
 * never sees or constructs prompt structure itself.
 *
 * Routes to Gemini or Runware per `IMAGE_PROVIDER` (see `imageProvider()`
 * above) — temporary testing setup, toggle back to Gemini any time.
 */
export async function generateImage(
  prompt: string,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const provider = imageProvider();
  const model = provider === "runware" ? process.env.RUNWARE_IMAGE_MODEL?.trim() || "runware:400@1" : IMAGE_MODEL;

  return instrumented("image", model, ctx, async () => {
    try {
      return provider === "runware" ? await generateImageWithRunware(prompt) : await generateImageWithGemini(prompt);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError("AiProviderError", (e as Error).message);
    }
  });
}
```

- [ ] **Step 3: Split `editImage` into a Gemini-branch call + provider switch**

Replace the existing `editImage` function (current lines 318-331) with:

```typescript
/**
 * Lasso-region edit — delegates to the existing crop/composite implementation
 * (render/gemini-image.ts) for Gemini, or FLUX Fill's native masked inpainting
 * for Runware. Routes per `IMAGE_PROVIDER` — same toggle as `generateImage`.
 */
export async function editImage(
  baseDataUri: string,
  maskDataUri: string,
  instruction: string,
  style: DesignStyle,
  ctx?: CallContext,
): Promise<GeneratedImage> {
  if (!instruction.trim()) throw new ProviderError("ValidationError", "instruction is empty");
  const provider = imageProvider();
  const model = provider === "runware" ? process.env.RUNWARE_EDIT_MODEL?.trim() || "runware:102@1" : IMAGE_MODEL;

  return instrumented("edit", model, ctx, async () => {
    if (provider === "runware") {
      try {
        return await editImageWithRunware(baseDataUri, maskDataUri, instruction);
      } catch (e) {
        throw new ProviderError("AiProviderError", (e as Error).message);
      }
    }
    const out = await editImageWithGemini(baseDataUri, maskDataUri, instruction, style);
    if (!out) throw new ProviderError("AiProviderError", "edit produced no image");
    return out;
  });
}
```

- [ ] **Step 4: Split `generateVideo` into a Gemini-branch call + provider switch**

Replace the existing `generateVideo` function (current lines 339-351) with:

```typescript
/** Image-to-video (walkthrough clips). Routes per `VIDEO_PROVIDER` — Gemini/Veo (delegates to render/veo-client.ts) or Runware/Wan 2.7 (render/runware-client.ts). */
export async function generateVideo(
  imageDataUri: string,
  prompt: string,
  opts: { durationSeconds?: number; aspectRatio?: string } = {},
  ctx?: CallContext,
): Promise<GeneratedVideo> {
  if (!prompt.trim()) throw new ProviderError("ValidationError", "prompt is empty");
  const provider = videoProvider();
  const model = provider === "runware" ? process.env.RUNWARE_VIDEO_MODEL?.trim() || "alibaba:wan@2.7" : "veo";

  return instrumented("video", model, ctx, async () => {
    if (provider === "runware") {
      try {
        return await generateVideoWithRunware(imageDataUri, prompt, { durationSeconds: opts.durationSeconds });
      } catch (e) {
        throw new ProviderError("AiProviderError", (e as Error).message);
      }
    }
    const out = await generateVideoFromImage(imageDataUri, prompt, opts);
    if (!out) throw new ProviderError("AiProviderError", "video generation failed");
    return { bytes: out.bytes, contentType: out.contentType };
  });
}
```

- [ ] **Step 5: Type-check, lint**

Run: `npx tsc --noEmit`
Expected: no errors — in particular, confirm `IMAGE_MODEL` and `API_BASE` (the Gemini constants near the top of the file) are still referenced only inside `generateImageWithGemini`/`editImage`'s Gemini branch, not accidentally orphaned.

Run: `npm run lint`
Expected: no new warnings/errors.

- [ ] **Step 6: Manual smoke test — Gemini path unaffected (no Runware key set yet)**

With the dev server running (`http://localhost:3000`) and `RUNWARE_API_KEY` unset in `.env.local`, confirm `imageProvider()`/`videoProvider()` fall back to `"gemini"` automatically (per Step 1's `runwareConfigured()` guard) — i.e. behavior is identical to before this change with zero env var edits required. This can be confirmed by reading the code path (Step 1's helper returns `"gemini"` whenever `runwareConfigured()` is false) rather than an end-to-end generation call, since that would spend a real Gemini credit. Skip an actual generation call here — Task 3 covers the env var documentation the user needs to actually opt into Runware.

---

### Task 3: Document the new env vars

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md` (worktree root — the "Env vars" section)
- Modify: `context.md` (repo root, one level up from the worktree — see `docs/superpowers/specs` convention: this file is the cross-session handoff doc, already tracking the Runware evaluation from workstream 6)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks — this is the last task.

- [ ] **Step 1: Add the Runware block to `.env.example`**

Insert after the existing `# --- Gemini ...` block (after line 9, before the `# --- Floor-plan geometry detection` block):

```
# --- Runware.ai (FLUX.2 image gen, FLUX Fill masked edit, Wan 2.7 video) ---
# Temporary testing setup (2026-07-27) — see context.md workstream 6/7 for
# why. IMAGE_PROVIDER/VIDEO_PROVIDER default to "runware" when RUNWARE_API_KEY
# is set; set either to "gemini" (or just leave RUNWARE_API_KEY blank) to go
# straight back to the Gemini code paths above, which are untouched.
RUNWARE_API_KEY=
IMAGE_PROVIDER=
VIDEO_PROVIDER=
RUNWARE_IMAGE_MODEL=
RUNWARE_EDIT_MODEL=
RUNWARE_VIDEO_MODEL=
```

- [ ] **Step 2: Add the Runware entries to `CLAUDE.md`'s "Env vars" section**

In the worktree's `CLAUDE.md`, in the "### Env vars" section, insert a new bullet directly after the existing `GEMINI_API_KEY, GEMINI_MODEL, ...` bullet:

```
- `RUNWARE_API_KEY`, `IMAGE_PROVIDER`, `VIDEO_PROVIDER`, `RUNWARE_IMAGE_MODEL`, `RUNWARE_EDIT_MODEL`, `RUNWARE_VIDEO_MODEL` — **temporary testing provider (2026-07-27)**. `provider.ts`'s `generateImage`/`editImage`/`generateVideo` route to Runware (FLUX.2 for images, FLUX Fill for the lasso edit, Wan 2.7 for video) whenever `RUNWARE_API_KEY` is set AND the matching `IMAGE_PROVIDER`/`VIDEO_PROVIDER` isn't explicitly set to `"gemini"`. **The Gemini code paths are untouched and still the default the moment `RUNWARE_API_KEY` is unset** — to go back to Gemini permanently, either blank out `RUNWARE_API_KEY` or set `IMAGE_PROVIDER=gemini`/`VIDEO_PROVIDER=gemini`. `extractFloorPlan` (OCR) and `generateStructured` (Design Planning) are NOT affected by this toggle — always Gemini.
```

- [ ] **Step 3: Update `context.md`'s workstream 6 entry with the resolution**

In the repo-root `context.md`, workstream 6's last bullet currently reads (approximately) "Awaiting the user's decision on whether to scope this as real work." Append a new paragraph directly after that workstream 6 section (before "## What's genuinely still open"):

```markdown
### 7. Runware provider swap — temporary testing config (2026-07-27, COMPLETE)

The user decided: for testing, switch `generateImage`/`editImage`/`generateVideo` to Runware.ai (FLUX.2 `runware:400@1` for image gen, FLUX Fill `runware:102@1` for the lasso edit, Wan 2.7 `alibaba:wan@2.7` for video), while `extractFloorPlan` (OCR) stays Gemini-only, explicitly. This reverses the "Google-only" locked decision from `docs/VASTOS_REVAMP_PLAN.md` **on a temporary, easily-reversible basis** — the user was explicit they might revert to Gemini, switch to yet another provider, or keep Runware for production, and wants that decision left open.

**Implementation, non-destructive by design:** new `src/lib/render/runware-client.ts` (raw fetch, no SDK, matching this codebase's existing Gemini/Veo pattern) implements the three Runware calls. `src/lib/ai/provider.ts`'s three public functions now branch on `IMAGE_PROVIDER`/`VIDEO_PROVIDER` env vars (default `"runware"` whenever `RUNWARE_API_KEY` is set, otherwise **automatically falls back to Gemini** — a half-configured Runware setup can never silently break generation). The existing Gemini code (`generateImageWithGemini` inline in `provider.ts`, `render/gemini-image.ts`, `render/veo-client.ts`) was **not deleted or altered** — every current Gemini call path still works exactly as before the moment `RUNWARE_API_KEY` is unset or a provider env var is set to `"gemini"`. See `CLAUDE.md`'s "Env vars" section and `.env.example` for the exact toggle.

**Not yet tested end-to-end with a real Runware key** — the user will add `RUNWARE_API_KEY` themselves. Two assumptions made from Runware's docs (WebFetch/WebSearch against `runware.ai/docs`, 2026-07-27) that should be verified on the first real call: (1) FLUX Fill's `maskImage` uses the same "white = edit, black = leave untouched" convention this codebase's lasso mask already produces (not verified against a live response, only inferred from the docs' generic inpainting description); (2) Wan 2.7's `duration` field accepts the same `4` (seconds) value Veo's walkthrough clips request — if the API rejects it, `generateVideo`'s Runware branch surfaces that as a `ProviderError` (category `AiProviderError`, visible in the API response and `ai_usage_logs`), not a silent failure.
```

- [ ] **Step 4: Final verification**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `npm run build`
Expected: all three clean, matching this repo's standard verification suite (per `CLAUDE.md`/`context.md`) — this specifically catches any client/server-boundary issue the new import chain (`provider.ts` → `runware-client.ts`) might introduce, the same class of bug this repo has hit before.

No commit — per the repo-wide rule (see Global Constraints), only commit when the user explicitly asks.
