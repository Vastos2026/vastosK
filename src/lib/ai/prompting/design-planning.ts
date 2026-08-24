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
    accentColours: { type: "STRING" },
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
          dressing: { type: "STRING" },
        },
        required: ["room", "guidance", "compactGuidance", "dressing"],
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
    "accentColours",
    "materialTokens",
    "roomGuidelines",
  ],
} as const;

/**
 * A/B WORKTREE (worktree-design-spec-ai-comparison): this is the LLM path,
 * restored so it can be compared directly against the sibling worktree's
 * table-driven `buildDesignSpec` (worktree-greybox-opening-placement,
 * design-spec-tables.ts) on the same rooms and the same design selections.
 * Everything downstream of whichever function runs — prompt-builder, both
 * flows, every budget — is identical between the two worktrees; this
 * function is the one thing that differs.
 *
 * `accentColours` was added here (alongside the pre-existing `wallColour`)
 * so this path has the same fields prompt-builder now reads on the table
 * side, rather than the comparison being handicapped by a missing field —
 * see prompt-builder.ts's `medium`/`wallSurfaces` for where both land.
 */

/**
 * One Gemini call per project: turns a Universal Input into a Design
 * Specification (design language, materials, lighting, colour, furniture,
 * camera and negative guidance, plus per-room guidance for every room in the
 * input). The caller is responsible for caching the result on
 * projects.manifest so it's produced once
 * and reused for every room and every "generate more" — this function itself
 * doesn't know about projects or caching, only about the AI call.
 *
 * PALETTE ROLES (added after a reported bug): when the user picks a custom
 * palette, the Design page now states the roles explicitly in the text this
 * function receives — "wall colour X; accent colours Y and Z" — because
 * leaving three unlabelled hexes for the model to sort out let it decide the
 * whole palette read as an accent scheme and answer with a "safe" neutral
 * for the walls, silently overriding the user's explicit choice (reported:
 * a custom palette of three magentas came back with ivory walls). The
 * PALETTE ROLES rule in the prompt below tells the model those stated roles
 * are fixed, and the HEX CODES rule makes sure the literal hex the user
 * picked survives into wallColour/accentColours verbatim rather than a
 * paraphrase of it — an instruction the model can reinterpret is exactly
 * what produced the ivory-walls bug in the first place.
 */
export async function runDesignPlanning(
  input: UniversalInput,
  ctx?: CallContext,
  /**
   * Wall-clock budget for the Gemini call below, so the route's own
   * `maxDuration` — not the provider's retry ladder — decides when this
   * gives up. See gemini-client's DEFAULT_DEADLINE_MS.
   */
  deadlineMs?: number,
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

PALETTE ROLES: if the colour palette above already states a role — it will read "wall colour" \
followed by one colour and "accent colours" followed by the rest — then the user chose those \
roles themselves and they are FIXED. Put exactly that colour in wallColour and exactly the others \
in accentColours. Never swap them, never substitute a "safer" neutral, and never override the \
choice however unusual it looks. The PALETTE SPLIT rule below applies only when no role is stated.

HEX CODES: when a colour is given to you as a hex code, wallColour and accentColours must each \
carry BOTH a short plain-English name for that colour AND the hex code itself, copied exactly as \
given — for example "deep crimson red #8b1a1a". Never the hex alone, and never the name alone. \
Keep the names short: both fields have a hard character limit and the hex codes must fit inside it.

PALETTE SPLIT: the colour palette above lists several colours with no stated role. You must decide \
which ONE of them is the wall colour and put ONLY that one in wallColour below; every other colour \
in the palette goes in accentColours instead, describing where each is used (soft furnishing, \
accents, trim). Never leave wallColour empty and never repeat the same colour in both fields.

REALISM: you are specifying a real, ordinary, buildable home that a photographer would shoot \
exactly as it stands. Never specify a showroom, a display set, a magazine shoot or a staged \
arrangement.

Additionally return, for a strict character budget in a downstream image prompt:
- compactBrief: AT MOST 240 characters. One or two sentences naming the two or three key materials \
and the quality of light. Do NOT name colours here — wallColour and accentColours below carry the \
palette instead, so repeating it here only wastes the budget. No preamble, no room names, no furniture.
- wallColour: AT MOST 40 characters. The ONE colour the walls are painted, per the PALETTE SPLIT \
rule above — for example "warm sand", "soft off-white", "muted sage green". A colour and nothing \
else: no finish, no material, no sentence. When a hex code was supplied for this colour, per the \
HEX CODES rule above, this value must be the name plus that hex code together and still fit inside \
the 40-character limit.
- accentColours: AT MOST 60 characters. Every OTHER colour from the palette, per the PALETTE SPLIT \
rule above, as a short phrase — for example "muted sage green and deep olive brown". Colours only, \
no finish, no sentence. When hex codes were supplied, per the HEX CODES rule above, each colour \
here must be name plus hex — since two hexes must share the 60-character limit, keep each name to \
two or three words at most.
- materialTokens: three short noun phrases, at most three words each, naming the specific dominant \
wood ("walnut", "light oak"), the dominant soft/upholstery material ("cream boucle", "charcoal linen") \
and the dominant stone ("carrara marble", "honed granite") for this project.
- compactGuidance, per room: AT MOST 120 characters. The single most important thing about THAT \
room's materials, colour or light. No furniture positions — a separate reference image already \
fixes those.
- dressing, per room: AT MOST 70 characters. The SMALL, LOOSE objects a finished room of THAT \
specific type actually has, as a bare comma-separated list — for a bedroom "a rug, bedside lamps, \
cushions, folded throws"; for a kitchen "a fruit bowl, chopping board, jars, a tea towel"; for a \
pooja room "brass lamps, a bell, fresh flowers, framed images"; for a bathroom "rolled towels, \
soap, a small plant". Every item must be something a person could pick up and carry. NEVER name \
furniture — no bed, sofa, table, chair, wardrobe, desk or shelving unit — because the furniture \
in this room is fixed by a reference image and an invented piece would land on top of a door or \
a window. No sentence, no adjectives about style, just the objects.`;

  const prompt = await withSystemPreamble(body);
  const spec = await generateStructured<DesignSpecification>(prompt, DESIGN_SPEC_SCHEMA, ctx, deadlineMs);
  // The prompt asks for these limits; a hard clamp is what guarantees them.
  // buildRoomPrompt's 1800-char assert throws and fails the job, so an
  // overlong brief must not be able to reach it.
  //
  // stripWallFinishes is the same argument applied to the WALLS rule above:
  // an instruction is a request, and this one had already been ignored often
  // enough to be reported as a bug. Applied to exactly the four fields that
  // reach an image prompt (compactBrief, wallColour, accentColours,
  // compactGuidance) — the verbose fields are display-only and are allowed to
  // read like a designer wrote them.
  return {
    ...spec,
    compactBrief: clamp(stripWallFinishes(spec.compactBrief), 240),
    wallColour: clamp(stripWallFinishes(spec.wallColour), 40),
    accentColours: clamp(stripWallFinishes(spec.accentColours), 60),
    roomGuidelines: spec.roomGuidelines.map((g) => ({
      ...g,
      compactGuidance: clamp(stripWallFinishes(g.compactGuidance), 120),
      // Same clamp-don't-ask discipline as every other field that reaches an
      // image prompt. `dressing` lands in furnishFullyFor's clause, which
      // sits OUTSIDE the overflow ladder — an overlong value there is paid
      // for by the accent note and the furniture line, silently, so the
      // 70-char limit stated in the prompt is enforced here rather than
      // trusted.
      dressing: clamp(stripWallFinishes(g.dressing), 70),
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
