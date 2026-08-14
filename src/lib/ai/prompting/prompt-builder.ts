import "server-only";
import {
  buildFurnitureMaterials,
  buildMappedFurnitureLine,
  toWorldFurniture,
  type MaterialTokens,
} from "@/lib/greybox/furniture-layout";
import { describeFurniture } from "@/lib/greybox/furniture-descriptors";
import { greyboxCamera } from "@/lib/greybox/camera";
import { GREYBOX_ASPECT } from "@/lib/greybox/dimensions";
import { fnv1a } from "@/lib/greybox/greybox-hash";
import { catalogueEntry } from "@/lib/greybox/furniture-catalogue";
import { getProviderPrimary, type ProviderChoice } from "@/lib/settings/provider-settings";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "./types";
import type { GreyboxCameraView, GreyboxOpening, GreyboxRoomSpec } from "@/lib/greybox/types";
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
 *
 * TWO FLOWS, chosen by which image model will actually run
 * (`getProviderPrimary("image_gen")`, overridable via `opts.provider`):
 *
 *   - "runware" (FLUX.2 [pro]): everything above. FLUX.2's encoder is
 *     Mistral-Small-3.2-24B-Instruct, an instruction-tuned LLM trained on
 *     PROSE — tag lists and structured input read to it as poorly-formed
 *     English, and Black Forest Labs' own guidance is plain prose. This flow
 *     is untouched by the JSON flow below: same functions, same budgets,
 *     same 1,800-char cap.
 *   - "gemini" (Nano Banana / Nano Banana Pro): `buildGeminiPrompt` below.
 *     Gemini's image path has an explicit reasoning pass before generation,
 *     follows long structured instructions well, and JSON-structured
 *     prompting is an established effective pattern for it — it has no
 *     512-token encoder cliff, so it gets a generous sanity ceiling instead
 *     of a hard truncation-safety budget. It carries the SAME information in
 *     the SAME PRIORITY ORDER as the FLUX flow (openings, then furniture,
 *     then geometry/surfaces, then colour/lighting, then additional
 *     requirements), built from the same underlying values so the two flows
 *     cannot silently drift apart — see `openingCounts`, `mappedFurnitureItems`,
 *     `roomLabelFor`, `guidanceFor`, `serviceContentsFor` below, each shared
 *     by both flows.
 */

/** Section 1, R1. Hard ceiling. Throw and fail the job — never send over. */
const MAX_PROMPT_CHARS = 1800;
/** Section 4.4 per-section budgets. */
// furniture raised 200 -> 460 when the mapped form landed. The old unmapped
// line was a bare list of materials; the mapped one spends characters naming
// WHICH box each material belongs to, so at 200 a three-piece room silently
// lost two pieces to the priority trim — observed in a real assembled prompt.
// Furniture identity is the user's stated priority 2, and a full prompt still
// lands near 1,200 of the 1,800 cap, so the headroom was simply unused.
const BUDGET = { brief: 240, furniture: 460, accent: 100 } as const;

/**
 * Gemini-flow sanity ceiling — NOT a truncation budget. `MAX_PROMPT_CHARS`
 * above exists because FLUX.2's encoder actually cuts text off at that
 * length; Gemini has no equivalent cliff, so nothing here is ever trimmed to
 * fit under this number the way the FLUX ladder trims toward 1,800. This
 * exists only to catch a genuinely pathological input (e.g. a multi-KB
 * `additional_notes` paste, or a future bug that stops filtering the verbose
 * DesignSpecification fields) before it reaches a network call, per this
 * file's "throw rather than send invisibly wrong" rule.
 *
 * 12,000 was picked as roughly 6-7x the entire FLUX prompt's cap: generous
 * enough that JSON's structural overhead (quotes, braces, repeated keys) and
 * an unclamped accent/guidance field never trip it under any legitimate
 * input this app produces, while still being a hard, finite number rather
 * than "however big JSON.stringify happens to make it."
 */
