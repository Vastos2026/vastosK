import { WorkspaceFrame } from "@/components/project/workspace-frame";

// Project ids are created at runtime (client-side store), so these routes can't
// be statically prerendered from a known param list. Force request-time
// rendering so any `/projects/[id]/*` resolves instead of 404-ing as an
// unknown static param.
export const dynamic = "force-dynamic";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceFrame>{children}</WorkspaceFrame>;
}
