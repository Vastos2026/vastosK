import "server-only";
import { getBuilderTemplate, withSystemPreamble } from "./templates";
import type { DesignSpecification, UniversalInput, UniversalInputOpening, UniversalInputRoom } from "./types";

/**
 * The Prompt Builder — deterministic, no AI call. Assembles the final
 * natural-language image-generation prompt for ONE room from: System Rules +
 * Project Context + the cached Design Specification + that room's slice of
 * Room Guidelines + that room's own Additional Requirements + Camera/
 * Negative Rules. This is the only place natural-language prompt text is
 * produced anywhere in the app — the frontend and every AI stage before this
 * point only ever handle structured JSON.
 *
 * System Rules are prepended via withSystemPreamble (templates.ts), not
 * fetched/spliced in here by hand — that manual pattern is exactly how this
 * function once silently omitted System Rules entirely (they only reached
 * the Design Planning call). Routing through the shared helper means this
 * and design-planning.ts can't independently drift out of sync again.
 *
 * `opts.hasGreybox` switches the openings clause from a word-only
 * description (side + connection) to a strict geometry-preservation block,
 * when the caller is also sending a perspective greybox reference image
 * (see docs/superpowers/specs/2026-08-01-greybox-*.md) — the reference
 * carries the real positions, so describing them in words too would be
 * redundant at best and contradictory at worst.
 */
export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
  opts: { hasGreybox?: boolean } = {},
): Promise<string> {
  const builder = await getBuilderTemplate();
  const guidance = spec.roomGuidelines.find((g) => g.room === room.name)?.guidance;
  // `name` is often unreliable on its own (a detected/user-typed label like
  // "Ananya's Room" says nothing about what kind of room it is) — `type` is
  // the actual semantic category (Bedroom, Kitchen, Pooja Room, ...) and, when
  // it's set and differs from the name, is called out explicitly so the model
  // isn't left to guess a room's purpose from a name alone.
  const roomLabel =
    room.type && room.type.trim() && room.type.trim().toLowerCase() !== room.name.trim().toLowerCase()
      ? `${room.name} (a ${room.type})`
      : room.name;

  // `size` is absent when the room's dimensions weren't given (not printed on
  // the plan, not filled in on Room Confirmation) — state the room without a
  // size clause rather than baking a wrong number into the render prompt.
  const roomIntro = room.size
    ? `Room: ${roomLabel} (${room.size}) in a ${input.design.luxury_level.toLowerCase()} ` +
      `"${input.design.style}" ${input.project.subcategory}.`
    : `Room: ${roomLabel} in a ${input.design.luxury_level.toLowerCase()} ` +
      `"${input.design.style}" ${input.project.subcategory}.`;

  const lines = [
    builder.intro,
    "",
    roomIntro,
    `Colour palette: ${input.design.colour_palette}.`,
    "",
    `Design language: ${spec.designLanguage}`,
    `Material palette: ${spec.materialPalette}`,
    `Lighting: ${spec.lightingStrategy}`,
    `Colour strategy: ${spec.colourStrategy}`,
    `Furniture language: ${spec.furnitureLanguage}`,
  ];

  if (guidance) lines.push("", `This room specifically: ${guidance}`);
  if (room.additional_notes?.trim()) lines.push(`Additional requirement: ${room.additional_notes.trim()}`);

  if (opts.hasGreybox) {
    lines.push(...greyboxGeometryClause(room.openings));
  } else if (room.openings?.length) {
    lines.push("", `Real openings, respect them exactly: ${describeOpenings(room.openings)}.`);
  }

  // Furniture (Phase B) is deliberately NOT described in words here. Once the
  // greybox reference image shows furniture proxies, the render is the single
  // source of spatial truth — a text restatement (even a coarse "near the
  // north wall") is a second source that can disagree with it, and geometry
  // is what the model reconciles against when the two conflict. What the
  // furniture is MADE OF (materials, not position) is a separate clause —
  // see buildFurnitureMaterials (furniture-layout.ts), wired in by Task 12.

  // With a greybox, the camera is already fixed by the reference image —
  // restating it in words too invites the two to disagree, so only mood/
  // lighting language from cameraGuidelines would apply there. In practice
  // cameraGuidelines is framing-only text with no separable lighting
  // component, so it's dropped entirely for greybox rooms rather than
  // parsed for a piece that isn't reliably present.
  if (!opts.hasGreybox) {
    lines.push("", `${builder.cameraPrefix} ${spec.cameraGuidelines}`);
  }

  // A second, negative-framed statement of the same door/window counts
  // already asserted (positively) in greyboxGeometryClause above.
  // Requested directly by the user after observing the positive framing
  // alone still let the model add an extra opening on some runs — stating
  // the same numbers as a hard cap in the negative-constraints line gives
  // the model two independent, differently-framed passes at the same
  // checkable fact rather than one.
  const negativeCounts = opts.hasGreybox ? negativeCountAddendum(room.openings) : "";
  lines.push(`${builder.negativePrefix} ${spec.negativeConstraints}${negativeCounts}`);

  return withSystemPreamble(lines.join("\n"));
}

