/**
 * Serves generated images/video back to the browser by storage key. Every
 * generation route (design-plan images, edits, walkthrough clips) stores
 * bytes under "renders/<projectId>/..." via the shared storage layer and
 * points the client here instead of depending on a provider's short-lived
 * output URL.
 *
 *   GET /api/render?key=renders/...
 */

import { getObject } from "@/lib/pipeline/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "key required" }, { status: 400 });
  if (!key.startsWith("renders/")) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  try {
    const bytes = await getObject(key);
    const contentType = key.endsWith(".mp4")
      ? "video/mp4"
      : key.endsWith(".jpg")
        ? "image/jpeg"
        : "image/png";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
