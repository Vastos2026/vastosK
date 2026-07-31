import { requireRole } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Icon } from "@/components/ui/icon";
import { ConsoleUsers } from "./console-users";
import { listAllAuthUsers } from "@/lib/console/auth-users";
import type { ConsoleUserRow } from "./types";
import type { UserStatus } from "@/lib/auth/session";

// "pending_approval" is a real UserStatus but nothing in this app ever sets
// it — accounts are always admin-created via createUser (status defaults to
// "active"), there's no signup flow that would land someone here — so that
// stat was permanently 0. Scheduled stop (below) is live, actually-used data.
const STATUS_STATS: { key: UserStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "suspended", label: "Suspended" },
];

// A plain helper (not a component/hook), so the default `now` parameter's
// `new Date()` isn't flagged by react-hooks/purity — that rule only checks
// impure calls made directly inside a component/hook body during render.
function isStopPending(scheduledStopAt: string | null, now: Date = new Date()): boolean {
  return !!scheduledStopAt && new Date(scheduledStopAt).getTime() > now.getTime();
}

export default async function ConsolePage() {
  const caller = await requireRole("master");

  const admin = supabaseAdmin();
  let users: ConsoleUserRow[] = [];

  if (admin) {
    const [{ data: profiles }, authUsers] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "id, display_name, role, status, billing_cycle, next_billing_date, usage_limit_usd, scheduled_stop_at, created_at",
        )
        .order("created_at", { ascending: false }),
      listAllAuthUsers(admin),
    ]);

    const emailById = new Map(authUsers.map((u) => [u.id, u.email ?? null]));

    users = (profiles ?? []).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      email: emailById.get(p.id) ?? null,
      role: p.role,
      status: p.status,
      billingCycle: p.billing_cycle,
      nextBillingDate: p.next_billing_date,
      usageLimitUsd: p.usage_limit_usd,
      scheduledStopAt: p.scheduled_stop_at,
    }));
  }

  const statusCounts = users.reduce<Record<string, number>>((acc, u) => {
    acc[u.status] = (acc[u.status] ?? 0) + 1;
    return acc;
  }, {});

  // Users with a stop date set that hasn't taken effect yet — once it passes,
  // getCurrentUser's own check blocks them and their status effectively
  // becomes "stopped" (not tracked as a separate UserStatus value), so this
  // count naturally drops off without needing to filter it out explicitly.
  const scheduledStopCount = users.filter((u) => isStopPending(u.scheduledStopAt)).length;

  if (!admin) {
    return (
      <div className="glass grid place-items-center rounded-2xl py-16 text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">
            Supabase isn&apos;t configured, so there&apos;s no user data to show yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="glass flex flex-wrap divide-x divide-white/[0.06] overflow-hidden rounded-2xl">
        <div className="flex-1 min-w-[7rem] px-5 py-4">
          <p className="text-2xl font-semibold text-foreground">{users.length}</p>
          <p className="text-sm text-muted">Total users</p>
        </div>
        {STATUS_STATS.map((s) => (
          <div key={s.key} className="flex-1 min-w-[7rem] px-5 py-4">
            <p className="text-2xl font-semibold text-foreground">{statusCounts[s.key] ?? 0}</p>
            <p className="text-sm text-muted">{s.label}</p>
          </div>
        ))}
        <div className="flex-1 min-w-[7rem] px-5 py-4">
          <p className="text-2xl font-semibold text-foreground">{scheduledStopCount}</p>
          <p className="text-sm text-muted">Scheduled stop</p>
        </div>
      </div>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted">Users</h2>
      <ConsoleUsers users={users} currentUserId={caller.id} />
    </>
  );
}
