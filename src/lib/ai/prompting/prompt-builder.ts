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
    lines.push(...GREYBOX_GEOMETRY_CLAUSE);
  } else if (room.openings?.length) {
    lines.push("", `Real openings, respect them exactly: ${describeOpenings(room.openings)}.`);
  }

  // With a greybox, the camera is already fixed by the reference image —
  // restating it in words too invites the two to disagree, so only mood/
  // lighting language from cameraGuidelines would apply there. In practice
  // cameraGuidelines is framing-only text with no separable lighting
  // component, so it's dropped entirely for greybox rooms rather than
  // parsed for a piece that isn't reliably present.
  if (!opts.hasGreybox) {
    lines.push("", `${builder.cameraPrefix} ${spec.cameraGuidelines}`);
  }
  lines.push(`${builder.negativePrefix} ${spec.negativeConstraints}`);

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
 */
const GREYBOX_GEOMETRY_CLAUSE = [
  "",
  "The attached image is an untextured grey 3D massing render of this exact room, from the exact " +
    "camera position the output must use. You MUST preserve, without any deviation:",
  "- the camera position, angle and field of view;",
  "- the room's proportions and every wall position;",
  "- the position, width and height of every door and window opening shown. A closed, framed panel " +
    "is a door — render it CLOSED, never open. A bright panel is a window.",
  "Every surface not shown as an opening is solid. Do not add a door, window or any glazing at a " +
    "corner or wall junction that the reference shows as solid. Do not move, resize, add or remove " +
    "a single opening.",
  "Change ONLY surfaces, materials, lighting and furnishing to match the brief below.",
];

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
