"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { editRoomImage, enhanceRoomImage } from "@/lib/generation-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { RetryImg } from "@/components/ui/retry-img";
import { LassoCanvas, REGION_COLORS, MAX_LASSO_REGIONS, type LassoRegionsHandle } from "@/components/project/lasso-canvas";
import { cn, uid, slugifyRoomName } from "@/lib/utils";

/** One region's staged reference photo — chat-attachment-style: an object-URL
 * preview for the chip's thumbnail, plus the downscaled data URI that
 * actually goes to the server (see downscaleReferenceImage below). */
interface RegionRef {
  name: string;
  /** Blob: URL for the chip's thumbnail preview — revoked on remove, on
   *  replace, and on unmount (see the cleanup effect near the component's end). */
  url: string;
  dataUri: string;
}

/**
 * Client-side downscale before a reference photo is POSTed — longest side
 * capped at 1024px, re-encoded as JPEG (~0.85 quality). A phone photo is
 * several MB and must not be posted raw; the server also caps this, but
 * shrinking here keeps the request small and the upload fast. Falls back to
 * a plain data-URI read if canvas decoding fails for any reason (e.g. an
 * exotic format the browser can't draw).
 */
async function downscaleReferenceImage(file: File, maxDim = 1024, quality = 0.85): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Could not read that file"));
      reader.readAsDataURL(file);
    });
  }
}

/** Small pill badge for a generation's provenance — mirrors the strip's
 * "Latest"/"v{n}" tag exactly (same classes) so a new label reads as part of
 * the same system rather than a bolted-on extra. */
function ProvenanceBadge({ enhanced }: { enhanced?: boolean }) {
  return (
    <span className="rounded-md border border-white/10 bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-foreground/90 backdrop-blur-sm">
      {enhanced ? "Enhanced" : "Edited"}
    </span>
  );
}

/**
 * View & Edit (revamp Workstream 8.5, flow step 9) — full-size image, up to
 * 2 independently-numbered lasso regions each with its own instruction
 * (and now an optional reference photo), applied in one combined edit.
 * Everything outside the selected regions must stay pixel-identical. Also
 * hosts Enhance: a whole-image re-render of the current version that always
 * lands as a new, separate generation.
 */
