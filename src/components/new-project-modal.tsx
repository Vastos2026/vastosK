"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { PROPERTY_TYPES } from "@/lib/data";
import { useVasto } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { PropertyType } from "@/lib/types";

export function NewProjectModal({
  open,
  onClose,
  initialType = "apartment",
}: {
  open: boolean;
  onClose: () => void;
  initialType?: PropertyType;
}) {
  const router = useRouter();
  const createProject = useVasto((s) => s.createProject);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>(initialType);

  const submit = () => {
    const id = createProject(name.trim() || "Untitled Project", type);
    onClose();
    setName("");
    setType(initialType);
    router.push(`/projects/${id}/upload`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="Name your project and choose a property type to get started."
    >
      <div className="space-y-5 px-6 py-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Project name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Prestige Lakeside Villa"
            className="w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-foreground">Property type</label>
          <div className="grid grid-cols-2 gap-2.5">
            {PROPERTY_TYPES.map((p) => (
              <button
                key={p.id}
                onClick={() => setType(p.id)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors cursor-pointer",
                  type === p.id
                    ? "border-accent/60 bg-accent/10"
                    : "border-border bg-surface-2 hover:border-border-strong",
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-lg",
                    type === p.id ? "bg-accent/20 text-accent" : "bg-surface-3 text-muted",
                  )}
                >
                  <Icon name={p.icon} className="size-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{p.label}</span>
                  <span className="block truncate text-xs text-muted">{p.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} iconRight="ArrowRight">
          Create project
        </Button>
      </div>
    </Modal>
  );
}
