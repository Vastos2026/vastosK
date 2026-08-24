/**
 * Minimal Gemini REST client — no SDK dependency.
 *
 * Both the OCR stage (vision) and the Gemini Flash stage (reasoning) call
 * `generateJson()`; they differ only in the parts they send. Using raw `fetch`
 * keeps the dependency surface small and immune to SDK version churn.
 *
 * Returns `null` whenever Gemini is unconfigured, unreachable, or replies with
 * non-JSON — callers treat `null` as "use the fallback", so the pipeline keeps
 * running offline / without an API key.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// gemini-2.0-flash was RETIRED (its generateContent endpoint now 404s even
// though ListModels still lists it). gemini-2.5-flash followed (2026-07-09,
// "no longer available to new users") ahead of its official Oct 16 2026
// shutdown date, so neither can be the default any more. gemini-flash-latest
// is an always-current alias — it now resolves to the Gemini 3.x generation,
// see callModel's thinking-config handling below for what that changes.
const DEFAULT_MODEL = "gemini-flash-latest";
// Live fallbacks with SEPARATE capacity pools: explicit-versioned 3.x models
// in case the `-latest` alias has its own outage, then legacy 2.5-flash last
// for any project/key that still has access ahead of its shutdown date.
const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];

/**
 * Wall-clock budget for ONE generateJson call — the whole ladder, across
 * every model and every retry.
 *
 * Without it the ladder is unbounded: the primary model gets 5 attempts with
 * 1.5+3+4.5+6 = 15s of backoff, then three fallback models get 2 attempts
 * each, so a single sustained transport fault ("fetch failed") costs 11
 * requests and ~19.5s of pure sleeping BEFORE counting the attempts, per
 * call. `runPlanExtraction` makes two such calls back to back, so one bad
 * network minute ran the route well past its `maxDuration` and the platform
 * killed it mid-flight — that is the "Extraction returned 504" the user
 * sees, and the reason the server log keeps printing retries for a request
 * nobody is waiting on any more. `toErrorResponse` cannot produce a 504; it
 * only ever emits 400/500/502, so a 504 is always the gateway, never us.
 *
 * The budget lives HERE rather than being threaded in from each route
 * because there are six call sites across four API routes and nothing stops
 * a seventh being added without one. Bounded by construction beats bounded
 * by convention. Routes may still pass a tighter `deadlineMs`.
 */
export const DEFAULT_DEADLINE_MS = 45_000;

/**
 * Share of the remaining budget one attempt may take while retries are still
 * on the table. A dead socket does not fail fast — undici sits on a stalled
 * connection far longer than any request deadline — so without a per-attempt
 * abort a single hung attempt eats the whole budget and the retry ladder
 * never runs at all.
 *
 * Expressed as a FRACTION rather than a fixed number of seconds on purpose.
 * A fixed ceiling has to be guessed, and guessing low silently kills calls
 * that are legitimately slow (a dense plan really is a 20-40s vision read),
 * which would be a worse bug than the one this file is fixing. A fraction
 * cannot be wrong that way: it always adapts to whatever budget the route
 * actually gave, and the last attempt gets the remainder outright.
 */
export const ATTEMPT_SHARE = 0.6;

/** Don't START an attempt (or a backoff sleep) that can't plausibly finish. */
export const MIN_ATTEMPT_MS = 3_000;

const msLeft = (deadline: number) => deadline - Date.now();

/**
 * How long one attempt may take. A share of what's LEFT while retries remain,
 * and the whole remainder on the final attempt, so no attempt can outlive the
 * ladder it belongs to while an early hang still leaves something for a retry.
 * Pure so /api/dev-check can assert it directly — it is the one piece of
 * arithmetic in the ladder that can silently go wrong.
 */
export function attemptCapMs(budget: number, attempt: number, maxAttempts: number): number {
  if (attempt >= maxAttempts) return budget;
  return Math.max(MIN_ATTEMPT_MS, Math.floor(budget * ATTEMPT_SHARE));
}

