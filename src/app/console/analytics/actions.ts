"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { setProviderPrimary, type ProviderCapability, type ProviderChoice } from "@/lib/settings/provider-settings";

/**
 * Independently re-checks requireRole, same defense-in-depth pattern as every
 * other console Server Action (src/app/console/actions.ts) — this isn't
 * called from that file to avoid a cross-directory import cycle risk, but
 * follows the identical convention.
 */
export async function switchProviderPrimary(capability: ProviderCapability, value: ProviderChoice) {
  const caller = await requireRole("master");
  await setProviderPrimary(capability, value, caller.id);
  revalidatePath("/console/analytics");
}
