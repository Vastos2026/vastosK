import type { UserRole, UserStatus } from "@/lib/auth/types";

export interface ConsoleUserRow {
  id: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  billingCycle: string | null;
  /** The billing anchor date — see src/lib/billing.ts's computeCurrentBillingDate for how this becomes the actually-active next billing date. */
  nextBillingDate: string | null;
  /** Total USD this user may spend on AI generation within their current
   *  billing period; null = unlimited. See checkUsageLimit (src/lib/api-guard.ts). */
  usageLimitUsd: number | null;
  /** Future date this account stops working entirely; null = no scheduled stop. */
  scheduledStopAt: string | null;
}
