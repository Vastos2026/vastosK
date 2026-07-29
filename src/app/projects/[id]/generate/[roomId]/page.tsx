"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { editRoomImage } from "@/lib/generation-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { LassoCanvas, REGION_COLORS, MAX_LASSO_REGIONS, type LassoRegionsHandle } from "@/components/project/lasso-canvas";
import { cn, uid } from "@/lib/utils";

/**
 * View & Edit (revamp Workstream 8.5, flow step 9) — full-size image, up to
 * 2 independently-numbered lasso regions each with its own instruction,
 * applied in one combined edit. Everything outside the selected regions must
 * stay pixel-identical.
 */
export default function ViewEditPage() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  const project = useProject(id);
  const addGeneration = useVasto((s) => s.addGeneration);

  const [lassoOn, setLassoOn] = useState(false);
  const [regionCount, setRegionCount] = useState(0);
  const [prompts, setPrompts] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lassoError, setLassoError] = useState<string | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [viewedId, setViewedId] = useState<string | null>(null);
  const lassoRef = useRef<LassoRegionsHandle>(null);
  const lassoErrorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const toggleLasso = () => {
    lassoRef.current?.clear();
    setRegionCount(0);
    setPrompts(["", ""]);
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
    setDeleteIndex(null);
  };

  const generate = async () => {
    if (busy || regionCount === 0 || !imgSize.w) return;
    const masks = lassoRef.current?.getMasks(imgSize.w, imgSize.h) ?? [];
    const regions = masks
      .map((mask, i) => ({ mask, prompt: prompts[i]?.trim() ?? "" }))
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
      setLassoOn(false);
      setViewedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
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
        <Button
          size="sm"
          variant={lassoOn ? "primary" : "outline"}
          icon="Lasso"
          onClick={toggleLasso}
        >
          {lassoOn ? "Cancel edit" : "Selection Editing"}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-bg p-6">
        <div className="mx-auto flex h-full max-w-5xl gap-5">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-grid">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
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
                Draw up to {MAX_LASSO_REGIONS} regions on the image — beside the sofa, on a wall, near the TV.
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
                Only the numbered regions change — everything else in the photo stays identical.
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.imageUrl} alt="" className="h-full w-full object-cover" />
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