/**
 * How long to wait before the next attempt, given the time ACTUALLY left once
 * this one has failed (not the budget it started with — a capped-out attempt
 * has already spent most of it, and planning the sleep against the stale
 * figure is how a backoff outlives its own deadline).
 *
 * Returns 0 to mean "don't retry": either this was the last attempt, or
 * waiting would leave too little time for the attempt it precedes. Sleeping
 * into a deadline already lost is precisely how the old unbounded ladder
 * burned a minute on a request nobody was waiting for any more.
 */
export function retryBackoffMs(remaining: number, attempt: number, maxAttempts: number): number {
  if (attempt >= maxAttempts) return 0;
  const room = remaining - MIN_ATTEMPT_MS;
  if (room <= 0) return 0;
  return Math.min(attempt * 1500, room);
}

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

export interface GenerateOptions {
  /** lower = more deterministic; structured stages want this near 0 */
  temperature?: number;
  /** override the model for this call (else GEMINI_MODEL, else default) */
  model?: string;
  /**
   * Model-agnostic "keep thinking minimal" knob for structured extraction/
   * transcription calls that don't benefit from the slow thinking pass. Set
   * to 0 to request the fastest/cheapest reasoning the resolved model
   * allows; omit for the model's default. callModel translates this into
   * whichever wire format the resolved model generation actually accepts
   * (Gemini 2.5's token-count `thinkingBudget`, or Gemini 3.x's semantic
   * `thinkingLevel` — 3.x Flash/Flash-Lite cannot disable thinking outright,
   * so 0 maps to its lowest level instead of "off").
   */
  thinkingBudget?: number;
  /**
   * Cap on the response length. Dense plans (50+ rooms, each with a box +
   * adjacency list) produce long JSON that the model's default cap can truncate —
   * a truncated array fails JSON.parse and silently drops the whole read. Raise
   * this for the big structured reads. Omitted = model default.
   */
  maxOutputTokens?: number;
  /**
   * Constrained-decoding schema (Gemini's OpenAPI subset). Without it, JSON
   * mode can drift into a degenerate repetition loop on vision reads — observed
   * as ~64k chars of garbage burning straight to MAX_TOKENS, which even the
   * salvage parser can't always recover. The schema forces the decoder to
   * follow the declared structure, preventing the loop (and prose/fence
   * wrapping) at the source. Pass it on every structured vision read.
   */
  responseSchema?: object;
  signal?: AbortSignal;
  /**
   * Wall-clock budget for this whole call (every model, every retry).
   * Defaults to DEFAULT_DEADLINE_MS. Set it from a route to whatever is
   * safely under that route's `maxDuration`, leaving room for the work
   * either side of the call — see /api/parse-plan.
   */
  deadlineMs?: number;
}

/**
 * Send `parts` to Gemini and parse the JSON it returns, typed by the caller.
 * Resolves to the parsed value, or `null` to signal "fall back".
 */
export async function generateJson<T>(
  parts: GeminiPart[],
  opts: GenerateOptions = {},
): Promise<T | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;

  // Try the chosen model first, then fall back to alternates with SEPARATE
  // capacity / quota pools. So when one model is "overloaded" (503) or rate-
  // limited (429) for a sustained spell — even after its own retries — the parse
  // still goes through on another model instead of collapsing to the null
  // (position-less) fallback. Dedup keeps a single pass when they coincide.
  const primary = opts.model || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);

  // One budget for the WHOLE ladder, fixed here so that walking to a fallback
  // model can never extend it. See DEFAULT_DEADLINE_MS for why this exists.
  const deadline = Date.now() + Math.max(MIN_ATTEMPT_MS, opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    // Never start a model we have no time to hear back from. Returning null
    // here routes callers onto their own fallback (for extraction: the manual
    // room-entry path) instead of letting the request overrun its
    // maxDuration and come back to the browser as a gateway 504.
    if (msLeft(deadline) < MIN_ATTEMPT_MS) {
      console.warn(`[gemini] budget exhausted before ${model}; giving up with ${models.length - mi} model(s) untried`);
      return null;
    }
    // The user's chosen model gets the most retries; fallbacks fewer (fail over
    // quickly rather than stack long backoffs three times).
    const r = await callModel<T>(model, parts, opts, key, mi === 0 ? 5 : 2, deadline);
    if (r.status === "ok") return r.value;
    if (r.status === "error") return null; // bad key / 400 / bad JSON — same on every model
    if (r.status === "expired") {
      console.warn(`[gemini] budget exhausted on ${model}; giving up rather than overrunning the request`);
      return null;
    }
    // "overloaded" (429/503/network) OR "unavailable" (404 retired model):
    // try the next model instead of aborting the whole read.
    if (mi < models.length - 1) {
      console.warn(`[gemini] ${model} ${r.status} — falling back to ${models[mi + 1]}`);
    }
  }
  return null;
}

