"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ProviderCapability, ProviderChoice } from "@/lib/settings/provider-types";
import { friendlyModelLabel, type ModelSlugs } from "@/lib/ai/friendly-model-label";
import { switchProviderPrimary } from "./actions";

interface ModelOption {
  value: ProviderChoice;
  label: string;
  sub: string;
}

/** Built from the SAME live env-derived slugs provider.ts actually uses (see currentModelSlugs) — never a hardcoded guess, so this can't silently drift from what a generation call really runs. */
function optionsFor(runwareSlug: string, geminiSlug: string): ModelOption[] {
  return [
    { value: "runware", label: friendlyModelLabel(runwareSlug), sub: `Runware · ${runwareSlug}` },
    { value: "gemini", label: friendlyModelLabel(geminiSlug), sub: `Google · ${geminiSlug}` },
  ];
}

function OptionCard({
  option,
  active,
  disabled,
  onActivate,
}: {
  option: ModelOption;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-2 rounded-xl border p-4 transition-colors",
        active ? "border-success/40 bg-success/[0.06]" : "border-border bg-surface-2",
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">{option.label}</p>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            active ? "bg-success/15 text-success" : "bg-surface-3 text-muted",
          )}
        >
          {active && <Icon name="Check" className="size-3" />}
          {active ? "In use" : "Fallback"}
        </span>
      </div>
      <p className="text-xs text-muted">{option.sub}</p>
      {!active && (
        <button
          onClick={onActivate}
          disabled={disabled}
          className="mt-1 cursor-pointer self-start text-xs font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Make active
        </button>
      )}
    </div>
  );
}

function CapabilityCard({
  title,
  capability,
  primary,
  options,
}: {
  title: string;
  capability: ProviderCapability;
  primary: ProviderChoice;
  options: ModelOption[];
}) {
  const [current, setCurrent] = useState(primary);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const activate = (value: ProviderChoice) => {
    setError(null);
    const previous = current;
    setCurrent(value); // optimistic — matches the "immediate" switch requirement
    startTransition(async () => {
      try {
        await switchProviderPrimary(capability, value);
      } catch (e) {
        setCurrent(previous);
        setError(e instanceof Error ? e.message : "Failed to switch model");
      }
    });
  };

  return (
    <div className="glass rounded-2xl p-5">
      <p className="mb-3 text-sm font-medium text-foreground">{title}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            option={opt}
            active={opt.value === current}
            disabled={pending}
            onActivate={() => activate(opt.value)}
          />
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function VideoCard({ slug }: { slug: string }) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="mb-3 text-sm font-medium text-foreground">Video</p>
      <div className="flex flex-1 flex-col gap-2 rounded-xl border border-success/40 bg-success/[0.06] p-4 sm:max-w-xs">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">{friendlyModelLabel(slug)}</p>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
            <Icon name="Check" className="size-3" />
            Active
          </span>
        </div>
        <p className="text-xs text-muted">Runware · {slug} — the only supported video model</p>
      </div>
    </div>
  );
}

export function ModelSwitcher({
  imageGenPrimary,
  imageEditPrimary,
  slugs,
}: {
  imageGenPrimary: ProviderChoice;
  imageEditPrimary: ProviderChoice;
  slugs: ModelSlugs;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <CapabilityCard
        title="Image Generation"
        capability="image_gen"
        primary={imageGenPrimary}
        options={optionsFor(slugs.imageGen.runware, slugs.imageGen.gemini)}
      />
      <CapabilityCard
        title="Image Editing"
        capability="image_edit"
        primary={imageEditPrimary}
        options={optionsFor(slugs.imageEdit.runware, slugs.imageEdit.gemini)}
      />
      <VideoCard slug={slugs.video.runware} />
    </div>
  );
}
