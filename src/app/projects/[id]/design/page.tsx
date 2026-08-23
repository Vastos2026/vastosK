"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto, useHydrated } from "@/lib/store";
import { STYLES, LUXURY_LEVELS, COLOUR_PALETTES, buildCustomPaletteText } from "@/lib/data";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { runDesignPlan, generateRoomImage, analyseDesignReferenceViaApi } from "@/lib/design-plan-client";
import type { LuxuryLevel } from "@/lib/ai/prompting/types";
import type { DesignReference } from "@/lib/types";
import { formatRoomSize } from "@/lib/ai/prompting/build-universal-input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, uid } from "@/lib/utils";
import { roomSpecFor } from "@/lib/greybox/room-spec";

/**
 * Design step (revamp Workstream 8, plan flow step 5/5a) — the ONE global
 * design screen: style, luxury level, colour palette, applied to every room.
 * Confirming here runs the Design Planning Layer once (5a) and caches its
 * Design Specification on the project, so every room's generation prompt
 * (Rooms → Render) is built from the same shared design language.
 */

/**
 * Hydration gate — the same split plan/page.tsx uses, and for a worse version
 * of the same reason.
 *
 * The persisted store only finishes hydrating from localStorage AFTER the
 * first render. DesignPageContent below seeds SEVEN pieces of local state
 * from `project` through useState initializers (style, subcategory, luxury
 * level, palette, custom colours, additional requirements and the design
 * reference), and a useState argument is evaluated exactly once, ever. So on
 * the first paint every one of them latched to its default, and the
 * `if (!project) return null` inside did NOT save it: returning null does not
 * unmount the component, so those defaults survived into the render where the
 * real project finally arrived.
 *
 * That was silent data loss, not just a stale display. `confirm()` passes
 * `designReference: reference` to setDesignPlan, whose reducer does
 * `touch({ ...p, ...plan })` — an explicit `undefined` in a spread OVERWRITES,
 * so clicking Confirm on a freshly-reloaded Design page erased a stored
 * reference and re-planned the whole project from picker defaults, changing
 * designSignature and marking already-approved rooms stale into the bargain.
 * Reported as "the reference image isn't being saved".
 *
 * Not fixed with an effect that syncs state after hydration: that would fight
 * this repo's react-hooks/set-state-in-effect rule, and it would still flash
 * the wrong values for a frame. Not mounting the content until real data
 * exists means each of those seven initializers runs for the first time with
 * the real project already in hand.
 */
export default function DesignPage() {
  const { id } = useParams<{ id: string }>();
  const hydrated = useHydrated();
  const project = useProject(id);
  if (!hydrated || !project) return null;
  return <DesignPageContent />;
}

