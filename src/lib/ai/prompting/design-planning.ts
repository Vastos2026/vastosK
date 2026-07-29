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
    roomGuidelines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { room: { type: "STRING" }, guidance: { type: "STRING" } },
        required: ["room", "guidance"],
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
${roomNames}.`;

  const prompt = await withSystemPreamble(body);
  return generateStructured<DesignSpecification>(prompt, DESIGN_SPEC_SCHEMA, ctx);
}