type ModelResult<T> =
  | { status: "ok"; value: T }
  | { status: "overloaded" }
  | { status: "unavailable" }
  /** Ran out of wall-clock budget — distinct from "overloaded" because no
   *  other model can help either; the time is simply gone. */
  | { status: "expired" }
  | { status: "error" };

/** One model attempt with its own retry loop. Distinguishes a retryable overload
 *  (caller should try another model) from a hard error (give up). */
async function callModel<T>(
  model: string,
  parts: GeminiPart[],
  opts: GenerateOptions,
  key: string,
  maxAttempts: number,
  deadline: number,
): Promise<ModelResult<T>> {
  const url = `${API_BASE}/${model}:generateContent`;

  // Only the Gemini 2.5 generation accepts `thinkingBudget` (a token count).
  // Gemini 3.x — including what `gemini-flash-latest` resolves to today —
  // replaced it with `thinkingLevel` (a semantic tier) and 400s outright
  // ("Request contains an invalid argument") if thinkingBudget is sent at
  // all. gemini-2.5-pro is the one 2.5 model that still rejects budget:0
  // specifically (it requires some thinking) with the same 400.
  const isGemini25 = /^gemini-2\.5-/.test(model);
  const isPro = model.includes("pro");
  let thinkingConfig: { thinkingBudget: number } | { thinkingLevel: string } | undefined;
  if (opts.thinkingBudget !== undefined) {
    if (isGemini25) {
      if (!(isPro && opts.thinkingBudget === 0)) {
        thinkingConfig = { thinkingBudget: opts.thinkingBudget };
      }
    } else {
      // Gemini 3.x Flash/Flash-Lite can't fully disable thinking, and "minimal"
      // is NOT a universally accepted tier across the 3.x family — live-verified
      // 400 ("Thinking level MINIMAL is not supported for this model") against
      // whatever gemini-flash-latest currently resolves to, and independently
      // confirmed against gemini-3.1-flash-lite and other 3.x variants, which
      // only accept "low"/"medium"/"high". "low" is the tier that's actually
      // supported everywhere in the 3.x family, so it's the closest analog to
      // budget:0's intent that won't itself 400.
      thinkingConfig = { thinkingLevel: opts.thinkingBudget === 0 ? "low" : "high" };
    }
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      responseMimeType: "application/json",
      ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  });

  let res: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const budget = msLeft(deadline);
    if (budget < MIN_ATTEMPT_MS) return { status: "expired" };
    // Two independent reasons to abort: the caller's own signal, and our own
    // per-attempt cap. The cap is a share of what's LEFT, so the last attempt
    // gets the remainder and none can outlive the ladder it belongs to —
    // while an earlier one still leaves something for a retry.
    const attemptTimeout = AbortSignal.timeout(attemptCapMs(budget, attempt, maxAttempts));
    const signal = opts.signal ? AbortSignal.any([opts.signal, attemptTimeout]) : attemptTimeout;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal,
        body,
      });
    } catch (e) {
      // Distinguish "the caller gave up" from "we hit our own cap" from a
      // plain transport error: only the last two are ours to retry, and a
      // caller abort must not be retried at all.
      if (opts.signal?.aborted) return { status: "error" };
      const timedOut = attemptTimeout.aborted;
      console.warn(
        `[gemini] ${model} request ${timedOut ? "timed out" : "failed"} ` +
          `(attempt ${attempt}/${maxAttempts}, ${Math.round(msLeft(deadline) / 1000)}s budget left):`,
        (e as Error).message,
      );
      const backoff = retryBackoffMs(msLeft(deadline), attempt, maxAttempts);
      if (backoff > 0) {
        await sleep(backoff);
        continue;
      }
      // Transport failure, not a model verdict. Reported as "overloaded" so
      // the caller still walks its fallback ladder (a blip may clear on the
      // next request); the budget above is what bounds that, not this.
      return msLeft(deadline) < MIN_ATTEMPT_MS ? { status: "expired" } : { status: "overloaded" };
    }
    if (res.ok) break;

    const errText = await res.text().catch(() => "");
    // A DAILY quota cap won't clear within the request — retrying the same
    // model just burns minutes (the 2.3-min parse). Fail this model over
    // immediately so the next model / the CV fallback takes it.
    if (res.status === 429 && isDailyQuota(errText)) {
      console.warn(`[gemini] ${model} → daily quota exhausted; failing over without retry`);
      return { status: "overloaded" };
    }
    if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
      // Server-suggested delay, but never longer than the budget left for the
      // attempt it precedes — Gemini's RetryInfo routinely asks for more time
      // than a 60s route has, and honouring that verbatim guaranteed the
      // overrun this deadline exists to prevent.
      const room = msLeft(deadline) - MIN_ATTEMPT_MS;
      const delayMs = Math.min(retryDelayMs(errText) ?? attempt * 3000, 20_000, room);
      if (delayMs <= 0) {
        console.warn(`[gemini] ${model} → ${res.status}; no budget left to retry`);
        return { status: "expired" };
      }
      console.warn(
        `[gemini] ${model} → ${res.status}; retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(delayMs);
      continue;
    }
    console.warn(`[gemini] ${model} → ${res.status}: ${errText}`);
    // 404 = this model was retired (e.g. gemini-2.0-flash); 429/503 = capacity.
    // Both mean "this model can't serve it" → let the caller try the next one.
    // A 400 (bad key / malformed request) fails identically on every model → abort.
    if (res.status === 404) return { status: "unavailable" };
    return res.status === 429 || res.status === 503 ? { status: "overloaded" } : { status: "error" };
  }
  if (!res || !res.ok) return { status: "overloaded" };

  let payload: GeminiResponse;
  try {
    // The per-attempt signal above is still attached to this response's body
    // stream, so a reply whose headers arrive fast but whose body stalls is
    // bounded too — otherwise the one place the cap doesn't reach is the
    // place a truncated 65k-token JSON read is most likely to hang.
    payload = (await res.json()) as GeminiResponse;
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
      console.warn(`[gemini] ${model} response body aborted before it finished`);
      return msLeft(deadline) < MIN_ATTEMPT_MS ? { status: "expired" } : { status: "overloaded" };
    }
    return { status: "error" };
  }

  const text = payload.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  const finish = payload.candidates?.[0]?.finishReason;
  if (!text) {
    // A MAX_TOKENS finish with NO text = the whole budget went to the thinking
    // pass; it's retryable on another model, not a hard error.
    if (finish === "MAX_TOKENS") {
      console.warn(`[gemini] ${model} returned no content (finishReason MAX_TOKENS)`);
      return { status: "overloaded" };
    }
    return { status: "error" };
  }

  const parsed = parseJsonLoose<T>(text);
  if (parsed !== undefined) {
    if (finish && finish !== "STOP") {
      // Salvaged a truncated/again-capped reply — usable, but note it so a
      // short room list on a dense plan is explainable.
      console.warn(`[gemini] ${model} response recovered despite finishReason ${finish}`);
    }
    return { status: "ok", value: parsed };
  }
  // Log the payload's head + tail so the failure MODE is diagnosable from the
  // server log (repetition loop vs truncation vs prose) without a re-run.
  console.warn(
    `[gemini] ${model} response was not valid JSON` +
      (finish ? ` (finishReason ${finish})` : "") +
      ` — ${text.length} chars` +
      `\n  head: ${JSON.stringify(text.slice(0, 160))}` +
      `\n  tail: ${JSON.stringify(text.slice(-160))}`,
  );
  // An unparseable MAX_TOKENS reply is a degenerate generation loop (the model
  // repeating itself until the cap) — another model usually answers cleanly,
  // so fail over instead of giving up on the whole read.
  return finish === "MAX_TOKENS" ? { status: "overloaded" } : { status: "error" };
}

/** Some models wrap JSON in ```json fences despite responseMimeType — strip them. */
function stripCodeFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return m ? m[1] : s;
}