const MAX_JSON_PROMPT_CHARS = 12_000;

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
function structuralContract(hasFurniture: boolean, ledger?: GreyboxLedger): string {
  const furnitureClause = hasFurniture
    ? " Darker grey volumes are furniture: keep their position, footprint and approximate size."
    : "";
  // Collapsed at the END, over the whole assembled string. openingCensus and
  // furnitureClause each carry their own boundary space so they can be empty
  // without leaving a gap, which means the junction between them can hold two.
  // Collapsing inside either piece alone cannot see that junction.
  return (
    "Image 1 is an untextured grey massing render of this exact room, from the exact camera the " +
    "output must use. Preserve without deviation: camera position, angle and field of view; room " +
    "proportions and all wall positions; the position, width and height of every opening. A framed " +
    `recessed panel is a closed door. A bright panel is a window. ${openingCensus(ledger)}` +
    `${furnitureClause} Change only surfaces, materials, lighting and furnishing.`
  ).replace(/ {2,}/g, " ");
}

/**
 * The exact door/window counts driving BOTH flows' opening statements —
 * extracted so the FLUX prose (`openingCensus` below) and the Gemini JSON
 * flow (`buildGeminiPrompt`'s `openings` field) read the identical numbers
 * off the identical source instead of two call sites each writing
 * `ledger?.doors ?? 0` and risking one of them drifting to `openings.length`.
 * Counts come from the Pass B mask ledger, never from placedOpenings.length —
 * see openingCensus's doc comment below for why.
 */
function openingCounts(ledger?: GreyboxLedger): { doors: number; windows: number } {
  return { doors: ledger?.doors ?? 0, windows: ledger?.windows ?? 0 };
}

/**
 * The exact opening count, stated INSIDE the structural contract rather than
 * as its own later stanza.
 *
 * Two changes from the old separate ledger sentence, both requested after
 * real outputs kept inventing extra doors. First, position: the count now
 * sits immediately after the sentences that teach the model what a door and a
 * window LOOK like in the reference, so the definition and the quantity are
 * one thought instead of two paragraphs apart. Second, and more important,
 * the closing clause — the prompt never used to say that the listed openings
 * were the ONLY ones. "The room has one door" is not a claim that there is
 * exactly one door, and a model filling a large wall will happily add another.
 *
 * Positive phrasing throughout, per this file's header: "exactly N, and every
 * other surface is unbroken solid wall" states what is there. Writing "no
 * extra doors" would name the unwanted object, which on a model with no
 * negativePrompt channel makes it MORE likely to appear.
 *
 * Counts still come from the Pass B mask (see buildRoomPrompt's caller), never
 * from placedOpenings.length: an opening clipped at the frame edge, behind the
 * camera, or hidden behind furniture is not in the output, and claiming it
 * tells the model to invent one.
 */
