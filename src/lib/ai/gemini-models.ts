import "server-only";

/**
 * Which Gemini model each text/vision call runs on, and what it falls back to.
 *
 * Sibling of model-labels.ts, which does the same job for the image/video
 * models. Text models used to have no equivalent: a single `GEMINI_MODEL` env
 * var (defaulting to `gemini-flash-latest`) drove all three calls at once,
 * which was wrong in two separate ways.
 *
 * **The alias.** `gemini-flash-latest` is a pointer Google moves without
 * telling anyone — repointed to `gemini-3.5-flash` in May 2026, with no
 * official word on whether the August 2026 `gemini-3.7-flash` release moved
 * it again. An alias bills at whatever it currently resolves to, so both the
 * price and the behaviour of a call can change under a deploy that changed
 * nothing. Worse, when tested on this project's own key it simply returns
 * 429: no quota. It was the default primary for all three calls, which means
 * every call was already spending a round-trip to be told no before falling
 * through to a model that works. Every entry below is a pinned version.
 *
 * **The three calls are not alike.** Extraction and design planning are the
 * kind of work a cheap model does well. Opening geometry asks for bounding
 * boxes, and spatial coordinate precision is the first thing to degrade on a
 * lite model — and that output feeds the greybox, which conditions every
 * generated image, so a regression there quietly damages renders instead of
 * throwing an error anyone would notice. Geometry therefore keeps a stronger
 * model than the other two.
 */

export type GeminiPurpose = "extraction" | "geometry" | "planning";

/**
 * Published per-1M-token rates, from ai.google.dev/gemini-api/docs/pricing
 * (page dated 2026-08-13). ONLY models whose price is actually on that page
 * appear here: a model whose cost is unknown has no business in a ladder that
 * exists to cap cost. Every rate below was read off that page directly, not
 * inferred from a similarly-named model.
 *
 * `out` is what matters for ranking: this app's calls are small-input,
 * large-output (structured JSON, and thinking tokens bill at the output
 * rate), so output price dominates every real bill.
 */
const RATES: Record<string, { in: number; out: number }> = {
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  // Introductory pricing through 2026-12-31, rising to 1.50/7.50 on
  // 2027-01-01. Still under gemini-3.5-flash even after that step-up, so the
  // cost cap below survives the date change — but recheck when it lands.
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
};

/**
 * Models deliberately absent from the table above, each verified live against
 * this project's own key on 2026-08-24. Every one of them would have been a
 * wasted tier — a round-trip spent to learn nothing:
 *
 *   gemini-flash-latest    429, no quota on this account. It was the PRIMARY
 *                          for all three calls, so every call already burned
 *                          a tier before landing on gemini-3.5-flash anyway.
 *   gemini-3.7-flash       429, no quota. On the pricing page, unusable here.
 *   gemini-2.5-flash       404, "no longer available to new users" — and it
 *                          was in the old fallback list. A dead tier.
 *   gemini-2.5-flash-lite  404, same retirement.
 *
 * Availability is per-account and moves, so re-test with a real key before
 * adding anything here: being listed with a price does NOT mean your key can
 * call it. The two 404s are the case in point.
 */

/**
 * Primary + fallbacks per call, cheapest-adequate first.
 *
 * The ladder is COST-CAPPED: no fallback may cost more per output token than
 * the primary it backs up. Without that rule, making a primary cheap has the
 * perverse effect of making every failure more expensive than the success it
 * replaces — a bad provider minute would quietly upgrade the bill. Enforced at
 * runtime by `fallbacksFor` and asserted in /api/dev-check.
 *
 * Geometry's fallbacks include the lite models even though its primary is the
 * strong one. That is deliberate: a fallback only ever runs after the primary
 * has already failed, geometry is best-effort anyway (its absence just routes
 * rooms to the manual "Place" flow), and an approximate answer beats none.
 */
const PLAN: Record<GeminiPurpose, { primary: string; fallbacks: string[] }> = {
  extraction: {
    primary: "gemini-3.5-flash-lite",
    fallbacks: ["gemini-3.1-flash-lite"],
  },
  planning: {
    primary: "gemini-3.5-flash-lite",
    fallbacks: ["gemini-3.1-flash-lite"],
  },
  // Geometry stays on gemini-3.5-flash, which is ALSO what it effectively
  // runs on today: the old primary (gemini-flash-latest) 429s on this
  // account, so every call already fell through to this model. Pinning it
  // here changes nothing about what executes — it just stops paying for the
  // wasted first tier.
  geometry: {
    primary: "gemini-3.5-flash",
    fallbacks: ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  },
};

/** Per-purpose env override, then the legacy global one, then the pinned default. */
const ENV_VAR: Record<GeminiPurpose, string> = {
  extraction: "GEMINI_EXTRACTION_MODEL",
  geometry: "GEMINI_GEOMETRY_MODEL",
  planning: "GEMINI_PLANNING_MODEL",
};

/**
 * The model this call should run on.
 *
 * `GEMINI_MODEL` still works and still overrides everything, because it is
 * documented in .env.example and may be set in a deployed environment — but
 * it now flattens all three calls onto one model again, so a per-purpose
 * variable is the better knob.
 */
export function geminiModelFor(purpose: GeminiPurpose): string {
  return (
    process.env[ENV_VAR[purpose]]?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    PLAN[purpose].primary
  );
}

/**
 * The fallback ladder for this call, filtered so nothing in it costs more per
 * output token than the primary actually in use.
 *
 * The filter runs against the RESOLVED primary, not the declared one, so an
 * env override cannot silently reintroduce an expensive fallback. A primary
 * that isn't in RATES (an override to some model this table doesn't know)
 * can't be ranked, so the declared ladder passes through untouched — capping
 * against an unknown number would be guesswork, and dropping every fallback
 * would be worse than the problem.
 */
export function geminiFallbacksFor(purpose: GeminiPurpose): string[] {
  const primary = geminiModelFor(purpose);
  const declared = PLAN[purpose].fallbacks.filter((m) => m !== primary);
  const cap = RATES[primary]?.out;
  if (cap === undefined) return declared;
  return declared.filter((m) => {
    const rate = RATES[m]?.out;
    return rate !== undefined && rate <= cap;
  });
}

/** Exposed for /api/dev-check's cost-cap and no-alias assertions. */
export const GEMINI_PLAN = PLAN;
export const GEMINI_RATES = RATES;
