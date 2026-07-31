/**
 * Pure type definitions, no env/DB access — split out from provider-settings.ts
 * (which is server-only) specifically so client components (the console's
 * model switcher) can import these types directly without pulling a
 * server-only-guarded module into the client bundle. Same fix as
 * friendly-model-label.ts/model-labels.ts — see that file's comment for why.
 */
export type ProviderCapability = "image_gen" | "image_edit";
export type ProviderChoice = "runware" | "gemini";
