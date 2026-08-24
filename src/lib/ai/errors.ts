/**
 * Standardized error categories for every AI/storage operation (revamp plan,
 * "CTO review round 2"). Used consistently in provider-layer responses,
 * ai_usage_logs rows, and API error payloads, so the frontend can decide
 * whether to show a "try again" action (AiProviderError/TimeoutError/
 * StorageError) or just a message (ValidationError/InternalError).
 */
export type ErrorCategory =
  | "ValidationError"
  | "AiProviderError"
  | "StorageError"
  | "TimeoutError"
  /**
   * The money ran out — a provider account with no credit left, or a daily
   * API quota spent. Separate from AiProviderError because it is neither
   * transient nor retryable: every retry and every fallback tier draws on the
   * same wallet, so trying harder just fails slower. It is also the one
   * provider failure a USER can act on, which is why it is the only non-
   * ValidationError category whose message is shown verbatim (see
   * QUOTA_MESSAGE below).
   */
  | "QuotaError"
  | "InternalError";

/**
 * The exact words a user sees when a provider account is out of credit or a
 * daily quota is spent. Deliberately says nothing about WHICH provider — the
 * fact that this app runs on Runware or Gemini is not the customer's
 * business, and naming it here would leak that into the browser on a failure
 * path (the same reasoning that keeps the assembled prompt server-side).
 */
export const QUOTA_MESSAGE = "Quota limit hit. Contact Vastos Admin";

/**
 * Does this error text mean "out of credit / over quota" rather than a
 * transient provider hiccup? Matched on text because neither provider gives
 * a stable machine-readable marker for it across every surface: Runware
 * reports it in a task-level `errors[]` message on an HTTP 200, Google in a
 * 429 body's status field. Kept deliberately narrow — "rate" and "too many
 * requests" are NOT here, because a per-minute rate limit clears on its own
 * and must stay retryable.
 */
export function looksLikeQuotaExhaustion(text: string): boolean {
  const t = text.toLowerCase();
  if (/\binsufficient\b/.test(t) && /\b(credit|credits|balance|funds)\b/.test(t)) return true;
  if (/\bresource_exhausted\b/.test(t)) return true;
  if (/\b(out of|no|zero)\s+(credit|credits|balance|quota)\b/.test(t)) return true;
  if (/\bquota\b/.test(t) && /\b(exceed|exceeded|exhausted|depleted)\b/.test(t)) return true;
  if (/\bbilling\b/.test(t) && /\b(required|disabled|not enabled)\b/.test(t)) return true;
  return false;
}

export class ProviderError extends Error {
  category: ErrorCategory;
  /**
   * True for a correctness-invariant failure that a DIFFERENT provider/tier
   * cannot route around — e.g. runware-client.ts's assertGenerationAspect
   * guard: a caller-side generation-dimensions mismatch means the reference
   * image's camera can't be honored, which trying a different image model
   * would silently mask rather than fix. `runChain` (provider.ts) re-throws
   * immediately on this marker instead of falling through to the next tier;
   * every other error (including an ordinary ValidationError) keeps falling
   * through to the next tier exactly as before this flag existed.
   */
  nonRecoverable: boolean;

  constructor(category: ErrorCategory, message: string, opts?: { nonRecoverable?: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.category = category;
    this.nonRecoverable = opts?.nonRecoverable ?? false;
  }
}

/**
 * Retry policy per the revamp plan's CTO review, applied by the provider layer:
 *   - AI provider timeout: retry twice, exponential backoff (transient/cheap).
 *   - Temporary failure (5xx/rate limit): retry twice, backoff capped low —
 *     each retry is a paid call, don't let an outage silently rack up cost.
 *   - Validation failure: never retry — deterministic, retrying just fails again.
 *   - Safety/content rejection: never auto-retry the same prompt.
 * Storage retries (up to 3, no AI cost) live with the storage helpers, not here.
 */
export const RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  "AiProviderError",
  "TimeoutError",
]);
// Note the omission: "QuotaError" is NOT retryable. Every retry and every
// fallback tier bills the same account, so retrying an exhausted balance only
// makes the user wait longer for the same failure.

export const MAX_RETRIES = 2;

export function backoffMs(attempt: number): number {
  return Math.min(attempt * 1500, 6000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Converts a caught error into a safe `{status, body}` pair for an API
 * route to return to the client, always logging the real error server-side
 * first. A `ValidationError`'s message is deterministic and describes what
 * was wrong with the caller's OWN request (e.g. "at most 2 regions per
 * edit") — safe and useful to show verbatim. Every other category
 * (`AiProviderError`/`StorageError`/`TimeoutError`/`InternalError`, or a
 * plain non-`ProviderError` exception) can carry a raw upstream HTTP
 * response body, an absolute server file path, a cloud account id, or other
 * internals the underlying client/library embeds in its own error message
 * (found in review: `generate-walkthrough`, `parse-plan`, `export-pdf`,
 * `order-rooms`, `generate-room-image`, `edit-room-image`, and `design-plan`
 * were all returning `e.message` straight to the browser) — those get a
 * generic, context-labelled message on the client side while the real
 * detail is still logged for debugging. `category` is kept either way since
 * the frontend uses it (not the message text) to decide whether to offer a
 * "try again" action.
 */
export function toErrorResponse(
  e: unknown,
  context: string,
): { status: number; body: { error: string; category?: ErrorCategory } } {
  if (e instanceof ProviderError) {
    console.error(`[${context}]`, e.category, e.message);
    if (e.category === "ValidationError") {
      return { status: 400, body: { error: e.message, category: e.category } };
    }
    // Quota gets its own fixed sentence and a 429, not the generic 502
    // "<context> failed". The old behaviour was actively unhelpful: an
    // exhausted Runware balance surfaced as an ordinary provider failure, so
    // the only way to find out the account was empty was to read the server
    // log. The message is a constant, never the upstream text, so no provider
    // name or account detail crosses into the browser.
    if (e.category === "QuotaError") {
      return { status: 429, body: { error: QUOTA_MESSAGE, category: e.category } };
    }
    return { status: 502, body: { error: `${context} failed`, category: e.category } };
  }
  console.error(`[${context}]`, e);
  return { status: 500, body: { error: `${context} failed` } };
}
