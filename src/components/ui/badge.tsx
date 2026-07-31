import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import type { ProjectStatus, RenderStatus } from "@/lib/types";
import type { UserStatus } from "@/lib/auth/types";

export function Badge({
  children,
  className,
  icon,
  dot,
}: {
  children: React.ReactNode;
  className?: string;
  icon?: string;
  dot?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted",
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      {icon && <Icon name={icon} className="size-3" />}
      {children}
    </span>
  );
}

interface StatusEntry {
  label: string;
  cls: string;
  icon: string;
}

/** Shared pill markup for every enum-keyed status badge below — one place to change the look of all of them. */
function StatusPill({ entry, spin }: { entry: StatusEntry; spin?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        entry.cls,
      )}
    >
      <Icon name={entry.icon} className={cn("size-3", spin && "animate-spin")} />
      {entry.label}
    </span>
  );
}

const PROJECT_STATUS: Record<ProjectStatus, StatusEntry> = {
  draft: { label: "Draft", cls: "text-faint border-border", icon: "CircleDashed" },
  parsing: { label: "Parsing", cls: "text-info border-info/30 bg-info/10", icon: "Loader2" },
  parsed: { label: "Parsed", cls: "text-info border-info/30 bg-info/10", icon: "CircleCheck" },
  designing: { label: "Designing", cls: "text-accent border-accent/30 bg-accent/10", icon: "Wand2" },
  rendered: { label: "Rendered", cls: "text-success border-success/30 bg-success/10", icon: "CircleCheck" },
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return <StatusPill entry={PROJECT_STATUS[status]} spin={status === "parsing"} />;
}

const RENDER_STATUS: Record<RenderStatus, StatusEntry> = {
  queued: { label: "Queued", cls: "text-muted border-border bg-surface-2", icon: "Clock" },
  processing: { label: "Processing", cls: "text-info border-info/30 bg-info/10", icon: "Loader2" },
  completed: { label: "Completed", cls: "text-success border-success/30 bg-success/10", icon: "CircleCheck" },
  failed: { label: "Failed", cls: "text-danger border-danger/30 bg-danger/10", icon: "CircleAlert" },
};

export function RenderStatusBadge({ status }: { status: RenderStatus }) {
  return <StatusPill entry={RENDER_STATUS[status]} spin={status === "processing"} />;
}

const USER_STATUS: Record<UserStatus, StatusEntry> = {
  active: { label: "Active", cls: "text-success border-success/30 bg-success/10", icon: "CircleCheck" },
  trial_ended: { label: "Trial ended", cls: "text-warning border-warning/30 bg-warning/10", icon: "Clock" },
  suspended: { label: "Suspended", cls: "text-danger border-danger/30 bg-danger/10", icon: "CircleAlert" },
  pending_approval: { label: "Pending approval", cls: "text-muted border-border bg-surface-2", icon: "CircleDashed" },
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <StatusPill entry={USER_STATUS[status]} />;
}
