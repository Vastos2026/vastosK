import "server-only";
import { generateStructured, type CallContext } from "@/lib/ai/provider";
import { getPlanningTemplate, withSystemPreamble } from "./templates";
import type { DesignSpecification, UniversalInput } from "./types";

const DESIGN_SPEC_SCHEMA = {
  type: "OBJECT",
  properties: {
    designLanguage: { type: "STRING" },
    materialPalette: { type: "STRING" },
    lightingStrategy: { type: "STRING" },
    colourStrategy: { type: "STRING" },
    furnitureLanguage: { type: "STRING" },
    cameraGuidelines: { type: "STRING" },
    negativeConstraints: { type: "STRING" },
    compactBrief: { type: "STRING" },
    materialTokens: {
      type: "OBJECT",
      properties: { wood: { type: "STRING" }, soft: { type: "STRING" }, stone: { type: "STRING" } },
      required: ["wood", "soft", "stone"],
    },
    roomGuidelines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          room: { type: "STRING" },
          guidance: { type: "STRING" },
          compactGuidance: { type: "STRING" },
        },
        required: ["room", "guidance", "compactGuidance"],
      },
    },
  },
  required: [
    "designLanguage",
    "materialPalette",
    "lightingStrategy",
    "colourStrategy",
    "furnitureLanguage",
    "cameraGuidelines",
    "negativeConstraints",
    "compactBrief",
    "materialTokens",
    "roomGuidelines",
  ],
} as const;

/**
 * One Gemini call per project: turns a Universal Input into a Design
 * Specification (design language, materials, lighting, colour, furniture,
 * camera and negative guidance, plus per-room guidance for every room in the
 * input). The caller is responsible for caching the result on
 * projects.manifest (see src/lib/projects/state.ts) so it's produced once
 * and reused for every room and every "generate more" — this function itself
 * doesn't know about projects or caching, only about the AI call.
 */
export async function runDesignPlanning(
  input: UniversalInput,
  ctx?: CallContext,
): Promise<DesignSpecification> {
  const planning = await getPlanningTemplate(input.project.category);

  const roomNames = input.layout.rooms.map((r) => r.name).join(", ");
  const body = `${planning.persona}

You are planning the overall design for an interior-design project. Given the project brief below (JSON), \
produce a single, cohesive design specification that will guide photorealistic renders of EVERY room \
listed, so the rooms all read as the same home/space designed by one designer — not unrelated rooms.

Project brief:
${JSON.stringify(input, null, 2)}

Return a design specification covering: the overall design language; the material palette (surfaces, \
finishes); the lighting strategy; the colour strategy (how the chosen colour palette is applied); the \
furniture language (style/era/materials of furniture across the space); camera guidelines for how each \
room should be framed and shot; negative constraints (what must never appear); and one guidance entry \
per room in the brief (covering that room's furniture, layout and focal point), for EVERY room named: \
${roomNames}.

Additionally return, for a strict character budget in a downstream image prompt:
- compactBrief: AT MOST 240 characters. One or two sentences naming the palette, the two or three \
key materials, and the quality of light. No preamble, no room names, no furniture.
- materialTokens: three short noun phrases, at most three words each, naming the specific dominant \
wood ("walnut", "light oak"), the dominant soft/upholstery material ("cream boucle", "charcoal linen") \
and the dominant stone ("carrara marble", "honed granite") for this project.
- compactGuidance, per room: AT MOST 120 characters. The single most important thing about THAT \
room's materials, colour or light. No furniture positions — a separate reference image already \
fixes those.`;

  const prompt = await withSystemPreamble(body);
  const spec = await generateStructured<DesignSpecification>(prompt, DESIGN_SPEC_SCHEMA, ctx);
  // The prompt asks for these limits; a hard clamp is what guarantees them.
  // buildRoomPrompt's 1800-char assert throws and fails the job, so an
  // overlong brief must not be able to reach it.
  return {
    ...spec,
    compactBrief: clamp(spec.compactBrief, 240),
    roomGuidelines: spec.roomGuidelines.map((g) => ({ ...g, compactGuidance: clamp(g.compactGuidance, 120) })),
  };
}

/** Trims to `max` chars at the last sentence or word boundary, so a clamp never cuts mid-word. */
export function clamp(s: string | undefined, max: number): string {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  const stop = sentence > max * 0.6 ? sentence + 1 : cut.lastIndexOf(" ");
  return (stop > max * 0.6 ? cut.slice(0, stop) : cut).trim().replace(/[,;]$/, "");
}
