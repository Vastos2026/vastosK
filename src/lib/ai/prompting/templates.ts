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

const DEFAULT_SYSTEM: SystemTemplateBody = {
  rules:
    "Photorealistic interior-design magazine photograph. Realistic materials, lighting, shadows and " +
    "reflections. No people, no text or watermarks, no visible logos. Render exactly the furniture and " +
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
    "Think like a specialist interior designer for this exact named business type (e.g. a clinic, restaurant, " +
    "retail store, temple, or any other category the user named): prioritise the functional, safety and " +
    "customer-experience needs specific to that business alongside the chosen style.",
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