/**
 * The strict geometry-preservation block for a greybox-conditioned
 * generation. Both defects it calls out by name (an open door, an invented
 * opening at a corner) were observed on a REAL generation in the Phase 0
 * spike under an earlier, shorter version of this same clause — see
 * docs/superpowers/specs/2026-08-01-greybox-opening-placement-design.md's
 * "Phase 0 result". The build-scene.ts geometry hardening (closed door
 * leaves, corner posts) targets the same two defects from the image side;
 * this is the prompt side of the same fix.
 *
 * Hardened further (2026-08-02) after a direct, confirmed report: the SAME
 * cached reference image, generated twice in a row with no changes, produced
 * two doors in one output and one in the other — the model inventing/
 * dropping an opening despite an unchanged, correct reference. "Preserve
 * what's shown" is a description, not a checkable instruction; giving the
 * model an explicit COUNT it can verify against ("there are exactly N doors
 * and M windows") is a stronger, falsifiable constraint than asking it to
 * eyeball the image. Also states standard real-world door/window widths
 * explicitly (the reference already encodes this geometrically — see
 * plan-editor/geometry.ts's STANDARD_DOOR_WIDTH_FT/STANDARD_WINDOW_WIDTH_FT
 * — this is reinforcement, not a new source of truth) since a stated size is
 * one more thing the model can check itself against rather than invent.
 */
function greyboxGeometryClause(openings: UniversalInputOpening[] | undefined): string[] {
  const doorCount = openings?.filter((o) => o.type === "door").length ?? 0;
  const windowCount = openings?.filter((o) => o.type === "window").length ?? 0;
  const totalCount = doorCount + windowCount;
  const countLine =
    totalCount > 0
      ? `This room has EXACTLY ${countSentence(doorCount, windowCount)} — no more, no fewer. Count them in ` +
        "the reference before you finish: if your output doesn't have exactly that many, it is wrong."
      : "This room has NO doors or windows in the reference — every wall is solid. Do not add one.";

  const lines = [
    "",
    "The attached image is an untextured grey 3D massing render of this exact room, from the exact " +
      "camera position the output must use. You MUST preserve, without any deviation:",
    "- the camera position, angle and field of view;",
    "- the room's proportions and every wall position;",
    "- the position, width and height of every door and window opening shown. A closed, framed panel " +
      "is a door — render it CLOSED, never open. A bright panel is a window. Doors are a standard " +
      "~3 feet (~0.9m) wide, windows a standard ~4 feet (~1.2m) wide, matching the reference exactly " +
      "— do not widen, narrow, or resize any opening.",
    countLine,
    "Every surface not shown as an opening is solid. Do not add a door, window or any glazing at a " +
      "corner or wall junction that the reference shows as solid. Do not move, resize, add or remove " +
      "a single opening, even if it would look more balanced or symmetrical — asymmetry in the " +
      "reference is intentional and must survive.",
    "Change ONLY surfaces, materials, lighting and furnishing to match the brief below.",
  ];

  return lines;
}

/**
 * " Do not render more than 1 door and 2 windows total in this room — extra doors or windows are a
 * defect, not a stylistic choice." Reuses the same counts as greyboxGeometryClause's positive
 * statement — this is a second, negative-framed pass at the identical numbers, not a new source of
 * truth.
 */
function negativeCountAddendum(openings: UniversalInputOpening[] | undefined): string {
  const doorCount = openings?.filter((o) => o.type === "door").length ?? 0;
  const windowCount = openings?.filter((o) => o.type === "window").length ?? 0;
  const parts: string[] = [];
  if (doorCount + windowCount > 0) {
    parts.push(`more than ${countSentence(doorCount, windowCount)} total in this room`);
  } else {
    parts.push("any door or window in this room");
  }
  return ` Do not render ${parts.join(", or ")} — extra openings are a defect, not a stylistic choice.`;
}

/** "1 door and 2 windows" / "3 doors" / "1 window" — omitting whichever count is zero. */
function countSentence(doorCount: number, windowCount: number): string {
  const parts: string[] = [];
  if (doorCount > 0) parts.push(`${doorCount} ${doorCount === 1 ? "door" : "doors"}`);
  if (windowCount > 0) parts.push(`${windowCount} ${windowCount === 1 ? "window" : "windows"}`);
  return parts.join(" and ");
}

/** Translates structured openings into natural language — only place this happens. */
function describeOpenings(openings: UniversalInputOpening[]): string {
  return openings
    .map((o) => {
      const where = `a ${o.type} on the ${o.side} wall`;
      if (!o.connectsTo || o.connectsTo === "exterior") return `${where} (exterior)`;
      return `${where} connecting to the ${o.connectsTo}`;
    })
    .join("; ");
}
