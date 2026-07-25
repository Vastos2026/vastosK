import "server-only";
import { getBuilderTemplate } from "./templates";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "./types";

/**
 * The Prompt Builder — deterministic, no AI call. Assembles the final
 * natural-language image-generation prompt for ONE room from: System Rules +
 * Project Context + the cached Design Specification + that room's slice of
 * Room Guidelines + that room's own Additional Requirements + Camera/
 * Negative Rules. This is the only place natural-language prompt text is
 * produced anywhere in the app — the frontend and every AI stage before this
 * point only ever handle structured JSON.
 */
export async function buildRoomPrompt(
  input: UniversalInput,
  room: UniversalInputRoom,
  spec: DesignSpecification,
): Promise<string> {
  const builder = await getBuilderTemplate();
  const guidance = spec.roomGuidelines.find((g) => g.room === room.name)?.guidance;

  const lines = [
    builder.intro,
    "",
    `Room: ${room.name} (${room.size}) in a ${input.design.luxury_level.toLowerCase()} ` +
      `"${input.design.style}" ${input.project.subcategory}.`,
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

  lines.push("", `${builder.cameraPrefix} ${spec.cameraGuidelines}`);
  lines.push(`${builder.negativePrefix} ${spec.negativeConstraints}`);

  return lines.join("\n");
}