/**
 * Parse Gemini JSON tolerantly. Handles the three ways the models violate the
 * `application/json` contract in practice:
 *   1. code fences / leading prose  → slice to the first `{`/`[`
 *   2. trailing prose after the JSON → balanced-scan to the matching close
 *   3. TRUNCATION at maxOutputTokens → close the still-open strings/brackets
 * This turns a truncated 50-room read (previously discarded whole) into the
 * 48 rooms that DID come through, and rescues fence/prose wrapping outright.
 * Returns `undefined` only when no JSON value can be recovered at all.
 */
export function parseJsonLoose<T>(raw: string): T | undefined {
  const cleaned = stripCodeFence(raw).trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to salvage */
  }

  const start = firstJsonStart(cleaned);
  if (start < 0) return undefined;

  // Walk the text tracking string/escape state and the bracket stack, so we
  // know both where a complete value would end and, if it never does, exactly
  // which brackets/strings are still open at the truncation point.
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) {
        end = i + 1;
        break;
      }
    }
  }

  // Complete value found amid surrounding prose.
  if (end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end)) as T;
    } catch {
      /* try repair below */
    }
  }

  // Truncated: repair by closing whatever is open, backtracking to the last
  // COMPLETED element whenever a repair still doesn't parse. Each attempt
  // rescans its own prefix, so the closers always match that prefix's actual
  // open brackets (closing with the stack from the original truncation point
  // produced mismatched JSON whenever the cut removed nested levels).
  let body = cleaned.slice(start);
  for (let attempt = 0; attempt < 12; attempt++) {
    const repaired = closeOpenJson(body);
    if (repaired !== undefined) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        /* backtrack */
      }
    }
    const cut = Math.max(body.lastIndexOf("},"), body.lastIndexOf("],"), body.lastIndexOf('",'));
    if (cut <= 0) break;
    body = body.slice(0, cut + 1);
  }
  return undefined;
}

