import "server-only";
import { generateStructuredFromImage, type CallContext } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/errors";
import { clamp, stripWallFinishes } from "./design-planning";
import { COLOUR_PALETTE_MAX_LEN, isLuxuryLevel, type DesignSelection } from "./build-universal-input";
import { LABEL_BUDGET } from "./prompt-builder";
import type { DesignReferenceAttributes } from "./types";

/**
 * "Upload design reference" (Design page) — the user hands us a photograph of
 * an interior they want their project to look like, instead of picking Style
 * / Luxury level / Colour palette from the three preset pickers.
 *
 * One Gemini Flash vision call reduces that photo to six free-text design
 * attributes shaped like those three picker values, and those attributes then
 * replace the picker values feeding the EXISTING `runDesignPlanning` call,
 * which still returns the same `DesignSpecification`. That is the whole
 * architecture: the reference never reaches an image model, never reaches
 * `buildRoomPrompt` directly, and adds no branch to either prompt flow. Every
 * character budget and the section-priority ladder in prompt-builder.ts are
 * untouched, because from their point of view this is just another
 * `UniversalInput.design`.
 *
 * Worth being explicit about where the reference's influence actually lands.
 * In the normal (greybox present) case `style` never reaches the image prompt
 * at all — prompt-builder only interpolates it into the NO-greybox contract —
 * and `colour_palette` never reaches it in either case. Both flow into
 * `runDesignPlanning`, which distils them into the `compactBrief` /
 * `wallColour` / `compactGuidance` fields that DO reach the model. So the
 * reference influences the render exactly the way a picked palette already
 * did, through the planner, one step removed.
 *
 * SAFETY. This text is written by a model looking at a user-supplied image,
 * and it is merged into a prompt that also carries the room's opening census
 * and geometry lock — the two things this app most needs the image model to
 * obey. Four things keep it from becoming an instruction channel:
 *
 *   1. A CLOSED response schema (below): six short named fields, no `notes`,
 *      no catch-all. A field the model can write anything into is a
 *      prompt-injection channel straight into the image prompt, so there
 *      isn't one. See DesignReferenceAttributes' own doc comment.
 *   2. A prompt that explicitly forbids describing doors, windows, openings,
 *      walls, dimensions, layout, camera or furniture POSITIONS. It describes
 *      LOOK only.
 *   3. Every field clamped, `style` against prompt-builder's own
 *      `LABEL_BUDGET.style` rather than a copied number.
 *   4. Every field run through `stripWallFinishes`.
 *
 * On (4): a reference photo of a limewashed wall would otherwise put
 * "limewash" into `materials`, from there into `colour_palette`, from there
 * into the planner's `compactBrief`, and from there into the image prompt —
 * reintroducing the exact oily/waxy wall bug `stripWallFinishes` and
 * `DesignSpecification.wallColour` were just added to kill. Applied to all six
 * fields, not just the colour/material ones: a photo puts a finish noun
 * wherever the model happens to notice it (a limewashed room reads as a
 * "style" cue just as readily), and all six are concatenated into the same
 * two strings below anyway. `runDesignPlanning` strips its OWN output too —
 * these are two independent passes on two different texts, not a duplicate.
 */

/**
 * The response schema. Fixed set of short named fields, ALL required, no
 * open-ended field — see this file's header and
 * `DesignReferenceAttributes`. `luxuryLevel` is an ENUM so Gemini's
 * constrained decoding cannot emit a fourth value, the same hallucination
 * guard `buildExtractionSchema` (provider.ts) already uses for room types;
 * `LuxuryLevel` is a closed union downstream, so an out-of-list value would
 * otherwise be a `buildUniversalInput` throw rather than a bad render.
 */
