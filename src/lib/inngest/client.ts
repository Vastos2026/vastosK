import { Inngest } from "inngest";

/** Inngest client — the orchestration layer ("Inngest Job Trigger" box). */
export const inngest = new Inngest({ id: "vasto-studios" });

/** Data carried by the `plan/uploaded` event that kicks off the pipeline. */
export interface PlanUploadedData {
  jobId: string;
  storageKey: string;
  storageBackend: "s3" | "local";
  fileName: string;
  mimeType: string;
  scale?: number;
  longestSideFt?: number;
}