function openingCensus(ledger?: GreyboxLedger): string {
  const { doors, windows } = openingCounts(ledger);
  if (doors === 0 && windows === 0) {
    return "Every wall in this room is unbroken solid wall, with no doors and no windows. ";
  }
  const parts: string[] = [];
  if (doors > 0) parts.push(`${word(doors)} ${plural(doors, "door")}`);
  if (windows > 0) parts.push(`${word(windows)} ${plural(windows, "window")}`);
  const closed = doors > 0 ? " All doors are closed." : "";
  return (
    `This room has exactly ${parts.join(" and ")}, only where Image 1 shows ${
      doors + windows === 1 ? "it" : "them"
    }. Every other surface is unbroken solid wall.${closed} `
  );
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
/** Shared shape for the room geometry a camera can be rebuilt from — the same subset of GreyboxRoomSpec both mappedFurnitureItems and the caller's opts.roomSpec already use. */
type CameraRoomSpec = { width: number; depth: number; openings: GreyboxOpening[]; cameraView?: GreyboxCameraView };

/**
 * Pairs each in-frame furniture proxy with its material phrase and its
 * index into the room's own furniture array, keyed to the box it actually
 * is in the reference image.
 *
 * The camera is rebuilt here from the same `greyboxCamera(spec, aspect)` the
 * render used. That is safe and deliberate rather than duplicated state:
 * greyboxCamera is a deterministic pure function of the spec and aspect (a
 * dev-check fixture proves the same inputs always yield an identical camera),
 * so reconstructing it server-side lands on exactly the viewpoint the client
 * rendered from, without shipping camera internals through the request body
 * and without trusting the client to describe its own layout.
 *
 * Split out from the old `mappedFurnitureFor` so both flows describe the
 * SAME set of in-frame pieces, through the SAME camera math, and can never
 * drift apart: the FLUX flow turns this into one prose sentence via
 * `buildMappedFurnitureLine` (see the thin wrapper directly below), and the
 * Gemini flow turns it into per-box JSON entries (`buildGeminiPrompt`),
 * using `index` as the box number when `opts.numberedFurniture` is set —
 * that index is exactly the position each piece has in the array the
 * (separately-built) numbered annotation image is expected to number from.
 */
function mappedFurnitureItems(
  roomSpec: CameraRoomSpec,
  furniture: PlacedFurniture[],
): { index: number; kind: string; phrase: string }[] {
  const full: GreyboxRoomSpec = {
    width: roomSpec.width,
    depth: roomSpec.depth,
    openings: roomSpec.openings,
    cameraView: roomSpec.cameraView,
    furniture: toWorldFurniture(furniture, roomSpec.width, roomSpec.depth),
  };
  const camera = greyboxCamera(full, GREYBOX_ASPECT);
  const described = describeFurniture(full, camera);
  // toWorldFurniture drops unknown kinds, so `described` indexes into the
  // FILTERED world list, not the caller's raw array. Pair against that same
  // filtered list rather than `furniture` or the two can fall out of step.
  const world = full.furniture ?? [];
  return described
    .filter((d) => d.inFrame)
    .map((d) => ({ index: d.index, kind: world[d.index]?.kind ?? d.kind, phrase: d.phrase }));
}

/** FLUX-only: the mapped items above, joined into one prose sentence. Untouched behaviour from before the split. */
function mappedFurnitureFor(
  roomSpec: CameraRoomSpec,
  furniture: PlacedFurniture[],
  tokens: { wood: string; soft: string; stone: string },
): string {
  return buildMappedFurnitureLine(mappedFurnitureItems(roomSpec, furniture), tokens, BUDGET.furniture);
}

/**
 * Section 4's room label ("Name, a type" when they differ, else the bare
 * name) — shared by both flows so a wording change can't drift them apart.
 */
function roomLabelFor(room: UniversalInputRoom): string {
  return room.type && room.type.trim() && room.type.trim().toLowerCase() !== room.name.trim().toLowerCase()
    ? `${room.name}, a ${room.type.toLowerCase()}`
    : room.name;
}

/** This room's slice of the Design Planning Layer's per-room guidance, or "" when none was produced. Shared by both flows. */
function guidanceFor(spec: DesignSpecification, room: UniversalInputRoom): string {
  return spec.roomGuidelines.find((g) => g.room === room.name)?.compactGuidance ?? "";
}

/** SERVICE_ROOM_CONTENTS lookup by this room's type, or undefined for a room with no matching entry. Shared by both flows. */
function serviceContentsFor(room: UniversalInputRoom): string | undefined {
  return SERVICE_ROOM_CONTENTS[room.type?.trim().toLowerCase() ?? ""];
}

/**
 * furniture-layout.ts's token interpolation (`{wood}`/`{soft}`/`{stone}` ->
 * the design spec's chosen materials) is a private, unexported helper there,
 * and this file's scope is prompt-builder.ts alone — it cannot be exported
 * without editing that file. This is a one-line reimplementation of that
 * exact regex, not a fork of anything with real logic in it (the camera
 * projection, in-frame filtering and priority-based trimming all stay fully
 * shared via `mappedFurnitureItems`/`buildMappedFurnitureLine` above).
 */
function interpolateTokens(phrase: string, tokens: MaterialTokens): string {
  return phrase.replace(/\{wood\}/g, tokens.wood).replace(/\{soft\}/g, tokens.soft).replace(/\{stone\}/g, tokens.stone);
}

/**
 * One mapped furniture item -> one Gemini-flow JSON entry.
 *
 * `box` is the model's pointer into image 2 (the annotated numbered greybox,
 * built elsewhere — see buildGeminiPrompt's header) when `numbered` is true:
 * `item.index` is this piece's position in the room's own furniture array
 * (see mappedFurnitureItems), which is exactly the array position a numbered
 * annotation drawn "one number per box, in furniture-array order" would use,
 * so `index + 1` is the number that piece carries in that image. When
 * `numbered` is false (no such image exists yet, or this call predates one),
 * `box` falls back to the same positional descriptor phrase the FLUX flow
 * already uses ("the long low box at centre-left").
 */
function geminiFurnitureEntry(
  item: { index: number; kind: string; phrase: string },
  tokens: MaterialTokens,
  numbered: boolean,
): { box: number | string; is: string } {
  const entry = catalogueEntry(item.kind);
  const materialPhrase = entry ? interpolateTokens(entry.materialPhrase, tokens) : item.kind;
  return { box: numbered ? item.index + 1 : item.phrase, is: materialPhrase };
}

/**
 * The Gemini (Nano Banana) flow — see this file's header for why it exists
 * as a second flow instead of reusing the FLUX prose. Same information, same
 * priority order (openings, furniture, geometry/surfaces, colour/lighting,
 * additional requirements last), emitted as COMPACT JSON (no pretty-print —
 * `JSON.stringify` with no indent argument) rather than prose. Object key
 * insertion order IS the priority order: JS/JSON preserve string-key
 * insertion order, so the literal below reads top-to-bottom exactly as the
 * five priority tiers are numbered in this file's header.
 *
 * Positive phrasing only, same rule as the FLUX flow (see openingCensus and
 * buildFurnitureMaterials's doc comments): there is no negativePrompt
 * channel on either model family, so this never states what should NOT
 * appear, only what does.
 */
function buildGeminiPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: {
    ledger?: GreyboxLedger;
    furniture?: PlacedFurniture[];
    hasGreybox: boolean;
    roomSpec?: CameraRoomSpec;
    numberedFurniture?: boolean;
  },
): string {
  const furniture = opts.furniture ?? [];
  const numbered = opts.numberedFurniture ?? false;
  const payload: Record<string, unknown> = {};

  // Priority 0 (framing, not itself one of the five priority tiers — the
  // FLUX flow's `medium` line plays the same unconditional, always-first
  // role). Identifies what each reference image IS so the priority-ordered
  // fields below can refer to "image 1"/"image 2" without redefining them
  // every time.
  if (opts.hasGreybox) {
    const referenceImages: Record<string, string> = {
      image1:
        "An untextured grey massing render of this exact room, from the exact camera the output must use. " +
        "A framed recessed panel is a closed door; a bright panel is a window.",
    };
    if (numbered) {
      referenceImages.image2 =
        "A key: the same room with a number drawn on each furniture box, for matching entries in the " +
        "furniture field below only. The numerals identify boxes to you and must NOT be reproduced, drawn " +
        "or rendered anywhere in the output image.";
    }
    payload.referenceImages = referenceImages;
  } else {
    payload.scene = `A ${input.design.luxury_level.toLowerCase()} "${input.design.style}" ${input.project.subcategory}.`;
  }

  // Priority 1: openings — exact counts, from the Pass B mask ledger via the
  // same openingCounts() the FLUX census uses, and the fact that they are
  // the only ones. Digits, not word-forms: word-forms exist only because
  // FLUX's text encoder represents them as cleaner single tokens (see
  // `word()`'s doc comment) — that reasoning is specific to FLUX and doesn't
  // apply here, and a numeric JSON field is the more natural shape.
  if (opts.hasGreybox) {
    const { doors, windows } = openingCounts(opts.ledger);
    const openings: Record<string, unknown> = {
      doors,
      windows,
      rule:
        doors + windows === 0
          ? "Every wall in this room is unbroken solid wall."
          : "These are the only openings, positioned only where image 1 shows them; every other wall surface is unbroken solid wall.",
    };
    if (doors > 0) openings.doorsClosed = true;
    payload.openings = openings;
  }

  // Priority 2: furniture — which grey box (or, once numbered, which number)
  // is which piece. Mirrors the FLUX flow's three-way branch (mapped ->
  // unmapped fallback -> service-room contents -> omitted) so a room that
  // renders nothing on the FLUX flow renders nothing here either.
  const furnitureItems = opts.roomSpec ? mappedFurnitureItems(opts.roomSpec, furniture) : [];
  const serviceContents = serviceContentsFor(room);
  if (furniture.length && furnitureItems.length) {
    payload.furniture = {
      items: furnitureItems.map((item) => geminiFurnitureEntry(item, spec.materialTokens, numbered)),
    };
  } else if (furniture.length) {
    // No roomSpec/camera available (caller hasn't updated, matching the FLUX
    // flow's own fallback note) — fall back to the unmapped, un-positioned
    // set via the same buildFurnitureMaterials() the FLUX flow's own
    // fallback uses, wrapped as a single JSON string rather than duplicating
    // its catalogue-ordering/priority-drop logic. Budget is generous (no
    // FLUX-style 200-char retry needed) since this flow has no char cap.
    const summary = buildFurnitureMaterials(furniture, spec.materialTokens, 4000);
    if (summary) payload.furniture = { summary };
  } else if (serviceContents) {
    payload.furniture = { contents: serviceContents };
  }

  // Priority 3: "nothing abnormal" — geometry lock and matte, non-reflective
  // wall surfaces. Always present regardless of hasGreybox, mirroring the
  // FLUX flow's `medium` wall-finish clause, which is likewise unconditional.
  // Never say "sheen"/"gloss"/"glossy"/"satin"/"roller-nap" — see this
  // file's header on the oily-wall bug those words caused.
  payload.geometryLock = opts.hasGreybox
    ? "Camera position, angle and field of view; room proportions; every wall position; and the position, " +
      "width and height of every opening match image 1 exactly, with no deviation."
    : "Straight walls, level camera, eye level.";
  payload.wallSurfaces =
    "Wall paint and plaster are flat matte, chalky and light-absorbing. Change only surfaces, materials, lighting and furnishing.";

  // Priority 4: colour/palette and lighting, bundled with the room's label
  // and per-room guidance — the same content the FLUX flow's "Room brief"
  // section carries (compactBrief is documented there as "palette, key
  // materials, light quality"). Unlike the FLUX flow, neither field is
  // sliced to BUDGET.brief: that budget exists to protect FLUX's 1,800-char
  // cap, which does not apply here.
  const guidance = guidanceFor(spec, room);
  payload.roomBrief = {
    label: cap(roomLabelFor(room)),
    ...(spec.compactBrief ? { brief: spec.compactBrief } : {}),
    ...(guidance ? { guidance } : {}),
  };

  // Priority 5: additional requirements, always last, omitted when empty —
  // same rule as the FLUX flow's accent line.
  const accent = (room.additional_notes ?? "").trim();
  if (accent) payload.additionalRequirements = accent;

  const prompt = JSON.stringify(payload);

  // Sanity ceiling, not a truncation budget — see MAX_JSON_PROMPT_CHARS's
  // doc comment. Throw rather than silently send an enormous prompt, same
  // "fail loud" rule Section 1 R1 states for the FLUX cap.
  if (prompt.length > MAX_JSON_PROMPT_CHARS) {
    throw new Error(
      `Gemini prompt is ${prompt.length} chars, over the ${MAX_JSON_PROMPT_CHARS}-char sanity ceiling for room "${room.name}"`,
    );
  }

  // Section 1, R3 — same observability both flows share.
  console.log(`[prompt-builder] room="${room.name}" provider=gemini chars=${prompt.length} hash=${fnv1a(prompt)}`);
  return prompt;
}

