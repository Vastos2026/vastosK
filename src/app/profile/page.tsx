import { requireUser } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { ProfileProjects } from "@/components/profile-projects";
import { computeCurrentBillingDate, isBillingCycle } from "@/lib/billing";

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * "Your next billing date is on {date}" reminder — `nextBillingDate` on the
 * profile is just the original anchor an admin set once; this rolls it
 * forward (computeCurrentBillingDate, src/lib/billing.ts) so the date shown
 * here is always the genuinely upcoming one, never a stale one an admin
 * forgot to update.
 */
function billingLabel(billingCycle: string | null, nextBillingDate: string | null): string | null {
  if (!nextBillingDate || !billingCycle || !isBillingCycle(billingCycle)) return null;
  const current = computeCurrentBillingDate(nextBillingDate, billingCycle);
  const formatted = current.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `Your next billing date is on ${formatted}`;
}

export default async function ProfilePage() {
  const user = await requireUser();
  const billing = billingLabel(user.billingCycle, user.nextBillingDate);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/5 px-8 py-5">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted">Your account and past projects.</p>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        <div className="glass flex flex-col gap-5 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              <span
                aria-hidden
                className="absolute -inset-1 rounded-full opacity-70 blur-md"
                style={{ background: "radial-gradient(circle, rgba(31,140,100,0.35), transparent 70%)" }}
              />
              <div className="relative grid size-14 place-items-center rounded-full bg-foreground text-lg font-semibold text-bg">
                {initials(user.displayName, user.email)}
              </div>
            </div>
            <div>
              <p className="text-lg font-medium text-foreground">{user.displayName || "Your account"}</p>
              {user.email && (
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  <Icon name="Mail" className="size-3.5" />
                  {user.email}
                </p>
              )}
              {billing && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs text-muted">
                    {billing}
                  </span>
                </div>
              )}
            </div>
          </div>
          <form action={signOut}>
            <Button type="submit" variant="secondary" icon="LogOut">
              Sign out
            </Button>
          </form>
        </div>

        <ProfileProjects />
      </div>
    </div>
  );
}