/** Close a JSON prefix's dangling string/brackets (rescans the prefix). */
function closeOpenJson(text: string): string | undefined {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      if (!stack.length) return undefined; // over-closed — unrecoverable here
      stack.pop();
    }
  }
  let body = text;
  if (inStr) body += '"';
  body = body.replace(/,\s*$/, "").replace(/:\s*$/, ": null");
  for (let i = stack.length - 1; i >= 0; i--) body += stack[i] === "{" ? "}" : "]";
  return body;
}

/** Index of the first `{` or `[` that begins the JSON value, or -1. */
function firstJsonStart(s: string): number {
  const o = s.indexOf("{");
  const a = s.indexOf("[");
  if (o < 0) return a;
  if (a < 0) return o;
  return Math.min(o, a);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Distinguish a PER-DAY quota cap (won't clear this request → fail over now)
 * from a per-minute rate limit (worth a short retry). Gemini free-tier daily
 * limits surface as a QuotaFailure whose id/metric mentions "PerDay".
 */
function isDailyQuota(body: string): boolean {
  return /PerDay|per day|daily limit|GenerateRequestsPerDay/i.test(body);
}

/** Pull the server's suggested retry delay (seconds) from an error body → ms. */
function retryDelayMs(body: string): number | null {
  const m =
    body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ||
    body.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    /** "STOP" = complete; "MAX_TOKENS" = truncated at the output cap; etc. */
    finishReason?: string;
  }[];
}