export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: {
    ledger?: GreyboxLedger;
    furniture?: PlacedFurniture[];
    hasGreybox: boolean;
    /**
     * The room's greybox geometry, so each furniture piece can be tied to the
     * specific box it is in the reference image. Optional: without it the
     * furniture line falls back to the old unmapped set.
     */
    roomSpec?: { width: number; depth: number; openings: GreyboxOpening[]; cameraView?: GreyboxCameraView };
    /**
     * Explicit override for which image model this prompt targets. Defaults
     * to `getProviderPrimary("image_gen")` — the same DB-backed setting the
     * console's model switcher writes — but dev-check needs to exercise both
     * flows deterministically without depending on Supabase state, hence the
     * override.
     */
    provider?: ProviderChoice;
    /**
     * Set once the second reference image exists: an annotated copy of the
     * greybox with a number drawn on each furniture box (built elsewhere —
     * not this file's concern). Gemini-flow only; ignored on the FLUX flow,
     * which never had a second reference image and still doesn't. See
     * `geminiFurnitureEntry`'s doc comment for the numbering contract.
     */
    numberedFurniture?: boolean;
  },
): Promise<string> {
  const provider = opts.provider ?? (await getProviderPrimary("image_gen"));
  if (provider === "gemini") {
    return buildGeminiPrompt(input, room, spec, opts);
  }

  const furniture = opts.furniture ?? [];

  // 1. Medium + lens. No focal length: section 2.3 tested naming one against a
  //    real output and rejected it — FLUX.2 renormalises perspective to ~20-24mm
  //    without moving openings, and naming a focal length buys camera fidelity
  //    that isn't required at the cost of barrel distortion.
  //
  //    The surface sentence was previously "faint roller-nap texture and
  //    natural SHEEN variation", added 2026-08-10 to fight a report of walls
  //    rendering as smooth wax. It made things worse and was the likely cause:
  //    "sheen" means shine, and asking for sheen variation on top of a brief
  //    that already says "lime walls" is close to a direct instruction toward
  //    the oily plaster look that was being complained about. Replaced with
  //    unambiguously matte language. Still positive phrasing only (state what
  //    the surface IS, never name the artefact — there is no negativePrompt
  //    channel on bfl:* models and naming "waxy" makes it more likely), and
  //    still appended to `medium` because that is the one line the overflow
  //    ladder never touches, so it costs a constant number of characters and
  //    can neither starve nor be starved by the sections below.
  const medium =
    "Photorealistic interior photograph, wide angle, eye level. Wall paint and plaster are " +
    "flat matte, chalky and light-absorbing.";

  // 2. Structural contract, or a one-line geometry statement when there is no
  //    reference image. One code path, one budget, one assert.
  const contract = opts.hasGreybox
    ? structuralContract(furniture.length > 0, opts.ledger)
    : `A ${input.design.luxury_level.toLowerCase()} "${input.design.style}" ${input.project.subcategory}. ` +
      "Straight walls, level camera, eye level.";

  // 3. The opening ledger used to be its own stanza here. It is now folded
  //    into the contract above (openingCensus), so that the definition of
  //    what a door looks like and the statement of how many there are sit in
  //    one paragraph. Section order is a truncation-safety mechanism, and
  //    merging them means the single most important fact in the whole prompt
  //    cannot end up a paragraph away from its own definition.
  const ledger = "";

  // 4. Room brief.
  const roomLabel = roomLabelFor(room);
  const guidance = guidanceFor(spec, room);
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
  //    When the caller supplies the room's geometry, each piece is bound to
  //    the specific grey box it is in the reference image rather than listed
  //    as an unattached set — see buildMappedFurnitureLine. Pieces the camera
  //    cannot see are dropped here, not described: naming a piece that is not
  //    in frame tells the model to invent one, the same failure the opening
  //    census avoids by counting from the mask. Falls back to the old
  //    unmapped line when no geometry was passed, so a caller that hasn't
  //    been updated still produces a valid prompt.
  const serviceContents = serviceContentsFor(room);
  const mapped = opts.roomSpec ? mappedFurnitureFor(opts.roomSpec, furniture, spec.materialTokens) : "";
  const furnitureLine = furniture.length
    ? mapped || buildFurnitureMaterials(furniture, spec.materialTokens, BUDGET.furniture)
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
