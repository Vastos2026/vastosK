"use client";

import { useState } from "react";
import { useVasto } from "@/lib/store";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

/** Shared by the Profile and Projects pages — clears every local project (and,
 *  via the existing ProjectSync subscriber, every synced Supabase snapshot too). */
export function DeleteAllProjectsButton({ count }: { count: number }) {
  const clearAllProjects = useVasto((s) => s.clearAllProjects);
  const [open, setOpen] = useState(false);

  if (count === 0) return null;

  return (
    <>
      <Button variant="danger" size="sm" icon="Trash2" onClick={() => setOpen(true)}>
        Delete all projects
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete all projects?"
        description={`This permanently deletes all ${count} project${count === 1 ? "" : "s"} — floor plans, designs, and every generated image and video. This can't be undone.`}
      >
        <div className="flex items-center justify-end gap-2 px-6 py-5">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon="Trash2"
            onClick={() => {
              clearAllProjects();
              setOpen(false);
            }}
          >
            Delete all {count} project{count === 1 ? "" : "s"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