const DESIGN_REFERENCE_SCHEMA = {
  type: "OBJECT",
  properties: {
    style: { type: "STRING" },
    luxuryLevel: { type: "STRING", enum: ["Standard", "Premium", "Ultra Luxury"] },
    colourPalette: { type: "STRING" },
    materials: { type: "STRING" },
    lighting: { type: "STRING" },
    furniture: { type: "STRING" },
  },
  required: ["style", "luxuryLevel", "colourPalette", "materials", "lighting", "furniture"],
} as const;

/**
 * Per-field budgets. `style` is pinned to prompt-builder's own bound because
 * that is the one field that can reach an image prompt verbatim (the
 * no-greybox contract), where anything longer is cut mid-word by a `slice`
 * that has no idea what a word is.
 *
 * The other four are sized so the composed colour-palette string below lands
 * under `COLOUR_PALETTE_MAX_LEN` with room to spare: 160 + 110 + 80 + 100 =
 * 450, plus 38 characters of labels and separators = 488 of the 500 allowed.
 * That cap is a hard THROW in buildUniversalInput, not a clamp, so overshoot
 * is a failed design plan rather than a slightly long string — hence the
 * belt-and-suspenders final clamp in `referenceDesignSelection` too.
 */
const REFERENCE_BUDGET = {
  style: LABEL_BUDGET.style,
  colourPalette: 160,
  materials: 110,
  lighting: 80,
  furniture: 100,
} as const;

const ANALYSIS_PROMPT = `You are looking at a photograph of a finished interior. Your job is to describe ONLY how it LOOKS, closely enough that an interior designer could reproduce that look in a completely different building.

Fill in exactly these six fields:
- "style": the design style, as a short phrase a designer would use, e.g. "Retro pastel cafe, rounded forms, playful soft-industrial". AT MOST ${REFERENCE_BUDGET.style} characters.
- "luxuryLevel": exactly one of Standard, Premium, Ultra Luxury.
- "colourPalette": the three or four dominant colours, each NAMED and given its closest hex code, e.g. "Bubblegum pink #F5A9C4, cream #FBF3E8, brushed brass #B08D57". Hex codes are required on every colour — a colour name on its own loses the exact tone.
- "materials": the dominant surface materials and finishes, e.g. "pink lacquered millwork, cream terrazzo, brass trim, cane seating".
- "lighting": the quality and character of the light, and the character of the light fittings, e.g. "warm globe pendants, soft even fill".
- "furniture": the shape language, era and character of the furniture, e.g. "rounded cafe tables, cane bistro chairs, curved banquette".

This describes a LOOK that will be applied to a DIFFERENT room, whose architecture is already fixed and must not be disturbed. So never describe, mention or refer to: doors, windows, openings, walls, wall positions, ceiling height, room size or dimensions, layout, floor plan, where any object sits or faces, the camera, the viewpoint, the framing or the angle.

Every field is a plain descriptive noun phrase about appearance. Never write an instruction, a request, a rule or a direction of any kind.

If the image is not an interior at all, still fill every field with your best reading of its colours, materials and mood. Never leave a field empty.`;

/**
 * Whitespace collapse plus quote removal, before the finish-strip and the
 * clamp.
 *
 * Not cosmetic. A newline in `style` would insert a paragraph break into the
 * FLUX prose prompt, whose sections are joined by "\\n\\n" and whose section
 * ORDER is a truncation-safety mechanism (prompt-builder.ts's header) — a
 * model-written value must not be able to forge a section boundary. The
 * double quotes go because the no-greybox contract interpolates this value
 * INSIDE quotes (`A premium "..." Dental Clinic.`), so a quote in the value
 * closes that phrase early and turns the remainder into loose prose.
 */
