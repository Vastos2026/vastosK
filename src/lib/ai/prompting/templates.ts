import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * Reads the published prompt_templates row for a given type (+ category, for
 * 'planning' rows — the persona differs per project category). Falls back to
 * the hardcoded defaults below when Supabase isn't configured or no row is
 * published yet, so the pipeline works out of the box (same
 * degrades-gracefully contract as the rest of this codebase) and a fresh
 * install doesn't need the SQL editor before it can generate anything.
 * These defaults match the rows `supabase/schema.sql` seeds on a fresh
 * install — keep them in sync.
 */

export interface SystemTemplateBody {
  rules: string;
}

export interface PlanningTemplateBody {
  persona: string;
}

export interface BuilderTemplateBody {
  intro: string;
  cameraPrefix: string;
  negativePrefix: string;
}

/**
 * Three phrases were removed here (2026-08-14) after a report that generated
 * rooms read as "a very polished catalog image that isn't realistically
 * possible" rather than as homes: "magazine photograph", "real-estate lens"
 * and "tack-sharp focus". Each was asking for that outcome directly — a
 * magazine shoot and real-estate photography are both the staged-showroom
 * genre, and tack-sharp-everywhere is a CG tell, since a real lens falls off.
 *
 * This preamble no longer reaches the image prompt (see withSystemPreamble's
 * doc comment below), but it still runs on the Design Planning call, so its
 * language shapes every compactBrief the planner writes — which is how it
 * reached the image path anyway, one step removed.
 */
const DEFAULT_SYSTEM: SystemTemplateBody = {
  rules:
    "Photorealistic photograph of a real, ordinary home interior, shot on a full-frame camera with " +
    "a wide-angle lens. Natural depth of field and fine surface detail (wood grain, fabric weave, " +
    "stone texture) throughout, not smoothed or plastic-looking. Soft natural daylight spilling in through windows/openings " +
    "as the dominant light source, with realistic falloff and gentle, physically plausible shadows rather " +
    "than flat studio lighting. Realistic materials, reflections and imperfections. Every piece of furniture " +
    "and fixture must be structurally real and buildable, no floating, warped or physically impossible " +
    "geometry. No people, no text or watermarks, no visible logos. Render exactly the furniture and " +
    "fixtures implied by the brief below — do not invent unrelated objects.",
};

const DEFAULT_PLANNING_PERSONA: Record<string, string> = {
  Residential:
    "Think like an experienced interior designer creating a family home: prioritise comfort, warmth and " +
    "everyday liveability alongside the chosen style.",
  Apartment:
    "Think like an interior designer working within an apartment's real space constraints: prioritise " +
    "efficient layouts and multi-purpose furniture while still honouring the chosen style.",
  Commercial:
    "Think like a commercial interior designer working on an office or workspace: prioritise productivity, " +
    "circulation and a professional client-facing impression alongside the chosen style.",
  Custom:
    "Think like a specialist interior designer. The project brief below names the exact business type in its " +
    "project.subcategory field (for example a dental clinic, a restaurant, a retail store, a temple, or any " +
    "other business the client named). Treat that exact named type as your primary design driver, not a " +
    "generic interior, and prioritise the functional, safety and customer-experience needs specific to that " +
    "named business alongside the chosen style.",
};

const DEFAULT_BUILDER: BuilderTemplateBody = {
  intro: "Generate one photorealistic interior photograph of the following room.",
  cameraPrefix: "Camera guidance:",
  negativePrefix: "Do not include:",
};

export async function getSystemTemplate(): Promise<SystemTemplateBody> {
  const row = await fetchPublished("system");
  return (row?.body as SystemTemplateBody) ?? DEFAULT_SYSTEM;
}

/**
 * Prepends the System Rules to a prompt body. Historically every call site
 * that produces a natural-language prompt routed through this rather than
 * fetching getSystemTemplate() and splicing it in by hand — that manual-
 * splice pattern is exactly how the Prompt Builder's image-generation prompt
 * once silently omitted System Rules entirely (it only reached the Design
 * Planning call).
 *
 * The image path (prompt-builder.ts) deliberately no longer calls this,
 * as of the 512-token-budget rewrite: DEFAULT_SYSTEM.rules is ~700 chars,
 * 39% of the entire 1,800-char cap FLUX.2's text encoder allows, and it
 * contains four phrases section 2.4 of that rewrite deletes by name —
 * "tack-sharp focus", "not smoothed or plastic-looking", "structurally real
 * and buildable", and "No people, no text or watermarks, no visible logos"
 * (an exclusion with no negation channel, which supplies the concept
 * instead of banning it). There is no room for this preamble under that
 * budget, so the image prompt IS the section 2.2 template.
 *
 * Design Planning (design-planning.ts) still calls this: it is a text/JSON
 * call with no 512-token encoder in front of it, so none of the above
 * applies there, and it's still the only prompt-producing call site left
 * that must route through here rather than fetching getSystemTemplate() by
 * hand.
 */
export async function withSystemPreamble(body: string): Promise<string> {
  const system = await getSystemTemplate();
  return `${system.rules}\n\n${body}`;
}

export async function getPlanningTemplate(category: string): Promise<PlanningTemplateBody> {
  const row = await fetchPublished("planning", category);
  if (row?.body) return row.body as PlanningTemplateBody;
  return { persona: DEFAULT_PLANNING_PERSONA[category] ?? DEFAULT_PLANNING_PERSONA.Custom };
}

export async function getBuilderTemplate(): Promise<BuilderTemplateBody> {
  const row = await fetchPublished("builder");
  return (row?.body as BuilderTemplateBody) ?? DEFAULT_BUILDER;
}

async function fetchPublished(
  type: "system" | "planning" | "builder",
  category?: string,
): Promise<{ body: unknown } | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  try {
    let query = db
      .from("prompt_templates")
      .select("body")
      .eq("type", type)
      .eq("published", true)
      .order("version", { ascending: false })
      .limit(1);
    query = category ? query.eq("category", category) : query.is("category", null);
    const { data } = await query.maybeSingle();
    return data ?? null;
  } catch (e) {
    console.warn(`[prompting/templates] fetch ${type} failed (using default):`, (e as Error).message);
    return null;
  }
}
