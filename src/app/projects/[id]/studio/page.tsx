"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";

/**
 * The 3D Studio phase was removed from the workflow: 2D Review now hands the
 * exact plan data (room dimensions, furniture sizes + placements, door/window
 * positions) straight to the room-by-room flow, where the render prompts are
 * built from it. This route only remains so old links don't 404 — it forwards
 * to Rooms.
 */
export default function StudioRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/projects/${id}/rooms`);
  }, [id, router]);

  return (
    <div className="grid h-full place-items-center text-muted">
      <div className="flex items-center gap-2 text-sm">
        <Icon name="Loader2" className="size-4 animate-spin text-accent" />
        Taking you to Rooms…
      </div>
    </div>
  );
}
