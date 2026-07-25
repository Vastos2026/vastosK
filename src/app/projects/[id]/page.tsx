"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVasto, useHydrated } from "@/lib/store";
import { resumePhase } from "@/lib/nav";

export default function ProjectIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const hydrated = useHydrated();
  const project = useVasto((s) => s.projects.find((p) => p.id === id));

  useEffect(() => {
    if (!hydrated) return;
    if (project) router.replace(`/projects/${id}/${resumePhase(project)}`);
    else router.replace("/");
  }, [hydrated, project, id, router]);

  return null;
}
