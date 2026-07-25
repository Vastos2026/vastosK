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
  | "InternalError";

export class ProviderError extends Error {
  category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "ProviderError";
    this.category = category;
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

export const MAX_RETRIES = 2;

export function backoffMs(attempt: number): number {
  return Math.min(attempt * 1500, 6000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
