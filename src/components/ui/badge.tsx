import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import type { ProjectStatus, RenderStatus } from "@/lib/types";

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

const PROJECT_STATUS: Record<ProjectStatus, { label: string; cls: string; icon: string }> = {
  draft: { label: "Draft", cls: "text-faint border-border", icon: "CircleDashed" },
  parsing: { label: "Parsing", cls: "text-info border-info/30 bg-info/10", icon: "Loader2" },
  parsed: { label: "Parsed", cls: "text-info border-info/30 bg-info/10", icon: "CircleCheck" },
  designing: { label: "Designing", cls: "text-accent border-accent/30 bg-accent/10", icon: "Wand2" },
  rendered: { label: "Rendered", cls: "text-success border-success/30 bg-success/10", icon: "Sparkles" },
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const s = PROJECT_STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.cls,
      )}
    >
      <Icon name={s.icon} className={cn("size-3", status === "parsing" && "animate-spin")} />
      {s.label}
    </span>
  );
}

const RENDER_STATUS: Record<RenderStatus, { label: string; cls: string; icon: string }> = {
  queued: { label: "Queued", cls: "text-muted border-border bg-surface-2", icon: "Clock" },
  processing: { label: "Processing", cls: "text-info border-info/30 bg-info/10", icon: "Loader2" },
  completed: { label: "Completed", cls: "text-success border-success/30 bg-success/10", icon: "CircleCheck" },
  failed: { label: "Failed", cls: "text-danger border-danger/30 bg-danger/10", icon: "CircleAlert" },
};

export function RenderStatusBadge({ status }: { status: RenderStatus }) {
  const s = RENDER_STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.cls,
      )}
    >
      <Icon name={s.icon} className={cn("size-3", status === "processing" && "animate-spin")} />
      {s.label}
    </span>
  );
}
