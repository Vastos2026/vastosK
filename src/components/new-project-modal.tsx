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
  /** Skip re-asking the property type — the welcome screen's category cards
   *  already collected it; re-showing the same picker one screen later was
   *  a redundant step. A "Change" link still reveals it if needed. */
  lockType = false,
}: {
  open: boolean;
  onClose: () => void;
  initialType?: PropertyType;
  lockType?: boolean;
}) {
  const router = useRouter();
  const projects = useVasto((s) => s.projects);
  const createProject = useVasto((s) => s.createProject);
  const [name, setName] = useState("");
  // No silent default when the picker is shown unprompted (lockType false,
  // e.g. the Projects page's "+ New Project" button): pre-selecting
  // "apartment" here meant a user who typed a name and hit Create without
  // explicitly clicking a property-type card got an Apartment project while
  // believing they'd chosen whichever card they'd looked at — found in
  // review after a report of "I picked Residential Home but got 1BHK/2BHK
  // options". When lockType is true (the welcome screen's category cards),
  // initialType IS the user's own explicit prior click, so pre-filling it
  // here is correct, not a silent default.
  const [type, setType] = useState<PropertyType | null>(lockType ? initialType : null);
  const [showPicker, setShowPicker] = useState(!lockType);
  const chosen = type ? PROPERTY_TYPES.find((p) => p.id === type) : undefined;

  const trimmedName = name.trim();
  const isDuplicate =
    trimmedName.length > 0 &&
    projects.some((p) => p.name.trim().toLowerCase() === trimmedName.toLowerCase());

  const submit = () => {
    if (!trimmedName || isDuplicate || !type) return;
    const id = createProject(trimmedName, type);
    onClose();
    setName("");
    setType(lockType ? initialType : null);
    setShowPicker(!lockType);
    router.push(`/projects/${id}/floor-plan`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description={lockType ? "Name your project to get started." : "Name your project and choose a property type to get started."}
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
            className={cn(
              "w-full rounded-lg border bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint",
              isDuplicate
                ? "border-danger/60 focus:border-danger focus:ring-2 focus:ring-danger/20"
                : "border-border focus:border-accent/60 focus:ring-2 focus:ring-accent/20",
            )}
          />
          {isDuplicate && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-danger">
              <Icon name="CircleAlert" className="size-3.5 shrink-0" />
              You already have a project named &quot;{trimmedName}&quot;. Choose a different name.
            </p>
          )}
        </div>

        {!showPicker && chosen ? (
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 p-3">
            <span className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/20 text-accent">
                <Icon name={chosen.icon} className="size-[18px]" />
              </span>
              <span>
                <span className="block text-sm font-medium">{chosen.label}</span>
                <span className="block text-xs text-muted">{chosen.description}</span>
              </span>
            </span>
            <button
              onClick={() => setShowPicker(true)}
              className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline cursor-pointer"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Property type</label>
            <div className="grid grid-cols-2 gap-2.5">
              {PROPERTY_TYPES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setType(p.id)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer hover:-translate-y-0.5",
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
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} iconRight="ArrowRight" disabled={!trimmedName || isDuplicate || !type}>
          Create project
        </Button>
      </div>
    </Modal>
  );
}
