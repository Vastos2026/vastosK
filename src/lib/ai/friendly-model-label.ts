/**
 * Pure label lookup, no env access — split out from model-labels.ts (which is
 * server-only, reads process.env) specifically so client components (the
 * console's model switcher, analytics charts) can render human-readable
 * names without pulling a server-only-guarded module into the client bundle.
 *
 * ModelSlugs mirrors currentModelSlugs()'s return shape (model-labels.ts) —
 * duplicated here, not imported, so client components never reference that
 * module at all (a `import type` re-export was tried first and still tripped
 * Turbopack's "server-only in a Client Component" check on this Next.js
 * version — safer to just not import it, even for types).
 */
export interface ModelSlugs {
  // `meta` is generation-only — Muse has no mask parameter, so it never
  // appears under imageEdit (see settings/provider-types.ts).
  imageGen: { runware: string; gemini: string; meta: string };
  imageEdit: { runware: string; gemini: string };
  video: { runware: string };
}

const KNOWN_LABELS: Record<string, string> = {
  "muse-image-1.0": "Muse Image",
  "bfl:5@1": "FLUX.2 Pro",
  "runware:400@1": "FLUX.2",
  "google:4@2": "Nano Banana Pro",
  "google:4@3": "Nano Banana 2",
  "alibaba:wan@2.7": "Wan 2.7",
};

export function friendlyModelLabel(slug: string): string {
  if (KNOWN_LABELS[slug]) return KNOWN_LABELS[slug];
  if (slug.startsWith("gemini-")) return "Gemini Flash";
  return slug;
}
