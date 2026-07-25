import { requireUser } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { ProfileProjects } from "@/components/profile-projects";

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function trialLabel(status: string, trialEndsAt: string | null): string | null {
  if (status === "suspended") return "Account suspended";
  if (status === "pending_approval") return "Pending approval";
  if (status === "trial_ended") return "Trial ended";
  if (!trialEndsAt) return null;
  const days = Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "Trial ended";
  if (days === 0) return "Trial ends today";
  return `Trial ends in ${days} day${days === 1 ? "" : "s"}`;
}

export default async function ProfilePage() {
  const user = await requireUser();
  const trial = trialLabel(user.status, user.trialEndsAt);

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
              {trial && (
                <p className="mt-1.5 inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs text-muted">
                  {trial}
                </p>
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
