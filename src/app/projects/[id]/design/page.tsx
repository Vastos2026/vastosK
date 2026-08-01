"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { STYLES, LUXURY_LEVELS, COLOUR_PALETTES } from "@/lib/data";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { runDesignPlan, generateRoomImage } from "@/lib/design-plan-client";
import { ensureGreyboxKey } from "@/lib/greybox/ensure-greybox-key";
import type { LuxuryLevel } from "@/lib/ai/prompting/types";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, uid } from "@/lib/utils";

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
  const [customColors, setCustomColors] = useState<string[]>(
    project?.customColourHexes ?? ["#ffffff", "#ffffff", "#ffffff"],
  );
  const [additionalRequirements, setAdditionalRequirements] = useState(
    project?.additionalRequirements ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rooms = useMemo(() => project?.floorPlan?.rooms ?? [], [project?.floorPlan?.rooms]);
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0];
  // "Choose custom color" sends the literal hex codes the user picked to the
  // model as a list, instead of one of the preset labels — COLOUR_PALETTES
  // has no entry for it.
  const isCustomPalette = colourPalette === "custom";

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
    const palette = COLOUR_PALETTES.find((c) => c.id === colourPalette) ?? COLOUR_PALETTES[0];
    const colourPaletteText = isCustomPalette
      ? `Custom (${customColors.join(", ")})`
      : `${palette.label} (${palette.description})`;
    // Fingerprints exactly the design selections that affect a room's
    // generated image. Compared against the project's last-saved signature
    // below to decide whether a room that already has an image should keep
    // it (nothing that would change its render actually changed) or get
    // regenerated (the design itself changed, not just the room list).
    const signature = JSON.stringify({
      subcategory,
      styleId,
      luxuryLevel,
      colourPalette,
      customColors: isCustomPalette ? customColors : undefined,
      notes: additionalRequirements.trim(),
    });
    const signatureUnchanged = project.designSignature === signature;
    setBusy(true);
    setError(null);
    try {
      const { universalInput, designSpec } = await runDesignPlan({
        projectId: id,
        category,
        subcategory,
        rooms: rooms.map((r) => ({
          name: r.name,
          type: r.type,
          widthFt: r.width,
          heightFt: r.height,
          // One global note (not per-room) — the Design Planning Layer decides
          // which room(s) it actually applies to, so the same text is handed
          // to every room rather than making the user pre-sort it.
          additionalNotes: additionalRequirements.trim() || undefined,
          openings: r.openings,
        })),
        design: {
          style: style.name,
          luxuryLevel,
          colourPalette: colourPaletteText,
        },
      });
      setDesignPlan(id, {
        subcategory,
        luxuryLevel,
        colourPalette,
        customColourHexes: isCustomPalette ? customColors : undefined,
        additionalRequirements: additionalRequirements.trim() || undefined,
        universalInput,
        designSpec,
        designSignature: signature,
      });
      useVasto.getState().setStyle(id, styleId);
      useVasto.getState().setStatus(id, "designing");

      // Fire every room's first image generation now, in parallel, so it's
      // already in flight before the user even sees the Generate page — not
      // awaited: the Generate page (rebuilt in a later task) reads progress
      // from the store (generatingRoomIds + roomCards), not from this promise.
      // Rooms that already have a generation are skipped when nothing about
      // the design actually changed (signatureUnchanged) — re-confirming
      // Design after only adding a new room shouldn't silently replace every
      // other room's already-approved-looking image.
      for (const room of rooms) {
        const existingCard = project.roomCards.find((c) => c.roomId === room.id);
        if (signatureUnchanged && (existingCard?.generations.length ?? 0) > 0) continue;

        useVasto.getState().startGenerating(id, room.id);
        // Omit size entirely when a dimension is still missing, rather than
        // sending a literal "undefined x undefined ft" into the render
        // prompt — see Room.width/height's doc comment. Same helper
        // buildUniversalInput uses, so this payload and the Design Planning
        // call describe a room's size identically.
        const size = formatRoomSize(room.width, room.height);
        // An async IIFE, not awaited by this loop (rooms still generate in
        // parallel, matching the .then/.catch/.finally chain this replaces)
        // — it just needs its OWN await for the greybox render/upload step
        // to finish before the actual generation call for that one room.
        (async () => {
          try {
            const greyboxKey = await ensureGreyboxKey(id, room).catch((e) => {
              console.warn(
                `[generate] greybox render/upload failed for "${room.name}", falling back to text-only:`,
                e instanceof Error ? e.message : e,
              );
              return undefined;
            });
            if (greyboxKey && greyboxKey !== room.greyboxKey) {
              useVasto.getState().updateRoom(id, room.id, { greyboxKey });
            }
            const gen = await generateRoomImage({
              projectId: id,
              universalInput,
              room: {
                name: room.name,
                type: room.type,
                ...(size ? { size } : {}),
                additional_notes: universalInput.layout.rooms.find((r) => r.name === room.name)?.additional_notes,
                openings: room.openings,
              },
              designSpec,
              greyboxKey,
            });
            useVasto.getState().addGeneration(id, room.id, {
              id: uid("gen"),
              createdAt: new Date().toISOString(),
              imageUrl: gen.imageUrl,
              imageKey: gen.key,
              prompt: gen.prompt,
            });
          } catch (e) {
            console.warn(`[generate] room "${room.name}" failed:`, e instanceof Error ? e.message : e);
          } finally {
            useVasto.getState().stopGenerating(id, room.id);
          }
        })();
      }

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
            Chosen once, applied to every room. {rooms.length} room{rooms.length === 1 ? "" : "s"} confirmed.
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
                  "cursor-pointer rounded-2xl border p-3.5 text-left transition-colors",
                  s.id === styleId
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <p className="text-sm font-medium">{s.name}</p>
                <p className="mt-0.5 text-xs text-muted">{s.tagline}</p>
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
                  "group cursor-pointer overflow-hidden rounded-2xl border text-left transition-colors",
                  c.id === colourPalette
                    ? "border-accent/60 bg-accent/5"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <div className="flex h-10 overflow-hidden">
                  {c.swatch.map((sw, i) => (
                    <div key={i} className="flex-1" style={{ background: sw }} />
                  ))}
                </div>
                <div className="p-3">
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">{c.description}</p>
                </div>
              </button>
            ))}

            <button
              onClick={() => setColourPalette("custom")}
              className={cn(
                "group cursor-pointer overflow-hidden rounded-2xl border text-left transition-colors",
                isCustomPalette
                  ? "border-accent/60 bg-accent/5"
                  : "border-border bg-surface hover:border-border-strong",
              )}
            >
              <div className="flex h-10 overflow-hidden">
                {customColors.map((hex, i) => (
                  <div key={i} className="flex-1" style={{ background: hex }} />
                ))}
              </div>
              <div className="p-3">
                <p className="text-sm font-medium">Choose custom color</p>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted">Pick your own 3-colour palette</p>
              </div>
            </button>
          </div>

          {isCustomPalette && (
            <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3.5">
              <p className="text-xs text-muted">Pick 3 colours:</p>
              {customColors.map((hex, i) => (
                <label
                  key={i}
                  className="relative size-10 cursor-pointer overflow-hidden rounded-lg border border-border-strong"
                  style={{ background: hex }}
                >
                  <input
                    type="color"
                    value={hex}
                    onChange={(e) =>
                      setCustomColors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))
                    }
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    aria-label={`Custom colour ${i + 1}`}
                  />
                </label>
              ))}
              <p className="ml-auto text-xs font-mono text-faint">{customColors.join(" · ")}</p>
            </div>
          )}
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
            One note for the whole project. No need to say which room it&apos;s for.
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
          <Button icon="Wand2" iconRight="ArrowRight" onClick={confirm} loading={busy} disabled={busy}>
            {busy ? "Planning the design…" : "Confirm & plan design"}
          </Button>
        </div>
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
