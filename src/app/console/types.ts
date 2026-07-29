import type { UserRole, UserStatus } from "@/lib/auth/session";

export interface ConsoleUserRow {
  id: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  trialEndsAt: string | null;
  billingCycle: string | null;
  nextBillingDate: string | null;
  /** Total USD this user may spend on AI generation within their current
   *  billing period; null = unlimited. See checkUsageLimit (src/lib/api-guard.ts). */
  usageLimitUsd: number | null;
}
