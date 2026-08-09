import "server-only";
import { buildFurnitureMaterials } from "@/lib/greybox/furniture-layout";
import { fnv1a } from "@/lib/greybox/greybox-hash";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "./types";
import type { GreyboxLedger, PlacedFurniture } from "@/lib/types";

/**
 * The Prompt Builder — deterministic, no AI call. The only place
 * natural-language prompt text is produced anywhere in the app.
 *
 * Section 1 is the constraint everything here follows from: FLUX.2's text
 * encoder truncates at 512 tokens (~1,800 chars) and Runware silently
 * discards the overflow — no error, no warning. The previous version of this
 * file ran ~3,500 chars with the geometry clause starting near char 2,044,
 * which means that clause NEVER REACHED THE MODEL. Every accuracy problem
 * previously attributed to prompt tuning was diagnosed against a prompt whose
 * most important paragraph had been thrown away before inference.
 *
 * Section order is a safety mechanism, not style: truncation eats the tail,
 * so geometry goes first and expendable detail goes last.
 */

/** Section 1, R1. Hard ceiling. Throw and fail the job — never send over. */
const MAX_PROMPT_CHARS = 1800;
/** Section 4.4 per-section budgets. */
const BUDGET = { brief: 240, furniture: 200, accent: 100 } as const;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Word-forms are single semantic tokens and are better represented in text-encoder space than digits. */
function word(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Section 2.2's structural contract. Fixed boilerplate — never trimmed,
 * never reordered. Both sentences about panels are true only because
 * build-scene.ts builds those exact fixtures: a recessed brown panel inside a
 * darker reveal frame, and an unlit near-white panel that is the brightest
 * thing in frame by construction.
 */
function structuralContract(hasFurniture: boolean): string {
  const furnitureClause = hasFurniture
    ? " Darker grey volumes are furniture: keep their position, footprint and approximate size."
    : "";
  return (
    "Image 1 is an untextured grey massing render of this exact room, from the exact camera the " +
    "output must use. Preserve without deviation: camera position, angle and field of view; room " +
    "proportions and all wall positions; the position, width and height of every opening. A framed " +
    "recessed panel is a closed door. A bright panel is a window. Every other surface is solid " +
    `wall.${furnitureClause} Change only surfaces, materials, lighting and furnishing.`
  );
}

/**
 * Section 4.2. Counts come from the Pass B mask, never from
 * placedOpenings.length — an opening clipped at the frame edge, behind the
 * camera, or occluded by furniture is not visible in the output, and claiming
 * it tells the model to invent one.
 */
function openingLedger(ledger: GreyboxLedger, furnitureCount: number): string {
  const parts: string[] = [];
  const { doors, windows } = ledger;
  if (windows > 0 && doors > 0) {
    parts.push(`The room has ${word(windows)} ${plural(windows, "window")} and ${word(doors)} ${plural(doors, "door")}.`);
  } else if (windows > 0) {
    parts.push(`The room has ${word(windows)} ${plural(windows, "window")}.`);
  } else if (doors > 0) {
    parts.push(`The room has ${word(doors)} ${plural(doors, "door")}.`);
  } else {
    parts.push("Every wall in this room is solid.");
  }
  if (doors > 0) parts.push("All doors are closed.");
  if (furnitureCount > 0) {
    const verb = furnitureCount === 1 ? "is" : "are";
    parts.push(`${cap(word(furnitureCount))} furniture ${plural(furnitureCount, "piece")} ${verb} already placed.`);
  }
  return parts.join(" ");
}

/**
 * Positive-contents clause for service/back-of-house room types that carry
 * no catalogue furniture (furnitureForRoomType / defaultFurnitureFor in
 * greybox/furniture-catalogue.ts return an empty set for these). Without an
 * explicit statement of what the room DOES contain, the furniture-materials
 * section below is simply omitted for these rooms, leaving nothing to anchor
 * the model against the style/luxury brief in section 4 — which is exactly
 * how a "luxury living space" brief ends up free-associating a sofa into a
 * bathroom. There is no negativePrompt channel on bfl:* models (see this
 * file's header and docs/flux-prompting-techniques.md section 2.4), so this
 * is deliberately a positive statement of contents ("contains X only"),
 * never a negative one ("no sofa") — naming the unwanted object is what
 * makes the model more likely to paint it in. Keys are lowercased room-type
 * strings and must stay in sync with greybox/furniture-catalogue.ts's
 * NO_FURNITURE_ROOM_TYPES (plus Pooja Room, which does get one catalogue
 * item but benefits from the same explicit statement). Each phrase is
 * hand-written and short by design, on the same size order as one
 * buildFurnitureMaterials() line, so it fits the section 5 budget untouched.
 */
const SERVICE_ROOM_CONTENTS: Record<string, string> = {
  bathroom: "This room contains sanitary fixtures, a vanity and tiled surfaces only.",
  washroom: "This room contains sanitary fixtures, a vanity and tiled surfaces only.",
  utility: "This room contains laundry appliances, a wash counter and shelving only.",
  "store room": "This room contains shelving and closed storage cabinetry only.",
  storage: "This room contains shelving and closed storage cabinetry only.",
  garage: "This room contains a parking surface and wall-mounted storage only.",
  "pooja room": "This room contains the pooja mandir and simple shelving only.",
};

/**
 * Note on templates: this no longer reads getBuilderTemplate(). Its three
 * fields are all deleted content under section 2.4 — `intro` is replaced by
 * the medium line, `cameraPrefix` restates a camera the reference image
 * already fixes, and `negativePrefix` introduces exclusions into a prompt
 * with no negation channel. getBuilderTemplate stays exported from
 * templates.ts because the prompt_templates row and its admin UI still
 * exist; it simply has no consumer in the image path any more.
 */
export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: { ledger?: GreyboxLedger; furniture?: PlacedFurniture[]; hasGreybox: boolean },
): Promise<string> {
  const furniture = opts.furniture ?? [];

  // 1. Medium + lens. No focal length: section 2.3 tested naming one against a
  //    real output and rejected it — FLUX.2 renormalises perspective to ~20-24mm
  //    without moving openings, and naming a focal length buys camera fidelity
  //    that isn't required at the cost of barrel distortion.
  //
  //    UNVERIFIED (2026-08-10): the trailing surface-texture sentence is a
  //    prompt-side response to a user complaint that painted walls sometimes
  //    render as smooth wax/thick oil paint. A separate investigation of
  //    runware-client.ts found no server-side lever for this on the active
  //    model (bfl:5@1 / FLUX.2 [pro]): `steps` is rejected outright
  //    (unsupportedArchitectureSteps), CFGScale doesn't exist as a parameter
  //    on this model, and output is already lossless PNG, so there is no
  //    JPEG-artefact or sampler explanation either. Positive phrasing only,
  //    per this file's header: state what the surface IS (faint roller-nap
  //    texture, natural sheen variation), never what it should avoid being
  //    (naming "waxy" or "oil painting" would make the model more likely to
  //    produce it, per section 2.4's "every constraint gets a positive
  //    phrasing or gets deleted"). Appended to `medium` rather than a new
  //    section: this is the one line in the whole template that is fixed
  //    boilerplate and never touched by the overflow ladder (see the
  //    `assemble` closure below), so a texture clause placed here costs a
  //    known, constant number of characters and can never be silently
  //    dropped ahead of the structural contract or opening ledger — exactly
  //    the "don't let it starve the higher-priority sections, but don't let
  //    it be the first thing cut either" placement this needed. Not yet
  //    validated against a real generated image.
  const medium =
    "Photorealistic interior photograph, wide angle, eye level. Painted walls show faint " +
    "roller-nap texture and natural sheen variation.";

  // 2. Structural contract, or a one-line geometry statement when there is no
  //    reference image. One code path, one budget, one assert.
  const contract = opts.hasGreybox
    ? structuralContract(furniture.length > 0)
    : `A ${input.design.luxury_level.toLowerCase()} "${input.design.style}" ${input.project.subcategory}. ` +
      "Straight walls, level camera, eye level.";

  // 3. Opening ledger.
  const ledger = opts.hasGreybox && opts.ledger ? openingLedger(opts.ledger, furniture.length) : "";

  // 4. Room brief.
  const roomLabel =
    room.type && room.type.trim() && room.type.trim().toLowerCase() !== room.name.trim().toLowerCase()
      ? `${room.name}, a ${room.type.toLowerCase()}`
      : room.name;
  const guidance = spec.roomGuidelines.find((g) => g.room === room.name)?.compactGuidance ?? "";
  // Section 2.4: room dimensions in feet are deleted — the greybox encodes
  // proportion far more precisely than a number in prose can.
  const brief = [`${cap(roomLabel)}.`, spec.compactBrief, guidance].filter(Boolean).join(" ").slice(0, BUDGET.brief);

  // 5. Furniture materials. Derived from the set of types present. When
  //    there is no furniture at all, this used to omit the line entirely;
  //    for a known service room type that's exactly the gap that let a
  //    style brief free-associate a sofa into a bathroom, so a room with no
  //    furniture and a matching entry in SERVICE_ROOM_CONTENTS gets that
  //    positive statement in the same slot instead. Rooms with furniture, or
  //    with no furniture and no service-room entry (e.g. an empty Living
  //    Room mid-furnish), keep the prior "line omitted" behaviour.
  const serviceContents = SERVICE_ROOM_CONTENTS[room.type?.trim().toLowerCase() ?? ""];
  const furnitureLine = furniture.length
    ? buildFurnitureMaterials(furniture, spec.materialTokens, BUDGET.furniture)
    : (serviceContents ?? "").slice(0, BUDGET.furniture);

  // 6. Accent — optional, always last, engineered to be the thing that gets
  //    cut if anything gets cut.
  const accent = (room.additional_notes?.trim() ?? "").slice(0, BUDGET.accent);

  // Section 4.4 overflow order: drop accent, then trim furniture by priority,
  // then trim brief. NEVER the contract or the ledger. All three stages
  // rebuild the prompt through the same section list/order so no stage can
  // silently drop a section the other stages still expect to be there.
  let briefOut = brief;
  let furnOut = furnitureLine;
  let accentOut = accent;
  const assemble = () => [medium, contract, ledger, briefOut, furnOut, accentOut].filter(Boolean).join("\n\n");

  let prompt = assemble();
  if (prompt.length > MAX_PROMPT_CHARS && accentOut) {
    accentOut = "";
    prompt = assemble();
  }
  if (prompt.length > MAX_PROMPT_CHARS && furnOut) {
    // Re-derive from the catalogue only when furnOut actually came from real
    // furniture. The service-room contents clause isn't catalogue-derived
    // (furniture is empty in exactly the case it applies), so re-running
    // buildFurnitureMaterials on an empty array would wipe it back to "" —
    // just clamp its own length instead, same as any other trimmed section.
    furnOut = furniture.length
      ? buildFurnitureMaterials(furniture, spec.materialTokens, 100)
      : furnOut.slice(0, 100);
    prompt = assemble();
  }
  if (prompt.length > MAX_PROMPT_CHARS && briefOut) {
    const overflow = prompt.length - MAX_PROMPT_CHARS;
    briefOut = briefOut.slice(0, Math.max(0, briefOut.length - overflow - 8)).trim();
    prompt = assemble();
  }

  // Section 1, R1: throw rather than send. Runware accepts up to 32,000 chars
  // and silently discards everything past the encoder's limit, so an overlong
  // prompt fails invisibly — which is exactly how the old geometry clause was
  // lost for weeks without a single error.
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS} limit for room "${room.name}"`);
  }

  // Section 1, R3.
  console.log(`[prompt-builder] room="${room.name}" chars=${prompt.length} hash=${fnv1a(prompt)}`);
  return prompt;
}
