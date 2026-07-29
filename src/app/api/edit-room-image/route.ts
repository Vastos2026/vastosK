/**
 * View & Edit — multi-region lasso edit (revamp Workstream 8.5, flow step 9).
 * Up to 2 independently-numbered regions, each with its own instruction,
 * applied to the room's current approved image. Everything outside the
 * selected regions must stay pixel-identical — each region is applied as its
 * own crop/composite pass (`gemini-image.ts`, already does this reliably for
 * one region), sequentially, so pass 2 never touches what pass 1 left alone.
 *
 *   POST /api/edit-room-image
 *     { projectId, baseImageKey, styleId, regions: [{ mask, prompt }, ...] }
 *     → { imageUrl, key }
 */

import { randomUUID } from "node:crypto";
import { editImage } from "@/lib/ai/provider";
import { ProviderError } from "@/lib/ai/errors";
import { getObject, putObject } from "@/lib/pipeline/storage";
import { STYLE_BY_ID, STYLES } from "@/lib/data";
import { recordGeneration } from "@/lib/supabase/generations";
import { assertAllowed } from "@/lib/api-guard";
import { MAX_LASSO_REGIONS } from "@/components/project/lasso-canvas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

interface Region {
  /** PNG mask data URI — white = edit this region, black = leave untouched */
  mask?: string;
  prompt?: string;
}

interface Body {
  projectId?: string;
  baseImageKey?: string;
  styleId?: string;
  regions?: Region[];
}

export async function POST(request: Request) {
  // Each region is its own paid image-edit call (up to 2 per request).
  const guard = await assertAllowed(request, {
    rateLimit: { key: "edit-room-image", limit: 8, windowMs: 60_000 },
    checkUsage: true,
  });
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId, baseImageKey, styleId, regions } = body;
  if (!projectId || !baseImageKey) {
    return Response.json({ error: "projectId and baseImageKey are required" }, { status: 400 });
  }
  const validRegions = (regions ?? []).filter((r): r is Required<Region> => !!r.mask && !!r.prompt?.trim());
  if (validRegions.length === 0) {
    return Response.json({ error: "at least one region (mask + prompt) is required" }, { status: 400 });
  }
  if (validRegions.length > MAX_LASSO_REGIONS) {
    return Response.json({ error: `at most ${MAX_LASSO_REGIONS} regions per edit` }, { status: 400 });
  }
  if (!baseImageKey.startsWith("renders/")) {
    return Response.json({ error: "Invalid baseImageKey" }, { status: 400 });
  }

  const style = STYLE_BY_ID[styleId ?? ""] ?? STYLES[0];

  try {
    const baseBytes = await getObject(baseImageKey);
    let current = `data:image/png;base64,${baseBytes.toString("base64")}`;

    for (const region of validRegions) {
      const edited = await editImage(current, region.mask, region.prompt, style, { projectId, userId: guard.id });
      current = `data:${edited.contentType};base64,${edited.bytes.toString("base64")}`;
    }

    const finalBytes = Buffer.from(current.split(",")[1] ?? "", "base64");
    const key = `renders/${projectId}/${randomUUID()}.png`;
    await putObject(key, finalBytes, "image/png");
    const imageUrl = `/api/render?key=${encodeURIComponent(key)}`;
    void recordGeneration({ projectId, userId: guard.id, type: "edit", storageUrl: imageUrl });
    return Response.json({ imageUrl, key });
  } catch (e) {
    if (e instanceof ProviderError) {
      const status = e.category === "ValidationError" ? 400 : 502;
      return Response.json({ error: e.message, category: e.category }, { status });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Edit failed" },
      { status: 500 },
    );
  }
}
