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
    wallColour: { type: "STRING" },
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
    "wallColour",
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

Two rules override everything above, and apply to EVERY field you return.

WALLS: name wall COLOURS only, never a wall finish or technique. Never write limewash, lime-wash, \
lime plaster, venetian plaster, microcement, tadelakt, stucco, chalky, patina or textured plaster \
about any surface you describe as a wall. The walls in this project are ordinary smooth painted \
plaster, exactly as in a normal home, and that is already stated elsewhere — your job is only the \
colour they are painted.

REALISM: you are specifying a real, ordinary, buildable home that a photographer would shoot \
exactly as it stands. Never specify a showroom, a display set, a magazine shoot or a staged \
arrangement.

Additionally return, for a strict character budget in a downstream image prompt:
- compactBrief: AT MOST 240 characters. One or two sentences naming the palette, the two or three \
key materials, and the quality of light. No preamble, no room names, no furniture.
- wallColour: AT MOST 40 characters. The colour the walls are painted, taken from the colour \
palette above — for example "warm sand", "soft off-white", "muted sage green". A colour and \
nothing else: no finish, no material, no sentence.
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
  //
  // stripWallFinishes is the same argument applied to the WALLS rule above:
  // an instruction is a request, and this one had already been ignored often
  // enough to be reported as a bug. Applied to exactly the three fields that
  // reach an image prompt (compactBrief, wallColour, compactGuidance) — the
  // verbose fields are display-only and are allowed to read like a designer
  // wrote them.
  return {
    ...spec,
    compactBrief: clamp(stripWallFinishes(spec.compactBrief), 240),
    wallColour: clamp(stripWallFinishes(spec.wallColour), 40),
    roomGuidelines: spec.roomGuidelines.map((g) => ({
      ...g,
      compactGuidance: clamp(stripWallFinishes(g.compactGuidance), 120),
    })),
  };
}

/**
 * Wall finishes and techniques, removed rather than requested away.
 *
 * A named wall TREATMENT is what produces the oily/waxy wall look users kept
 * reporting: the palette legitimately supplies a colour ("warm sand", from
 * data.ts's Sage & Sand entry) and the planner would append a finish it was
 * never asked for, arriving at "warm sand lime-wash walls". The model then
 * rendered exactly that. See DesignSpecification.wallColour for the full
 * history.
 *
 * Deliberately a fixed list of finish nouns, not a general "texture word"
 * heuristic: the brief SHOULD still be free to say "honed limestone" or
 * "cane" about a floor or a worktop. Only these specific wall treatments are
 * removed. The trailing cleanup collapses the gap the removal leaves and
 * repairs the punctuation around it, so "warm sand lime-wash walls" becomes
 * "warm sand walls" rather than "warm sand  walls" or a dangling comma.
 */
const WALL_FINISHES =
  /\b(lime[-\s]?wash(ed)?|lime[-\s]plaster|venetian[-\s]plaster|micro[-\s]?cement|tadelakt|stucco|chalky|chalk[-\s]finish|patina(ted)?|textured[-\s]plaster)\b/gi;

export function stripWallFinishes(s: string | undefined): string {
  return (s ?? "")
    .replace(WALL_FINISHES, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;])\s*([,.;])/g, "$2")
    .trim();
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
