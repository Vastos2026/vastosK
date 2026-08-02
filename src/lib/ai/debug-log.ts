import "server-only";

/**
 * Opt-in console logging of every prompt this app sends to an AI provider,
 * plus what reference image(s) went with it and which model/chain it's
 * headed to — added 2026-08-02 at direct user request, to make the pipeline
 * observable while testing a fresh project end-to-end (floor-plan read →
 * first generation → furniture-triggered regeneration → edits). Off by
 * default (set DEBUG_PROMPTS=1 before `npm run dev`) so normal runs don't
 * spam the server console — this is a testing aid, not a permanent feature.
 */
const ENABLED = process.env.DEBUG_PROMPTS?.trim() === "1";

export function debugLogPrompt(stage: string, info: {
  prompt: string;
  chain?: string;
  referenceImages?: string[] | null;
  /** Viewable /api/render?key=... URL(s) for the reference image(s), when known — open one directly in a browser tab to see exactly what the model saw. */
  referenceImageUrls?: string[] | null;
}): void {
  if (!ENABLED) return;
  const refCount = info.referenceImages?.length ?? 0;
  const urls = info.referenceImageUrls?.length
    ? `\n${info.referenceImageUrls.map((u) => `    http://localhost:3000${u}`).join("\n")}`
    : "";
  const lines = [
    "",
    `\x1b[36m▶ PROMPT — ${stage}\x1b[0m`,
    info.chain ? `  chain: ${info.chain}` : undefined,
    `  reference images: ${refCount === 0 ? "none" : `${refCount}${urls}`}`,
    "  ---",
    info.prompt
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
    "  ---",
    "",
  ].filter((l): l is string => l !== undefined);
  console.log(lines.join("\n"));
}
