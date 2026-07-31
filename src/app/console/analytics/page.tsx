import { requireRole } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { Icon } from "@/components/ui/icon";
import { listAllAuthUsers } from "@/lib/console/auth-users";
import { getConsoleUsageAnalytics } from "@/lib/console/usage-analytics";
import { getProviderPrimary } from "@/lib/settings/provider-settings";
import { currentModelSlugs } from "@/lib/ai/model-labels";
import { AnalyticsDashboard } from "./analytics-dashboard";
import { ModelSwitcher } from "./model-switcher";

export default async function ConsoleAnalyticsPage() {
  await requireRole("master");

  const admin = supabaseAdmin();
  if (!admin) {
    return (
      <div className="glass grid place-items-center rounded-2xl py-16 text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">
            Supabase isn&apos;t configured, so there&apos;s no usage data to show yet.
          </p>
        </div>
      </div>
    );
  }

  const [{ data: profileRows }, authUsers, imageGenPrimary, imageEditPrimary] = await Promise.all([
    admin.from("profiles").select("id, display_name"),
    listAllAuthUsers(admin),
    getProviderPrimary("image_gen"),
    getProviderPrimary("image_edit"),
  ]);

  const emailById = new Map(authUsers.map((u) => [u.id, u.email ?? null]));
  const profiles = (profileRows ?? []).map((p) => ({
    id: p.id as string,
    displayName: p.display_name as string | null,
    email: emailById.get(p.id as string) ?? null,
  }));

  const analytics = await getConsoleUsageAnalytics(admin, profiles);
  const slugs = currentModelSlugs();

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Models</h2>
        <ModelSwitcher
          imageGenPrimary={imageGenPrimary}
          imageEditPrimary={imageEditPrimary}
          slugs={slugs}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Usage</h2>
        {analytics ? (
          <AnalyticsDashboard analytics={analytics} />
        ) : (
          <div className="glass grid place-items-center rounded-2xl py-16 text-center">
            <div>
              <Icon name="BarChart3" className="mx-auto size-8 text-faint" />
              <p className="mt-3 text-sm text-muted">No usage data yet.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