export default function ViewEditPage() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);

  const [lassoOn, setLassoOn] = useState(false);
  const [regionCount, setRegionCount] = useState(0);
  const [prompts, setPrompts] = useState<string[]>(["", ""]);
  const [regionRefs, setRegionRefs] = useState<(RegionRef | null)[]>([null, null]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lassoError, setLassoError] = useState<string | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const lassoRef = useRef<LassoRegionsHandle>(null);
  const lassoErrorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regionFileInputs = useRef<(HTMLInputElement | null)[]>([]);

  // Kept in sync via its own effect (never written or read during render —
  // this repo's react-hooks/refs rule forbids both) so the unmount-only
  // cleanup effect below can revoke whatever object URLs are outstanding at
  // unmount time without re-subscribing the effect itself on every
  // regionRefs change.
  const regionRefsRef = useRef(regionRefs);
  useEffect(() => {
    regionRefsRef.current = regionRefs;
  }, [regionRefs]);

  useEffect(() => {
    return () => {
      regionRefsRef.current.forEach((r) => r && URL.revokeObjectURL(r.url));
    };
  }, []);

  if (!project) return null;
  const room = project.floorPlan?.rooms.find((r) => r.id === roomId);
  const card = project.roomCards.find((c) => c.roomId === roomId);

  if (!room || !card || card.generations.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-7 text-muted" />
          <p className="mt-3 text-sm text-muted">No generation to edit yet.</p>
          <Link href={`/projects/${id}/generate`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">Back to Generate</Button>
          </Link>
        </div>
      </div>
    );
  }

  const current = card.generations.find((g) => g.id === viewedId) ?? card.generations.at(-1)!;
  const anyBusy = busy || enhanceBusy;

  const clearRegionRefs = () => {
    regionRefs.forEach((r) => r && URL.revokeObjectURL(r.url));
    setRegionRefs([null, null]);
  };

  const toggleLasso = () => {
    lassoRef.current?.clear();
    setRegionCount(0);
    setPrompts(["", ""]);
    clearRegionRefs();
    setError(null);
    setLassoError(null);
    setDeleteIndex(null);
    setLassoOn((v) => !v);
  };

  const handleBlockedAttempt = () => {
    setLassoError(`Only ${MAX_LASSO_REGIONS} regions allowed at a time.`);
    if (lassoErrorTimeout.current) clearTimeout(lassoErrorTimeout.current);
    lassoErrorTimeout.current = setTimeout(() => setLassoError(null), 3000);
  };

  const confirmDeleteRegion = () => {
    if (deleteIndex === null) return;
    lassoRef.current?.removeRegion(deleteIndex);
    setPrompts((p) => {
      const next = [...p];
      next.splice(deleteIndex, 1);
      next.push("");
      return next;
    });
    setRegionRefs((refs) => {
      const removed = refs[deleteIndex];
      if (removed) URL.revokeObjectURL(removed.url);
      const next = [...refs];
      next.splice(deleteIndex, 1);
      next.push(null);
      return next;
    });
    setDeleteIndex(null);
  };

  const pickRegionRef = async (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so re-picking the SAME file still fires a change event.
    e.target.value = "";
    if (!file) return;
    const prev = regionRefs[index];
    if (prev) URL.revokeObjectURL(prev.url);
    const url = URL.createObjectURL(file);
    try {
      const dataUri = await downscaleReferenceImage(file);
      setRegionRefs((refs) => {
        const next = [...refs];
        next[index] = { name: file.name, url, dataUri };
        return next;
      });
    } catch {
      URL.revokeObjectURL(url);
      setError("Could not read that reference image.");
    }
  };

  const removeRegionRef = (index: number) => {
    setRegionRefs((refs) => {
      const cur = refs[index];
      if (cur) URL.revokeObjectURL(cur.url);
      const next = [...refs];
      next[index] = null;
      return next;
    });
  };

  const generate = async () => {
    if (busy || regionCount === 0 || !imgSize.w) return;
    // A region carrying a reference photo but no typed instruction must not
    // be submittable — the reference is a visual guide, never a replacement
    // for the text, so silently dropping it (or silently sending it with a
    // blank prompt) would both be wrong. Surfaced the same way the
    // no-instructions-at-all case below already is.
    const missingIndex = Array.from({ length: regionCount }, (_, i) => i).find(
      (i) => regionRefs[i] && !(prompts[i]?.trim()),
    );
    if (missingIndex !== undefined) {
      setError(`Region ${missingIndex + 1} has a reference photo — add an instruction for it too.`);
      return;
    }
    const masks = lassoRef.current?.getMasks(imgSize.w, imgSize.h) ?? [];
    const regions = masks
      .map((mask, i) => ({ mask, prompt: prompts[i]?.trim() ?? "", reference: regionRefs[i]?.dataUri }))
      .filter((r) => r.prompt);
    if (regions.length === 0) {
      setError("Add an instruction for at least one region.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await editRoomImage({
        projectId: id,
        baseImageKey: current.imageKey,
        styleId: project.styleId,
        regions,
      });
      addGeneration(id, roomId, {
        id: uid("gen"),
        createdAt: new Date().toISOString(),
        imageUrl: result.imageUrl,
        imageKey: result.key,
        prompt: current.prompt,
        edited: true,
      });
      lassoRef.current?.clear();
      setRegionCount(0);
      setPrompts(["", ""]);
      clearRegionRefs();
      setLassoOn(false);
      setViewedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
    }
  };

  const enhance = async () => {
    if (anyBusy) return;
    setEnhanceBusy(true);
    setEnhanceError(null);
    try {
      const result = await enhanceRoomImage({
        projectId: id,
        baseImageKey: current.imageKey,
        styleId: project.styleId,
      });
      addGeneration(id, roomId, {
        id: uid("gen"),
        createdAt: new Date().toISOString(),
        imageUrl: result.imageUrl,
        imageKey: result.key,
        prompt: current.prompt,
        enhanced: true,
      });
      setViewedId(null);
    } catch (e) {
      setEnhanceError(e instanceof Error ? e.message : "Enhance failed");
    } finally {
      setEnhanceBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <Link
          href={`/projects/${id}/generate`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-foreground"
        >
          <Icon name="ArrowLeft" className="size-4" /> {room.name}
        </Link>
        <div className="flex items-center gap-2">
          <a
            href={current.imageUrl}
            download={`${slugifyRoomName(room.name)}.png`}
            aria-disabled={anyBusy}
            onClick={(e) => {
              if (anyBusy) e.preventDefault();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-foreground cursor-pointer",
              anyBusy && "pointer-events-none opacity-50",
            )}
            aria-label="Save image to your device"
            title="Save image"
          >
            <Icon name="Download" className="size-4" />
            Save
          </a>
          <Button
            size="sm"
            variant="outline"
            icon="Wand2"
            loading={enhanceBusy}
            disabled={busy || (!enhanceBusy && lassoOn)}
            onClick={enhance}
            aria-label="Enhance this image"
            title="Enhance this image"
          >
            {enhanceBusy ? "Enhancing…" : "Enhance"}
          </Button>
          <Button
            size="sm"
            variant={lassoOn ? "primary" : "outline"}
            icon="Lasso"
            disabled={enhanceBusy}
            onClick={toggleLasso}
          >
            {lassoOn ? "Cancel edit" : "Selection Editing"}
          </Button>
        </div>
      </div>

      {enhanceError && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-xs text-danger">
          <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
          <span>{enhanceError}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-bg p-6">
        <div className="mx-auto flex h-full max-w-5xl gap-5">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-grid">
            <RetryImg
              src={current.imageUrl}
              alt={room.name}
              className="absolute inset-0 h-full w-full object-contain"
              onLoad={(e) => {
                const img = e.currentTarget;
                setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
            {lassoOn && (
              <LassoCanvas
                ref={lassoRef}
                enabled={lassoOn}
                processing={busy}
                maxRegions={MAX_LASSO_REGIONS}
                onRegionsChange={setRegionCount}
                onBlockedAttempt={handleBlockedAttempt}
              />
            )}
          </div>

          {lassoOn && (
            <aside className="w-72 shrink-0 overflow-y-auto">
              <p className="mb-3 text-xs text-muted">
                Draw up to {MAX_LASSO_REGIONS} regions on the image. Beside the sofa, on a wall, near the TV.
                Each one gets its own number and instruction below.
              </p>
              {Array.from({ length: regionCount }).map((_, i) => (
                <div
                  key={i}
                  className="relative mb-3 rounded-xl border border-info/30 bg-info/10 p-3"
                >
                  <button
                    type="button"
                    aria-label={`Delete region ${i + 1}`}
                    disabled={busy}
                    onClick={() => setDeleteIndex(i)}
                    className="absolute right-2 top-2 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-danger disabled:pointer-events-none disabled:opacity-40 cursor-pointer"
                  >
                    <Icon name="Trash2" className="size-3.5" />
                  </button>
                  <div className="mb-1.5 flex items-center gap-1.5 pr-6 text-xs font-semibold">
                    <span
                      className="grid size-5 place-items-center rounded-full text-[11px] text-white"
                      style={{ background: REGION_COLORS[i % REGION_COLORS.length] }}
                    >
                      {i + 1}
                    </span>
                    Region {i + 1}
                  </div>
                  <textarea
                    value={prompts[i] ?? ""}
                    onChange={(e) =>
                      setPrompts((p) => {
                        const next = [...p];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                    disabled={busy}
                    rows={2}
                    placeholder={i === 0 ? "Add a flower vase here." : "Replace this wall art."}
                    className="input w-full resize-none text-xs disabled:opacity-50"
                  />

                  <div className="mt-2">
                    {regionRefs[i] ? (
                      <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-bg py-1 pl-1 pr-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from createObjectURL, next/image's loader can't take it */}
                        <img
                          src={regionRefs[i]!.url}
                          alt=""
                          className="size-7 shrink-0 rounded-md border border-border object-cover"
                        />
                        <span className="min-w-0 max-w-[8rem] flex-1 truncate text-[11px] font-medium">
                          {regionRefs[i]!.name}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove reference for region ${i + 1}`}
                          disabled={busy}
                          onClick={() => removeRegionRef(i)}
                          className="grid size-4 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40 cursor-pointer"
                        >
                          <Icon name="X" className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => regionFileInputs.current[i]?.click()}
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 cursor-pointer"
                      >
                        <Icon name="ImagePlus" className="size-3.5" /> Add reference
                      </button>
                    )}
                    <input
                      ref={(el) => {
                        regionFileInputs.current[i] = el;
                      }}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => pickRegionRef(i, e)}
                    />
                    <p className="mt-1 text-[10px] text-faint">
                      Used as a visual guide for this change — its shape, colour and material, adapted to this
                      room&apos;s lighting and angle.
                    </p>
                  </div>
                </div>
              ))}
              {regionCount === 0 && (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
                  No regions drawn yet.
                </p>
              )}
              {regionCount >= MAX_LASSO_REGIONS && (
                <p className="mb-3 text-[11px] text-faint">
                  Maximum {MAX_LASSO_REGIONS} regions per edit. Generate this, then use Selection Editing again for more.
                </p>
              )}
              {lassoError && <p className="mb-3 text-[11px] text-danger">{lassoError}</p>}
              {error && <p className="mb-3 text-[11px] text-danger">{error}</p>}
              <Button className="w-full" icon="Sparkles" loading={busy} disabled={regionCount === 0} onClick={generate}>
                Generate
              </Button>
              <p className="mt-2 text-[11px] text-faint">
                Only the numbered regions change. Everything else in the photo stays identical.
              </p>
            </aside>
          )}
        </div>
      </div>

      {card.generations.length > 1 && (
        <div className="border-t border-border p-3">
          <div className="mx-auto flex max-w-5xl gap-2 overflow-x-auto">
            {card.generations.map((g) => (
              <button
                key={g.id}
                onClick={() => setViewedId(g.id)}
                className={cn(
                  "relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border-2 cursor-pointer",
                  g.id === current.id ? "border-accent" : "border-transparent opacity-70 hover:opacity-100",
                )}
              >
                <RetryImg src={g.imageUrl} alt="" className="h-full w-full object-cover" />
                {(g.edited || g.enhanced) && (
                  <span className="absolute left-1 top-1 z-10">
                    <ProvenanceBadge enhanced={g.enhanced} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={deleteIndex !== null}
        onClose={() => setDeleteIndex(null)}
        title="Delete this region?"
        className="max-w-sm"
      >
        <div className="flex items-center justify-end gap-2 px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => setDeleteIndex(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" icon="Trash2" onClick={confirmDeleteRegion}>
            Confirm
          </Button>
        </div>
      </Modal>
    </div>
  );
}
