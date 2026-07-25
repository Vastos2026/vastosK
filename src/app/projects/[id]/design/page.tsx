"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { STYLES, LUXURY_LEVELS, COLOUR_PALETTES } from "@/lib/data";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { runDesignPlan } from "@/lib/design-plan-client";
import type { LuxuryLevel } from "@/lib/ai/prompting/types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Design step (revamp Workstream 8, plan flow step 5/5a) — the ONE global
 * design screen: style, luxury level, colour palette, applied to every room.
 * Confirming here runs the Design Planning Layer once (5a) and caches its
 * Design Specification on the project, so every room's generation prompt
 * (Rooms → Render) is built from the same shared design language.
 */
export default function DesignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setDesignPlan = useVasto((s) => s.setDesignPlan);

  const category = project ? categoryForPropertyType(project.propertyType) : "Residential";
  const config = getProjectTypeConfig(category);

  const [styleId, setStyleId] = useState(project?.styleId ?? STYLES[0].id);
  const [subcategory, setSubcategory] = useState(
    project?.subcategory ?? config?.subcategories[0] ?? "",
  );
  const [luxuryLevel, setLuxuryLevel] = useState<LuxuryLevel>(project?.luxuryLevel ?? "Premium");
  const [colourPalette, setColourPalette] = useState(project?.colourPalette ?? COLOUR_PALETTES[0].id);
  const [additionalRequirements, setAdditionalRequirements] = useState(
    project?.additionalRequirements ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rooms = useMemo(() => project?.floorPlan?.rooms ?? [], [project?.floorPlan?.rooms]);
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0];

  if (!project) return null;

  if (!project.floorPlan || rooms.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="Palette" className="mx-auto size-8 text-faint" />
          <p className="mt-3 text-sm text-muted">Confirm your rooms in 2D Review first.</p>
          <Link href={`/projects/${id}/review`}>
            <Button className="mt-4" variant="outline" icon="Ruler">Go to 2D Review</Button>
          </Link>
        </div>
      </div>
    );
  }

  const confirm = async () => {
    if (busy) return;
    if (!subcategory.trim()) {
      setError("Choose or enter a project subcategory.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { universalInput, designSpec } = await runDesignPlan({
        projectId: id,
        category,
        subcategory,
        rooms: rooms.map((r) => ({
          name: r.name,
          widthFt: r.width,
          heightFt: r.height,
          // One global note (not per-room) — the Design Planning Layer decides
          // which room(s) it actually applies to, so the same text is handed
          // to every room rather than making the user pre-sort it.
          additionalNotes: additionalRequirements.trim() || undefined,
          openings: r.openings,
        })),
        design: { style: style.name, luxuryLevel, colourPalette },
      });
      setDesignPlan(id, {
        subcategory,
        luxuryLevel,
        colourPalette,
        additionalRequirements: additionalRequirements.trim() || undefined,
        universalInput,
        designSpec,
      });
      useVasto.getState().setStyle(id, styleId);
      useVasto.getState().setStatus(id, "designing");
      router.push(`/projects/${id}/generate`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Design planning failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold tracking-tight">Design</h2>
          <p className="mt-1 text-sm text-muted">
            Chosen once, applied to every room — {rooms.length} room{rooms.length === 1 ? "" : "s"} confirmed.
          </p>
        </div>

        {config && config.subcategories.length > 0 ? (
          <Section title="Project type">
            <div className="flex flex-wrap gap-2">
              {config.subcategories.map((sc) => (
                <button
                  key={sc}
                  onClick={() => setSubcategory(sc)}
                  className={cn(
                    "cursor-pointer rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                    subcategory === sc
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-border bg-surface text-muted hover:border-border-strong",
                  )}
                >
                  {sc}
                </button>
              ))}
            </div>
          </Section>
        ) : (
          <Section title="Project type">
            <input
              value={subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
              placeholder="e.g. Dental Clinic, Restaurant, Lighthouse"
              className="input w-full max-w-sm"
            />
          </Section>
        )}

        <Section title="Style">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => setStyleId(s.id)}
                className={cn(
                  "group cursor-pointer overflow-hidden rounded-2xl border text-left transition-colors",
                  s.id === styleId
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <div className="flex h-10 overflow-hidden">
                  {s.palette.map((c, i) => (
                    <div key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
                <div className="p-3">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{s.tagline}</p>
                </div>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Luxury level">
          <div className="grid gap-3 sm:grid-cols-3">
            {LUXURY_LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => setLuxuryLevel(l.id)}
                className={cn(
                  "cursor-pointer rounded-2xl border p-3.5 text-left transition-colors",
                  luxuryLevel === l.id
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <p className="text-sm font-medium">{l.label}</p>
                <p className="mt-0.5 text-xs text-muted">{l.tagline}</p>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Colour palette">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {COLOUR_PALETTES.map((c) => (
              <button
                key={c.id}
                onClick={() => setColourPalette(c.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-2xl border p-3 text-left transition-colors",
                  colourPalette === c.id
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <div className="flex h-7 w-10 shrink-0 overflow-hidden rounded-lg">
                  {c.swatch.map((sw, i) => (
                    <div key={i} className="flex-1" style={{ background: sw }} />
                  ))}
                </div>
                <span className="text-sm font-medium">{c.label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Additional requirements">
          <textarea
            value={additionalRequirements}
            onChange={(e) => setAdditionalRequirements(e.target.value)}
            rows={3}
            placeholder={`"I want a double-height living room." "Include a pooja space." "Wooden ceiling."`}
            className="input w-full resize-none text-sm"
          />
          <p className="mt-1.5 text-[11px] text-faint">
            One note for the whole project — no need to say which room it&apos;s for.
          </p>
        </Section>

        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <Link href={`/projects/${id}/review`}>
            <Button variant="ghost" icon="ArrowLeft">Back to review</Button>
          </Link>
          <Button icon="Sparkles" iconRight="ArrowRight" onClick={confirm} loading={busy} disabled={busy}>
            {busy ? "Planning the design…" : "Confirm & plan design"}
          </Button>
        </div>
        <p className="mt-2 text-right text-[11px] text-faint">
          Runs one AI call to plan a consistent design language for every room.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted">{title}</p>
      {children}
    </div>
  );
}
