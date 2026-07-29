import type { SupabaseClient, User } from "@supabase/supabase-js";
import { requireRole } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Icon } from "@/components/ui/icon";
import { ConsoleUsers } from "./console-users";
import { ConsoleUsageChart, type ConsoleUserRenderSeries } from "./console-usage-chart";
import { getConsoleRenderStats } from "@/lib/console/render-stats";
import type { ConsoleUserRow } from "./types";
import type { UserStatus } from "@/lib/auth/session";

const AUTH_USERS_PAGE_SIZE = 1000;
const MAX_AUTH_USER_PAGES = 20; // 20,000 users — a generous cap against a runaway loop, not a real expected ceiling

/**
 * `listUsers` is paginated (default/max page size varies by Supabase version)
 * — a single unpaginated call silently truncates the console's user list and
 * "Total users" count past the first page. Fetches every page instead,
 * stopping as soon as a page comes back short (the last page).
 */
async function listAllAuthUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; page <= MAX_AUTH_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: AUTH_USERS_PAGE_SIZE });
    if (error) {
      console.warn("[console] listUsers failed (non-fatal):", error.message);
      break;
    }
    users.push(...data.users);
    if (data.users.length < AUTH_USERS_PAGE_SIZE) break;
    if (page === MAX_AUTH_USER_PAGES) {
      console.warn(`[console] hit the ${MAX_AUTH_USER_PAGES}-page safety cap — some users may be missing`);
    }
  }
  return users;
}

const STATUS_STATS: { key: UserStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "trial_ended", label: "Trial ended" },
  { key: "suspended", label: "Suspended" },
  { key: "pending_approval", label: "Pending approval" },
];

export default async function ConsolePage() {
  const caller = await requireRole("master");

  const admin = supabaseAdmin();
  let users: ConsoleUserRow[] = [];
  let renderStats: Awaited<ReturnType<typeof getConsoleRenderStats>> = null;

  if (admin) {
    const [{ data: profiles }, authUsers, stats] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "id, display_name, role, status, trial_ends_at, billing_cycle, next_billing_date, usage_limit_usd, created_at",
        )
        .order("created_at", { ascending: false }),
      listAllAuthUsers(admin),
      getConsoleRenderStats(admin),
    ]);

    renderStats = stats;
    const emailById = new Map(authUsers.map((u) => [u.id, u.email ?? null]));

    users = (profiles ?? []).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      email: emailById.get(p.id) ?? null,
      role: p.role,
      status: p.status,
      trialEndsAt: p.trial_ends_at,
      billingCycle: p.billing_cycle,
      nextBillingDate: p.next_billing_date,
      usageLimitUsd: p.usage_limit_usd,
    }));
  }

  const renderSeries: ConsoleUserRenderSeries[] = renderStats
    ? users.map((u) => {
        const stats = renderStats!.byUser.get(u.id);
        return {
          userId: u.id,
          displayName: u.displayName,
          email: u.email,
          months: stats?.months ?? renderStats!.monthKeys.map((month) => ({ month, count: 0 })),
          total: stats?.total ?? 0,
        };
      })
    : [];

  const statusCounts = users.reduce<Record<string, number>>((acc, u) => {
    acc[u.status] = (acc[u.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/5 px-8 py-5">
        <h1 className="text-xl font-semibold tracking-tight">Console</h1>
        <p className="text-sm text-muted">Manage client accounts, billing, and access.</p>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        {!admin ? (
          <div className="glass grid place-items-center rounded-2xl py-16 text-center">
            <div>
              <Icon name="CircleAlert" className="mx-auto size-8 text-faint" />
              <p className="mt-3 text-sm text-muted">
                Supabase isn&apos;t configured, so there&apos;s no user data to show yet.
              </p>
            </div>
          </div>
        ) : (
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
            </div>

            <h2 className="mt-8 mb-3 text-sm font-medium text-muted">Users</h2>
            <ConsoleUsers users={users} currentUserId={caller.id} />

            <h2 className="mt-8 mb-3 text-sm font-medium text-muted">Analytics</h2>
            <ConsoleUsageChart series={renderSeries} monthKeys={renderStats?.monthKeys ?? []} />
          </>
        )}
      </div>
    </div>
  );
}
