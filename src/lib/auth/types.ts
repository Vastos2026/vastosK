/**
 * Pure type definitions, no server access — split out from session.ts
 * (which is server-only) specifically so client components (e.g.
 * components/ui/badge.tsx's UserStatusBadge, consumed by several "use
 * client" files) can import these directly without pulling a
 * server-only-guarded module into the client bundle. Same fix as
 * friendly-model-label.ts/model-labels.ts and provider-types.ts/
 * provider-settings.ts.
 */
export type UserRole = "user" | "master";
/**
 * `trial_ended` is a legacy enum value, no longer produced or checked
 * anywhere in the app (trial tracking was removed entirely per explicit
 * product decision) — kept in the Postgres enum type itself since dropping
 * an enum value is a riskier migration than just never using it again, but
 * nothing here treats it as reachable.
 */
export type UserStatus = "active" | "trial_ended" | "suspended" | "pending_approval";
