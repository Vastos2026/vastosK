import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { parsePlanJob } from "@/lib/inngest/functions";

// The pipeline spawns Python (OpenCV) and touches the filesystem → Node runtime.
export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [parsePlanJob],
});
