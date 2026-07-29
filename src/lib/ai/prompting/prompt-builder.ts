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
 */
export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
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
  if (room.openings?.length) lines.push(`Real openings, respect them exactly: ${describeOpenings(room.openings)}.`);

  lines.push("", `${builder.cameraPrefix} ${spec.cameraGuidelines}`);
  lines.push(`${builder.negativePrefix} ${spec.negativeConstraints}`);

  return withSystemPreamble(lines.join("\n"));
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