function DesignPageContent() {
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
  // An uploaded reference photo and what was read off it. When set, the three
  // look pickers below are hidden and these attributes take their place in
  // the Design Planning call — see src/lib/ai/prompting/design-reference.ts.
  // Project type stays visible either way: it describes what the space IS,
  // which a photo of somebody else's cafe says nothing about.
  const [reference, setReference] = useState<DesignReference | undefined>(project?.designReference);
  const [referenceBusy, setReferenceBusy] = useState(false);

  // confirm() below (Design Planning) ends with a router.push to /generate —
  // a router.push, not a <Link>, so it isn't covered by Next's automatic
  // viewport prefetch. It's the ONLY next step from this page, so warm it
  // on mount rather than waiting for the (multi-second) planning call to
  // finish first.
  useEffect(() => {
    router.prefetch(`/projects/${id}/generate`);
  }, [router, id]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  // A picked-but-not-yet-analysed file: chat-attachment staging so the paid
  // Gemini vision call only fires on an explicit "Send reference" click, not
  // on pick. `url` is a local createObjectURL preview, good only for the
  // life of this staged pick, revoked the moment it's cancelled, replaced by
  // a second pick, or superseded by the API's own (durable, data-URI)
  // thumbnail once analysis succeeds.
  const [stagedReference, setStagedReference] = useState<{ file: File; name: string; url: string } | null>(null);
  const referenceInput = useRef<HTMLInputElement>(null);

  const rooms = useMemo(() => project?.floorPlan?.rooms ?? [], [project?.floorPlan?.rooms]);
  // Every field the reference produced, shown back to the user verbatim, so a
  // generation they didn't expect is traceable to a line they can read rather
  // than to a black box. Read-only on purpose: these are the exact strings
  // that go to the planner, and an editable copy would be a fourth place the
  // design can be set.
  const derivedRows: [string, string][] = useMemo(() => {
    const a = reference?.attributes;
    return a
      ? [
          ["Style", a.style],
          ["Luxury", a.luxuryLevel],
          ["Colours", a.colourPalette],
          ["Materials", a.materials],
          ["Lighting", a.lighting],
          ["Furniture", a.furniture],
        ]
      : [];
  }, [reference]);
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

  // Runs the paid call on whatever is currently staged. Only reachable from
  // the "Send reference" button, never from the file input's onChange, so a
  // pick alone never spends a call.
  const analyseReference = async () => {
    if (!stagedReference || referenceBusy) return;
    setReferenceError(null);
    setReferenceBusy(true);
    try {
      const result = await analyseDesignReferenceViaApi(stagedReference.file, id);
      const next: DesignReference = {
        attributes: result.attributes,
        thumbnail: result.thumbnail,
        hash: result.hash,
        analysedAt: new Date().toISOString(),
      };
      setReference(next);
      // Cached on the project the moment it's derived, not held until
      // Confirm: this is one paid Gemini vision call per image, so a reload
      // (or a hop to Review and back) between upload and Confirm must not
      // quietly buy it a second time.
      useVasto.getState().patchProject(id, { designReference: next });
      // The API response carries its own thumbnail (a data URI, durable
      // across a reload) which the analysed-state UI reads from `reference`
      // from here on, so the blob preview that got the user through staging
      // has no reader left.
      URL.revokeObjectURL(stagedReference.url);
      setStagedReference(null);
    } catch (e) {
      // Deliberately keep stagedReference set on failure: the chip and its
      // preview stay on screen so Send can be retried without re-picking.
      setReferenceError(e instanceof Error ? e.message : "Could not read that reference image");
    } finally {
      setReferenceBusy(false);
    }
  };

  const cancelStagedReference = () => {
    if (!stagedReference) return;
    URL.revokeObjectURL(stagedReference.url);
    setStagedReference(null);
    setReferenceError(null);
  };

  const removeReference = () => {
    setReference(undefined);
    setReferenceError(null);
    useVasto.getState().patchProject(id, { designReference: undefined });
  };

  const confirm = async () => {
    if (busy) return;
    if (!subcategory.trim()) {
      setError("Choose or enter a project subcategory.");
      return;
    }
    const palette = COLOUR_PALETTES.find((c) => c.id === colourPalette) ?? COLOUR_PALETTES[0];
    // The role is spelled out in the text itself, not left for the model to
    // guess: colourPaletteText is the ONLY colour information the Design
    // Planning call receives, and an unlabelled list of three hexes let it
    // decide the whole palette read as an accent scheme and answer with a
    // "safe" neutral for the walls — reported bug: a custom palette of three
    // magentas came back with ivory walls. See buildCustomPaletteText below.
    const colourPaletteText = isCustomPalette
      ? buildCustomPaletteText(customColors)
      : `${palette.label} (${palette.description})`;
    // Fingerprints exactly the design selections that affect a room's
    // generated image. Compared against the project's last-saved signature
    // below to decide whether a room that already has an image should keep
    // it (nothing that would change its render actually changed) or get
    // regenerated (the design itself changed, not just the room list).
    //
    // The three picker values are in here only when no reference is active.
    // While one IS active they are hidden and feed nothing, so including them
    // would make the signature react to state the render can't see; the
    // reference's own hash plus its derived attributes are what actually
    // drive the plan, so those are what the fingerprint tracks instead.
    // Swapping one reference photo for another therefore invalidates
    // already-generated rooms exactly as switching palette does.
    const signature = JSON.stringify({
      subcategory,
      notes: additionalRequirements.trim(),
      ...(reference
        ? { reference: { hash: reference.hash, attributes: reference.attributes } }
        : {
            styleId,
            luxuryLevel,
            colourPalette,
            customColors: isCustomPalette ? customColors : undefined,
          }),
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
        // Overrides `design` entirely, server-side (/api/design-plan). Sent
        // as the derived attributes, never the image: the analysis already
        // ran once, at upload.
        designReference: reference?.attributes,
        // The palette's STRUCTURE, not just its prose. buildDesignSpec reads
        // slot one as the wall colour, and `colourPaletteText` above cannot
        // convey that — it flattens the three custom hexes into a list with
        // no roles, which is how a pink palette used to come back with ivory
        // walls. Omitted while a reference is active, since that palette is
        // free text with no preset or slots behind it.
        ...(reference
          ? {}
          : {
              paletteId: isCustomPalette ? undefined : colourPalette,
              customHexes: isCustomPalette ? customColors : undefined,
            }),
      });
      setDesignPlan(id, {
        subcategory,
        luxuryLevel,
        colourPalette,
        customColourHexes: isCustomPalette ? customColors : undefined,
        designReference: reference,
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
      //
      // PERF: dynamically imported once here (was a static top-level import)
      // — the greybox module pulls in three.js transitively (render-mask.ts
      // -> three), measured at ~560KB of extra First Load JS on this route
      // (route-bundle-stats.json: 1399.4KB here vs. ~840KB baseline on routes
      // that never touch greybox). ensureGreybox only ever runs after this
      // button click, never during initial render, so deferring the import
      // to here keeps three.js out of this route's initial bundle. Hoisted
      // above the loop (rather than inside each per-room IIFE below) so the
      // dynamic import only resolves once per confirm(), not once per room.
      //
      // Not imported AT ALL on a plan-skipped project: skipping the Plan step
      // means there is no room geometry to render a greybox from, so the
      // whole three.js module (and every render/upload it would do) is dead
      // weight. `planSkipped` also has to gate the FIELDS sent below, not
      // just this call — the server keys `hasGreybox` off greyboxKey, and a
      // stale key persisted on a room from before the skip would otherwise
      // still route the prompt down the greybox path.
      const skipGreybox = !!project.planSkipped;
      const ensureGreybox = skipGreybox
        ? undefined
        : (await import("@/lib/greybox/ensure-greybox-key")).ensureGreybox;
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
        //
        // The Furnish gallery (Task 16) already renders every room's greybox
        // before the user ever reaches this page, so ensureGreybox here is
        // normally a cache hit. It stays as a fallback for a room reached by
        // a route that skipped Furnish entirely (e.g. a stale bookmark).
        (async () => {
          try {
            const gb = ensureGreybox
              ? await ensureGreybox(id, room).catch((e) => {
                  console.warn(
                    `[generate] greybox render/upload failed for "${room.name}", falling back to text-only:`,
                    e instanceof Error ? e.message : e,
                  );
                  return undefined;
                })
              : undefined;
            // Never spread the whole ensureGreybox result into the store —
            // `projected` is derived fresh on every call (see GreyboxResult's
            // own doc comment) and is not one of Room's persisted fields.
            // Only the four real fields go to updateRoom; `gb.projected` and
            // `gb.greyboxKey`/etc. stay in local scope for the
            // generateRoomImage call below.
            if (gb) {
              useVasto.getState().updateRoom(id, room.id, {
                greyboxKey: gb.greyboxKey,
                greyboxMaskKey: gb.greyboxMaskKey,
                greyboxHash: gb.greyboxHash,
                greyboxLedger: gb.greyboxLedger,
              });
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
              greyboxKey: gb?.greyboxKey,
              greyboxMaskKey: gb?.greyboxMaskKey,
              projected: gb?.projected,
              // Both omitted on a plan-skipped project: there is no reference
              // image, so there is no grey box for a piece to be mapped to,
              // and sending a roomSpec would have the prompt describe
              // positions ("the long low box at centre-left") against an
              // image the model was never given.
              furniture: skipGreybox ? undefined : room.furniture,
              // Lets the server rebuild this room's locked camera and name
              // which grey box each furniture piece is. Derived through the
              // shared roomSpecFor so it cannot drift from the spec
              // ensureGreybox actually rendered.
              roomSpec: skipGreybox ? undefined : roomSpecFor(room),
              greyboxAnnotatedKey: gb?.greyboxAnnotatedKey,
            });
            useVasto.getState().addGeneration(id, room.id, {
              id: uid("gen"),
              createdAt: new Date().toISOString(),
              imageUrl: gen.imageUrl,
              imageKey: gen.key,
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

        <Section title="Design reference">
          {stagedReference ? (
            // Staged, not yet sent: a chat-attachment-style chip (thumbnail
            // + filename + cancel) plus the button that actually spends the
            // paid call. Shown for a fresh pick AND for "Replace image" on
            // an already-analysed reference alike — `reference` itself is
            // untouched underneath until Send succeeds, so Cancel here just
            // drops back to whatever was on screen before this pick.
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border bg-surface p-3.5">
              <div className="flex items-center gap-2.5 rounded-xl border border-border-strong bg-bg py-1.5 pl-1.5 pr-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from createObjectURL, next/image's loader can't take it */}
                <img
                  src={stagedReference.url}
                  alt=""
                  className="size-10 shrink-0 rounded-lg border border-border object-cover"
                />
                <span className="max-w-[12rem] truncate text-xs font-medium">{stagedReference.name}</span>
                <button
                  type="button"
                  onClick={cancelStagedReference}
                  className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-faint transition-colors hover:bg-danger/10 hover:text-danger"
                  aria-label="Cancel this upload"
                >
                  <Icon name="X" className="size-3.5" />
                </button>
              </div>
              <Button size="sm" icon="Upload" onClick={analyseReference} loading={referenceBusy} disabled={referenceBusy}>
                {referenceBusy ? "Reading your reference…" : "Send reference"}
              </Button>
            </div>
          ) : reference ? (
            <div className="rounded-2xl border border-accent/40 bg-accent/5 p-3.5">
              <div className="flex items-start gap-4">
                {reference.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element -- a base64 data URI, which next/image's loader can't take
                  <img
                    src={reference.thumbnail}
                    alt="Your design reference"
                    className="size-24 shrink-0 rounded-xl border border-border object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Design taken from your reference photo</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Style, luxury level and colour palette are read from this image, so those pickers are hidden.
                  </p>
                  <dl className="mt-3 space-y-1">
                    {derivedRows.map(([label, value]) => (
                      <div key={label} className="flex gap-2 text-xs">
                        <dt className="w-20 shrink-0 text-faint">{label}</dt>
                        <dd className="min-w-0 flex-1 text-muted">{value || "not read"}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon="ImagePlus" onClick={() => referenceInput.current?.click()}>
                  Replace image
                </Button>
                <Button size="sm" variant="ghost" icon="Trash2" onClick={removeReference}>
                  Remove and pick manually
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-surface p-4">
              <p className="text-sm font-medium">Have a photo of an interior you want yours to look like?</p>
              <p className="mt-1 text-xs text-muted">
                Upload it and we read the style, colours, materials, lighting and furniture character straight off
                the image, instead of you picking from the presets below. PNG or JPG, up to 20MB.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                icon="ImagePlus"
                onClick={() => referenceInput.current?.click()}
              >
                Upload design reference
              </Button>
            </div>
          )}

          <input
            ref={referenceInput}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so re-picking the SAME file still fires a change
              // event — otherwise a cancelled or failed pick can't be
              // restaged without choosing a different image first.
              e.target.value = "";
              if (!file) return;
              // Only reachable if a previous staged pick was cancelled or
              // sent (both clear stagedReference and revoke its url before
              // this can fire again from the same chip), but revoke
              // defensively rather than assume that invariant holds forever.
              if (stagedReference) URL.revokeObjectURL(stagedReference.url);
              setReferenceError(null);
              setStagedReference({ file, name: file.name, url: URL.createObjectURL(file) });
            }}
          />

          {referenceError && (
            <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-xs text-danger">
              <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
              <span>{referenceError}</span>
            </div>
          )}
        </Section>

        {/* Hidden while a reference is active: the reference already answers
            all three, and leaving them on screen would invite the user to set
            a value that feeds nothing. Project type and Additional
            requirements stay, above and below. */}
        {!reference && (
          <>
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

          <p className="mt-1.5 text-[11px] text-faint">
            With a custom palette, the first colour is used for the walls and the other two as
            accents — soft furnishings, trim and details.
          </p>

          {isCustomPalette && (
            <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3.5">
              <p className="text-xs text-muted">Pick 3 colours:</p>
              {customColors.map((hex, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <label
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
                      aria-label={i === 0 ? "Wall colour" : `Accent colour ${i}`}
                    />
                  </label>
                  <span className="text-[10px] text-faint">{i === 0 ? "Wall" : `Accent ${i}`}</span>
                </div>
              ))}
              <p className="ml-auto text-xs font-mono text-faint">{customColors.join(" · ")}</p>
            </div>
          )}
        </Section>
          </>
        )}

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
