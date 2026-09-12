/**
 * Pure type definitions, no env/DB access — split out from provider-settings.ts
 * (which is server-only) specifically so client components (the console's
 * model switcher) can import these types directly without pulling a
 * server-only-guarded module into the client bundle. Same fix as
 * friendly-model-label.ts/model-labels.ts — see that file's comment for why.
 */
export type ProviderCapability = "image_gen" | "image_edit";

/**
 * `meta` is Muse Image via the Meta Model API, and is valid for `image_gen`
 * ONLY. Muse has no mask parameter on any host, so it cannot serve the
 * numbered-region lasso edit that `image_edit` exists for — see
 * meta-muse-client.ts. `getProviderPrimary` rejects a stored `meta` on the
 * edit capability rather than trusting the column.
 */
export type ProviderChoice = "runware" | "gemini" | "meta";

/** The subset valid for a given capability — the one place that rule is written down. */
export const PROVIDER_CHOICES: Record<ProviderCapability, readonly ProviderChoice[]> = {
  image_gen: ["meta", "runware", "gemini"],
  image_edit: ["runware", "gemini"],
} as const;