function sanitise(value: string | undefined, max: number): string {
  const flattened = (value ?? "").replace(/["“”]/g, "").replace(/\s+/g, " ");
  return clamp(stripWallFinishes(flattened), max);
}

/**
 * The six raw model fields, sanitised and bounded. Exported so the analysis
 * call and the /api/design-plan request boundary run the IDENTICAL pass: the
 * attributes are cached client-side between those two calls (see
 * Project.designReference), so what comes back into design-plan is
 * client-supplied data and has to be re-sanitised there rather than trusted,
 * exactly as build-universal-input.ts re-checks caps the frontend already
 * enforces.
 */
export function sanitiseReferenceAttributes(raw: Partial<DesignReferenceAttributes>): DesignReferenceAttributes {
  return {
    style: sanitise(raw.style, REFERENCE_BUDGET.style),
    // The schema's enum makes a bad value near-impossible from the model, but
    // this function also runs on a request body. Defaulted rather than
    // thrown: it is the one field with three legal values and an obvious
    // middle one, so a malformed level shouldn't cost the user their whole
    // design plan the way an empty style legitimately does below.
    luxuryLevel: isLuxuryLevel(raw.luxuryLevel) ? raw.luxuryLevel : "Premium",
    colourPalette: sanitise(raw.colourPalette, REFERENCE_BUDGET.colourPalette),
    materials: sanitise(raw.materials, REFERENCE_BUDGET.materials),
    lighting: sanitise(raw.lighting, REFERENCE_BUDGET.lighting),
    furniture: sanitise(raw.furniture, REFERENCE_BUDGET.furniture),
  };
}

/**
 * The reference's attributes as a `DesignSelection` — i.e. as the exact shape
 * the three pickers produce, so `buildUniversalInput` and everything past it
 * cannot tell the two apart.
 *
 * `materials`/`lighting`/`furniture` are folded into the colour-palette text
 * rather than dropped or smuggled through a new field. That field is the
 * right home for them: `colour_palette` is read by `runDesignPlanning` alone
 * (it JSON.stringify's the whole UniversalInput into its prompt) and by
 * nothing in prompt-builder.ts, so this is extra context for the PLANNER,
 * which is the layer whose job is turning it into a material palette and a
 * lighting strategy. Nothing here bypasses that planning call.
 */
export function referenceDesignSelection(raw: Partial<DesignReferenceAttributes>): DesignSelection {
  const attrs = sanitiseReferenceAttributes(raw);
  const colourPalette = clamp(
    [
      attrs.colourPalette,
      attrs.materials && `Materials: ${attrs.materials}`,
      attrs.lighting && `Lighting: ${attrs.lighting}`,
      attrs.furniture && `Furniture: ${attrs.furniture}`,
    ]
      .filter(Boolean)
      .join(". "),
    COLOUR_PALETTE_MAX_LEN,
  );
  // buildUniversalInput throws on an empty style or palette, and would do so
  // several steps later with a message about the Design step rather than the
  // reference. Fail here, where the cause is nameable: a photo that produced
  // nothing usable is a re-upload, not a bug in the design selections.
  if (!attrs.style || !colourPalette) {
    throw new ProviderError(
      "ValidationError",
      "That design reference produced no usable style or colour palette. Try a clearer interior photo.",
    );
  }
  return { style: attrs.style, luxuryLevel: attrs.luxuryLevel, colourPalette };
}

/**
 * One Gemini Flash vision call per UPLOADED reference — not per generation,
 * and not per room. The caller caches the result (see
 * Project.designReference) so re-confirming Design, or generating more images
 * for a room, never pays for this again.
 */
export async function analyseDesignReference(
  image: Buffer,
  ctx?: CallContext,
): Promise<DesignReferenceAttributes> {
  // Deliberately NOT wrapped in withSystemPreamble. That preamble is the
  // image-generation rule set (photorealism, lens, lighting, "no watermarks"),
  // which says nothing useful to a vision READ and would only dilute it — and
  // it is an admin-editable prompt_templates row, i.e. one more free-text
  // channel into the one call in this app whose entire point is being locked
  // down to six fixed fields.
  const raw = await generateStructuredFromImage<Partial<DesignReferenceAttributes>>(
    ANALYSIS_PROMPT,
    DESIGN_REFERENCE_SCHEMA,
    image,
    ctx,
  );
  return sanitiseReferenceAttributes(raw);
}
