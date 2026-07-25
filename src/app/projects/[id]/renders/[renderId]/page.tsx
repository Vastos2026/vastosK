"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useProject, useVasto } from "@/lib/store";
import { STYLES, STYLE_BY_ID } from "@/lib/data";
import { checkConsistency, fetchVideoJob, generateRender, generateVideo, inpaintRender, type VideoFrame } from "@/lib/render-client";
import { buildSegmentPrompts, buildVideoPrompt } from "@/lib/room-video";
import { buildRoomSpec } from "@/lib/room-spec";
import dynamic from "next/dynamic";
import { LassoCanvas, type LassoHandle } from "@/components/project/lasso-canvas";
import RoomWalkthrough from "@/components/project/room-walkthrough";
import { annotateRenderImage } from "@/lib/render/annotate";
import type { CaptureFn } from "@/components/project/scene-3d";

const Panorama360 = dynamic(() => import("@/components/project/panorama-360"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-muted">Loading 360°…</div>,
});
// Offscreen 3D scene — camera truth for the walkthrough's side stills (WebGL, client-only).
const Scene3D = dynamic(() => import("@/components/project/scene-3d"), { ssr: false });
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, timeAgo, uid } from "@/lib/utils";

const QUICK_PROMPTS = [
  "Replace sofa with luxury leather sofa",
  "Make the wall dark grey",
  "Warmer ambient lighting",
  "Add a patterned area rug",
  "Swap flooring for Italian marble",
];

export default function RenderDetailPage() {
  const { id, renderId } = useParams<{ id: string; renderId: string }>();
  const project = useProject(id);
  const updateRender = useVasto((s) => s.updateRender);
  const addRenderVersion = useVasto((s) => s.addRenderVersion);
  const addRender = useVasto((s) => s.addRender);

  const render = project?.renders.find((r) => r.id === renderId);

  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [lasso, setLasso] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [refName, setRefName] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("Inpainting region…");
  const [compare, setCompare] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const lassoRef = useRef<LassoHandle>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  // Capture fn of the hidden 3D scene — the walkthrough's Right/Back/Left wall
  // screenshots come from here (fresh + reload-safe; the room page's stash is
  // only the fallback).
  const captureRef = useRef<CaptureFn | null>(null);
  // Actual aspect of the loaded render, so the stage matches it exactly and the
  // lasso maps 1:1 to image pixels (no object-cover crop = no mask misalignment).
  const [imgAspect, setImgAspect] = useState<number | null>(null);
  // 360° render: default to the arrow walkthrough; toggle to the sphere viewer.
  const [walkMode, setWalkMode] = useState(true);
  // Dimension-annotated finish (the design-document look): red mm figures +
  // arrows composited onto the photo from the REVIEWED plan numbers. Display
  // and export only — the stored render stays clean for Veo and for edits.
  const [dims, setDims] = useState(true);
  // Tagged with the inputs that produced it — a result whose key no longer
  // matches is simply ignored, so no synchronous reset is ever needed.
  const [annotated, setAnnotated] = useState<{ key: string; url: string } | null>(null);

  // Default to the latest version whenever nothing (or a since-removed
  // version) is explicitly selected — derived at render time rather than
  // synced via an effect, so there's no stale-state flash on first render.
  const effectiveVersionId =
    activeVersionId && render?.versions.some((v) => v.id === activeVersionId)
      ? activeVersionId
      : (render?.versions.at(-1)?.id ?? null);

  // Re-annotate only when something that CHANGES the drawing changes (the key),
  // not on every store touch — walkthrough job updates would otherwise redraw.
  const annVersion = render?.versions.find((v) => v.id === effectiveVersionId);
  const annRoom = project?.floorPlan?.rooms.find((r) => r.id === render?.roomId);
  const annItems =
    project?.placedItems.filter((it) => it.roomId === render?.roomId && !it.ghost) ?? [];
  const annKey = [
    dims,
    annVersion?.imageUrl,
    render?.view,
    annRoom?.id,
    annRoom?.name,
    annRoom?.width,
    annRoom?.height,
    annRoom?.ceilingFt,
    annItems.map((i) => `${i.name}:${i.w}x${i.d}x${i.h}`).join(","),
  ].join("|");
  useEffect(() => {
    const url = annVersion?.imageUrl;
    if (!dims || !render || !annRoom || !url) return;
    if (url.includes(".mp4") || render.view === "pano" || render.view === "top") return;
    let cancelled = false;
    const key = annKey;
    annotateRenderImage(url, {
      roomName: annRoom.name,
      widthFt: annRoom.width,
      depthFt: annRoom.height,
      ceilingFt: annRoom.ceilingFt ?? 9,
      view: render.view,
      furniture: annItems.map((it) => ({ name: it.name, w: it.w, d: it.d, h: it.h })),
    })
      .then((u) => {
        if (!cancelled) setAnnotated({ key, url: u });
      })
      .catch(() => {
        /* keep the clean render — annotation is best-effort */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annKey]);
  const annotatedUrl = annotated?.key === annKey ? annotated.url : null;

  if (project && !render) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div>
          <Icon name="CircleAlert" className="mx-auto size-7 text-muted" />
          <p className="mt-3 text-sm text-muted">Render not found.</p>
          <Link href={`/projects/${id}/renders`}>
            <Button className="mt-4" variant="outline" icon="ArrowLeft">Back to renders</Button>
          </Link>
        </div>
      </div>
    );
  }
  if (!project || !render) return null;

  const versions = render.versions;
  const activeIdx = versions.findIndex((v) => v.id === effectiveVersionId);
  const activeVersion = versions[activeIdx];
  const displayedStyleId = activeVersion?.styleId ?? render.styleId;
  const displayedStyle = STYLE_BY_ID[displayedStyleId] ?? STYLES[0];
  const prevVersion = activeIdx > 0 ? versions[activeIdx - 1] : null;

  const canUndo = activeIdx > 0;
  const canRedo = activeIdx >= 0 && activeIdx < versions.length - 1;
  const square = render.view === "top";
  // Whether this render has a room to annotate (gates the Dimensions toggle).
  const dimRoom = annRoom;

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  // Validate + read an uploaded reference, DOWNSCALING it to ~1024px first. A
  // reference is only a visual guide (shape/materials), so a full-res screenshot
  // just bloats the upload and the Nano payload — which made edits-with-reference
  // slow. Resizing here shrinks both, so the edit is as fast as a normal one.
  const onPickReference = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return flash("Reference must be an image (PNG/JPG/WebP).");
    if (file.size > 10 * 1024 * 1024) return flash("Reference image is too large (max 10 MB).");
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) return flash("Couldn't read that image.");
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setReference(dataUrl);
          setRefName(file.name);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        setReference(canvas.toDataURL("image/jpeg", 0.85));
        setRefName(file.name);
      };
      img.onerror = () => {
        // Couldn't decode for resize — fall back to the original (still works).
        setReference(dataUrl);
        setRefName(file.name);
      };
      img.src = dataUrl;
    };
    reader.onerror = () => flash("Couldn't read that image.");
    reader.readAsDataURL(file);
  };

  const clearReference = () => {
    setReference(null);
    setRefName(null);
    if (refInputRef.current) refInputRef.current.value = "";
  };

  // Selective edit: send the masked region + instruction to FLUX-Fill.
  const regenerate = async () => {
    if (!activeVersion?.imageKey) return flash("This version has no base image to edit.");
    const w = imgRef.current?.naturalWidth || 1024;
    const h = imgRef.current?.naturalHeight || (square ? 1024 : 576);
    const mask = lassoRef.current?.getMask(w, h);
    if (!mask) return flash("Draw a region with the Lasso first.");

    setProcessingLabel("Inpainting region…");
    setProcessing(true);
    setCompare(false);
    try {
      const note = instruction.trim() || (reference ? "Edit from reference" : "Selective edit");
      const result = await inpaintRender({
        projectId: id,
        baseKey: activeVersion.imageKey,
        mask,
        instruction: instruction.trim(),
        style: displayedStyle,
        reference: reference ?? undefined,
        // Use the smart Nano edit (expands to the whole object/area) or a clear
        // retry — never the FLUX-Fill edit confined to the strict lasso outline.
        noFluxFallback: true,
      });
      const vid = uid("v");
      addRenderVersion(id, render.id, {
        id: vid,
        label: `v${versions.length + 1}`,
        createdAt: new Date().toISOString(),
        note,
        styleId: displayedStyleId,
        imageUrl: result.imageUrl,
        imageKey: result.key,
        prompt: result.prompt,
      });
      setActiveVersionId(vid);
      lassoRef.current?.clear();
      setHasMask(false);
      setLasso(false);
      setInstruction("");
      clearReference();
      flash(note);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Inpainting failed");
    } finally {
      setProcessing(false);
    }
  };

  // GROUNDED 360° walkthrough. The old approach asked Veo to invent a full spin
  // from the front photo alone — it had to hallucinate the unseen 270°, so the
  // motion drifted (never reaching the back wall) and furniture popped in and
  // out. Now every side is a REAL photo before any video exists:
  //   1. Right / Back / Left stills — Nano renders each wall's actual 3D
  //      screenshot (camera truth) anchored to THIS edited front photo (style
  //      truth), so nothing can disappear: it's in the geometry.
  //   2. Veo films four quarter-turns, each pinned to a real still at BOTH ends
  //      (first→last frame interpolation), stitched server-side into one seamless
  //      orbit — all four walls guaranteed, equal time each, ends where it began.
  const generateWalkthrough = async () => {
    if (videoBusy || !render || !activeVersion?.imageUrl) return;
    setVideoBusy(true);
    flash("Preparing the 360° walkthrough…");
    const roomId = render.roomId;
    const styleId = displayedStyleId;
    const now = () => new Date().toISOString();

    const videoJobId = uid("rnd");
    // Add a version only if the record is still empty — the same tab's reconcile
    // sweep can win the race during the POST's final network window and apply
    // the registry result first; without this guard we'd append a duplicate.
    const addVersionOnce = (renderId: string, version: Parameters<typeof addRenderVersion>[2]) => {
      const rec = useVasto.getState().getProject(id)?.renders.find((r) => r.id === renderId);
      if (rec && rec.versions.length === 0) addRenderVersion(id, renderId, version);
    };
    const sideJobs: { view: "left" | "right" | "back"; label: string; jobId: string }[] = [
      { view: "right", label: "Right", jobId: uid("rnd") },
      { view: "back", label: "Back", jobId: uid("rnd") },
      { view: "left", label: "Left", jobId: uid("rnd") },
    ];
    // The walkthrough VIDEO shows under a `pano` render (that page plays the .mp4).
    addRender(id, { id: videoJobId, view: "pano", styleId, roomId, status: "processing", createdAt: now(), progress: 0, versions: [] });
    // Stamp each side record with the pano's id (videoOf) so the reconcile pass
    // completes exactly THIS attempt's sides, not every same-room side record.
    for (const s of sideJobs)
      addRender(id, { id: s.jobId, view: s.view, styleId, roomId, videoOf: videoJobId, status: "processing", createdAt: now(), progress: 0, versions: [] });
    // Fail only the side records still pending — a side whose still already
    // rendered is a real, valid photo and stays completed.
    const failSides = (msg: string) => {
      for (const s of sideJobs) {
        const rec = useVasto.getState().getProject(id)?.renders.find((r) => r.id === s.jobId);
        if (rec && rec.status === "processing") updateRender(id, s.jobId, { status: "failed", error: msg });
      }
    };
    const failAll = (msg: string) => {
      updateRender(id, videoJobId, { status: "failed", error: msg });
      failSides(msg);
      flash(msg);
    };

    let stagePoll: ReturnType<typeof setInterval> | undefined;
    try {
      const frontDataUri = await fetchAsDataUrl(activeVersion.imageUrl);
      if (!frontDataUri) return failAll("Couldn't read this render");
      const videoRoom = roomId ? project.floorPlan?.rooms.find((r) => r.id === roomId) : undefined;
      const videoSpec =
        videoRoom && project.floorPlan
          ? buildRoomSpec(videoRoom, project.placedItems, project.floorPlan)
          : null;

      // ---- 1) Side stills, clockwise — each grounded in its wall's REAL 3D view.
      // Camera truth: the hidden 3D scene on this page (fresh, reload-safe), else
      // the captures stashed when the room page rendered the front photo.
      const stash = roomId ? useVasto.getState().roomCaptures[roomId] : undefined;
      const sideStills: Partial<Record<"right" | "back" | "left", { uri: string; frame: VideoFrame }>> = {};
      // Quality warnings gathered across the walkthrough (unverified sides + a Veo
      // segment that couldn't be pinned) → stored on the clip so the user sees
      // exactly what may drift and can retry, rather than a silently-degraded orbit.
      const qualityWarnings: string[] = [];
      if (videoRoom && project.floorPlan) {
        for (let i = 0; i < sideJobs.length; i++) {
          const s = sideJobs[i];
          const shot = captureRef.current?.(s.view) ?? stash?.[s.view];
          if (!shot) {
            return failAll(
              "Couldn't capture the room's 3D views — open the room and render the front photo again.",
            );
          }
          flash(`Rendering the ${s.label} side (${i + 1}/3)…`);
          try {
            const still = await generateRender({
              projectId: id,
              view: s.view,
              style: displayedStyle,
              propertyType: project.propertyType,
              plan: { ...project.floorPlan, rooms: [videoRoom] },
              items: project.placedItems.filter((it) => it.roomId === videoRoom.id && !it.ghost),
              image: shot, // this wall's 3D screenshot = the camera
              anchorKey: activeVersion.imageKey, // the edited front photo = the look
              noFluxFallback: true,
              // All four sides must share the front photo's design — reject (and
              // let the user retry) an unanchored side rather than filming it.
              requireAnchor: true,
            });
            const uri = await fetchAsDataUrl(still.imageUrl);
            if (!uri) throw new Error(`Couldn't read the ${s.label} still back`);
            sideStills[s.view] = {
              uri,
              frame: { view: s.view, label: s.label, key: still.key, imageUrl: still.imageUrl },
            };
            // Verified-gating: if this side came back with furniture still
            // missing or clearly out of place after the repair loop, warn (but
            // keep the still — it's the best we have; the clip is paid). The user
            // can retry for a clean side.
            const miss = (still.checklist ?? []).filter((c) => c.status === "missing").map((c) => c.name);
            const mis = (still.checklist ?? []).filter((c) => c.status === "misplaced").map((c) => c.name);
            const sideIssues = [
              miss.length ? `missing ${miss.join(", ")}` : "",
              mis.length ? `${mis.join(", ")} out of place` : "",
            ].filter(Boolean);
            if (sideIssues.length) qualityWarnings.push(`${s.label} side: ${sideIssues.join("; ")}`);
            addVersionOnce(s.jobId, {
              id: uid("v"), label: "v1", createdAt: now(), note: s.label, styleId,
              imageUrl: still.imageUrl, imageKey: still.key,
              checklist: still.checklist, extras: still.extras,
            });
            updateRender(id, s.jobId, { status: "completed", progress: 100 });
          } catch (e) {
            return failAll(e instanceof Error ? e.message : `${s.label} view failed`);
          }
        }
      }

      // ---- 2) The orbit clip: four Veo quarter-turns between consecutive stills,
      // stitched server-side. Falls back to the legacy single-clip pan only for
      // roomless scenes (no 3D room to ground the sides in).
      const haveAllSides = !!(sideStills.right && sideStills.back && sideStills.left);

      // Cross-view consistency gate: before spending the Veo budget, confirm the
      // four photos are ONE coherent design. A drifting side (different wall
      // colour / sofa) is warned about now rather than filmed into the orbit.
      if (haveAllSides) {
        try {
          flash("Checking the four sides match…");
          const cons = await checkConsistency({
            projectId: id,
            style: displayedStyle,
            views: [
              { label: "Front", image: frontDataUri },
              { label: "Right", image: sideStills.right!.uri },
              { label: "Back", image: sideStills.back!.uri },
              { label: "Left", image: sideStills.left!.uri },
            ],
          });
          if (!cons.consistent && cons.issues.length) {
            qualityWarnings.push(`sides differ from the front (${cons.issues.slice(0, 3).join("; ")})`);
          }
        } catch {
          /* consistency check is best-effort — never blocks filming */
        }
      }
      flash(haveAllSides ? "Filming the 360° orbit (a few minutes)…" : "Generating walkthrough video (Veo)…");
      if (haveAllSides) {
        // Surface the server's real progress ("Filming 2/4…") while the segments film.
        stagePoll = setInterval(() => {
          void fetchVideoJob(videoJobId).then((j) => {
            if (j?.stage) flash(j.stage);
          });
        }, 9000);
      }
      let result: Awaited<ReturnType<typeof generateVideo>>;
      try {
        result = await generateVideo({
          projectId: id,
          image: frontDataUri,
          prompt: buildVideoPrompt(videoSpec),
          ...(haveAllSides
            ? {
                sides: {
                  front: frontDataUri,
                  right: sideStills.right!.uri,
                  back: sideStills.back!.uri,
                  left: sideStills.left!.uri,
                },
                segmentPrompts: buildSegmentPrompts(videoSpec),
                frames: sideJobs.map((s) => sideStills[s.view]!.frame),
              }
            : {}),
          // Persist the outcome server-side under the record's id so a reload
          // mid-generation can reclaim the clip (use-video-reconcile) instead
          // of losing the paid Veo output.
          jobId: videoJobId,
        });
        if (result.warning) qualityWarnings.push(result.warning);
        const warning = qualityWarnings.length ? qualityWarnings.join(" · ") : undefined;
        addVersionOnce(videoJobId, {
          id: uid("v"), label: "v1", createdAt: now(), note: "Walkthrough", styleId,
          imageUrl: result.videoUrl, imageKey: result.key,
          ...(warning ? { warning } : {}),
        });
        updateRender(id, videoJobId, { status: "completed", progress: 100 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Video failed";
        updateRender(id, videoJobId, { status: "failed", error: msg });
        failSides(msg);
        flash(msg);
        return;
      }
      // Legacy (roomless) path: the side stills come out of the clip itself.
      if (!haveAllSides) {
        const byView = new Map(result.frames.map((f) => [f.view, f]));
        for (const s of sideJobs) {
          const f = byView.get(s.view);
          if (!f) {
            updateRender(id, s.jobId, { status: "failed", error: "No frame extracted (is ffmpeg installed?)" });
            continue;
          }
          addVersionOnce(s.jobId, {
            id: uid("v"), label: "v1", createdAt: now(), note: s.label, styleId,
            imageUrl: f.imageUrl, imageKey: f.key,
          });
          updateRender(id, s.jobId, { status: "completed", progress: 100 });
        }
      }
      flash(
        qualityWarnings.length
          ? `Walkthrough ready — with a caveat: ${qualityWarnings.join(" · ")}. Retry for a cleaner orbit.`
          : "360° walkthrough + Right / Back / Left ready",
      );
    } finally {
      if (stagePoll) clearInterval(stagePoll);
      setVideoBusy(false);
    }
  };

  // Style switch: full re-render in the new style (same geometry & furniture).
  const switchStyle = async (styleId: string) => {
    if (styleId === displayedStyleId || processing) return;
    const name = STYLE_BY_ID[styleId]?.name ?? "new style";
    setProcessingLabel(`Rendering ${name}…`);
    setProcessing(true);
    setCompare(false);
    try {
      // Image-to-image from the current render keeps the room's geometry and
      // layout fixed (workflow step 25) while Nano (Gemini) restyles materials/lighting.
      const image = activeVersion?.imageUrl
        ? await fetchAsDataUrl(activeVersion.imageUrl)
        : undefined;
      // Scope the plan + items to the render's room so the prompt's exact
      // layout block describes THIS room, not the plan's largest one.
      const specRoom = render.roomId
        ? project.floorPlan?.rooms.find((r) => r.id === render.roomId)
        : undefined;
      const result = await generateRender({
        projectId: id,
        view: render.view,
        style: STYLE_BY_ID[styleId] ?? displayedStyle,
        propertyType: project.propertyType,
        plan:
          specRoom && project.floorPlan
            ? { ...project.floorPlan, rooms: [specRoom] }
            : project.floorPlan,
        items: specRoom
          ? project.placedItems.filter((it) => it.roomId === specRoom.id && !it.ghost)
          : project.placedItems,
        image,
        noFluxFallback: true, // Gemini-only — never fall back to FLUX
      });
      updateRender(id, render.id, { styleId });
      const vid = uid("v");
      addRenderVersion(id, render.id, {
        id: vid,
        label: `v${versions.length + 1}`,
        createdAt: new Date().toISOString(),
        note: `Switched to ${name}`,
        styleId,
        imageUrl: result.imageUrl,
        imageKey: result.key,
        prompt: result.prompt,
        checklist: result.checklist,
        extras: result.extras,
      });
      setActiveVersionId(vid);
      flash(`Switched to ${name}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Style render failed");
    } finally {
      setProcessing(false);
    }
  };

  const exportImage = () => {
    // With Dimensions on, the export IS the annotated deliverable (the
    // design-document finish); otherwise the clean render.
    const withDims = dims && !!annotatedUrl;
    const url = withDims ? annotatedUrl : activeVersion?.imageUrl;
    if (!url) return flash("Nothing to export yet.");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${activeVersion.label}${withDims ? "-dimensions" : ""}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    flash(withDims ? "Annotated render downloaded" : "Render downloaded");
  };

  // Panorama renders: a "walkthrough" of the room's photoreal views (arrow keys
  // to move around) by default — the AI-merged equirectangular bends on a sphere,
  // so stepping through the real angles reads far better. The 360° sphere stays
  // available as a toggle.
  if (render.view === "pano") {
    const url = activeVersion?.imageUrl;
    // The walkthrough is now an actual Veo orbit CLIP (.mp4) — play it directly.
    if (url && url.includes(".mp4")) {
      return (
        <div className="flex h-full flex-col bg-bg">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <Link href={`/projects/${id}/rooms`}>
              <Button size="sm" variant="outline" icon="ArrowLeft">Rooms</Button>
            </Link>
            <span className="text-sm font-medium">Room walkthrough</span>
            <Button size="sm" variant="ghost" icon="Download" onClick={exportImage}>Export</Button>
          </div>
          <div className="grid min-h-0 flex-1 place-items-center gap-3 p-4">
            {activeVersion?.warning && (
              <div className="flex max-w-2xl items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <span>{activeVersion.warning}</span>
              </div>
            )}
            <video
              src={url}
              controls
              autoPlay
              loop
              muted
              playsInline
              className="max-h-full max-w-full rounded-2xl border border-border shadow-2xl"
            />
          </div>
        </div>
      );
    }
    const VIEW_ORDER = ["front", "left", "right", "back", "corner", "side", "corner-back", "top"];
    const VIEW_LABEL: Record<string, string> = {
      corner: "Corner",
      "corner-back": "Back",
      front: "Front",
      side: "Side",
      left: "Left",
      right: "Right",
      back: "Back",
      top: "Top-down",
    };
    const walkViews = project.renders
      .filter((r) => r.roomId === render.roomId && r.view !== "pano" && r.status === "completed")
      .sort((a, b) => VIEW_ORDER.indexOf(a.view) - VIEW_ORDER.indexOf(b.view))
      .map((r) => ({ label: VIEW_LABEL[r.view] ?? r.view, url: r.versions.at(-1)?.imageUrl }))
      .filter((v): v is { label: string; url: string } => !!v.url);
    const showWalk = walkMode && walkViews.length > 0;
    return (
      <div className="flex h-full flex-col bg-bg">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <Link href={`/projects/${id}/rooms`}>
            <Button size="sm" variant="outline" icon="ArrowLeft">Rooms</Button>
          </Link>
          {walkViews.length > 0 ? (
            <div className="flex overflow-hidden rounded-lg border border-border text-xs">
              <button
                onClick={() => setWalkMode(true)}
                className={cn(
                  "px-2.5 py-1 cursor-pointer",
                  walkMode ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-2",
                )}
              >
                Walkthrough
              </button>
              <button
                onClick={() => setWalkMode(false)}
                className={cn(
                  "px-2.5 py-1 cursor-pointer",
                  !walkMode ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-2",
                )}
              >
                360° sphere
              </button>
            </div>
          ) : (
            <span className="text-sm font-medium">360° view</span>
          )}
          <Button size="sm" variant="ghost" icon="Download" onClick={exportImage}>Export</Button>
        </div>
        <div className="min-h-0 flex-1">
          {showWalk ? (
            <RoomWalkthrough views={walkViews} auto />
          ) : url ? (
            <Panorama360 src={url} />
          ) : (
            <div className="grid h-full place-items-center text-muted">
              <div className="text-center">
                <Icon name="Loader2" className="mx-auto mb-2 size-6 animate-spin text-accent" />
                Rendering 360°…
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Offscreen 3D scene — camera truth for the walkthrough's side stills.
          The same component the room page uses, mounted hidden so THIS page can
          capture the Right/Back/Left wall views on demand (fresh + reload-safe;
          the room page's in-memory stash is only the fallback). */}
      {render.view === "front" && annRoom && project.floorPlan && (
        <div
          aria-hidden
          className="pointer-events-none fixed left-[-10000px] top-0 h-[720px] w-[1280px]"
        >
          <Scene3D
            plan={project.floorPlan}
            items={annItems}
            style={displayedStyle}
            selectedId={null}
            onSelectItem={() => {}}
            captureRef={captureRef}
            focusRoom={{
              x: annRoom.x,
              y: annRoom.y,
              width: annRoom.width,
              height: annRoom.height,
              ceilingFt: annRoom.ceilingFt,
            }}
          />
        </div>
      )}
      {/* Stage */}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* toolbar */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={lasso ? "primary" : "outline"}
              icon="Lasso"
              onClick={() => setLasso((v) => !v)}
            >
              Lasso
            </Button>
            <Button size="sm" variant="ghost" icon="Crop" disabled={!hasMask} onClick={() => { lassoRef.current?.clear(); setHasMask(false); }}>
              Clear
            </Button>
            <div className="mx-1 h-5 w-px bg-border" />
            <Button size="sm" variant="ghost" icon="Undo2" disabled={!canUndo} onClick={() => setActiveVersionId(versions[activeIdx - 1].id)}>
              Undo
            </Button>
            <Button size="sm" variant="ghost" icon="Redo2" disabled={!canRedo} onClick={() => setActiveVersionId(versions[activeIdx + 1].id)}>
              Redo
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={dims ? "primary" : "ghost"}
              icon="Ruler"
              disabled={!dimRoom}
              onClick={() => setDims((v) => !v)}
            >
              Dimensions
            </Button>
            <Button
              size="sm"
              variant={compare ? "primary" : "ghost"}
              icon="GitCompare"
              disabled={!prevVersion?.imageUrl}
              onClick={() => setCompare((v) => !v)}
            >
              Compare
            </Button>
            <Button size="sm" variant="ghost" icon="Download" onClick={exportImage}>
              Export
            </Button>
          </div>
        </div>

        {/* canvas */}
        <div className="relative min-h-0 flex-1 p-4">
          <div className="grid h-full w-full place-items-center">
            <div
              className="relative h-full max-h-full w-auto max-w-full overflow-hidden rounded-2xl border border-border shadow-2xl"
              style={{ aspectRatio: imgAspect ?? (square ? 1 : 16 / 9) }}
            >
            {compare && prevVersion?.imageUrl && activeVersion?.imageUrl ? (
              <CompareSlider
                before={<RenderImage src={prevVersion.imageUrl} />}
                after={<RenderImage src={activeVersion.imageUrl} />}
              />
            ) : (
              <>
                {activeVersion?.imageUrl ? (
                  // The annotated composite replaces the image while Dimensions
                  // is on (hidden while lassoing — masks must map to the RAW
                  // image the edits actually operate on).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    ref={imgRef}
                    src={!lasso && dims && annotatedUrl ? annotatedUrl : activeVersion.imageUrl}
                    alt={`${render.view} render ${activeVersion.label}`}
                    crossOrigin="anonymous"
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      if (el.naturalWidth && el.naturalHeight)
                        setImgAspect(el.naturalWidth / el.naturalHeight);
                    }}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center bg-grid bg-bg text-sm text-muted">
                    No image for this version
                  </div>
                )}
                <LassoCanvas ref={lassoRef} enabled={lasso} processing={processing} onMaskChange={setHasMask} />
              </>
            )}

            {processing && (
              <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-sm">
                <div className="text-center">
                  <Icon name="Wand2" className="mx-auto mb-3 size-7 animate-pulse text-accent" />
                  <p className="text-sm font-medium">{processingLabel}</p>
                  <p className="text-xs text-muted">AI edit · usually ~20–40s</p>
                </div>
              </div>
            )}

            {lasso && !hasMask && !processing && !compare && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-muted backdrop-blur">
                Draw around the area you want to change
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Right panel */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          {/* Walkthrough video — render the Right/Back/Left sides as real photos
              first (from the room's 3D geometry, matched to this front photo),
              then film a Veo quarter-turn between each pair and stitch them into
              one seamless 360° orbit. */}
          {render.view === "front" && activeVersion?.imageUrl && (
            <section className="mb-5">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
                <Icon name="Clapperboard" className="size-4 text-accent" /> 360° walkthrough video
              </h3>
              <p className="mb-2 text-xs text-muted">
                Finish your lasso edits first. Then all four sides are rendered as real
                photos of this room (same furniture, same style) and the camera orbits
                through them — Front → Right → Back → Left — with equal time on each
                wall, ending back where it started.
              </p>
              <Button
                className="w-full"
                icon="Clapperboard"
                onClick={generateWalkthrough}
                loading={videoBusy}
                disabled={videoBusy || processing}
              >
                {videoBusy ? "Generating video…" : "Generate walkthrough video"}
              </Button>
            </section>
          )}

          {/* Furniture check — the verify loop's per-item ticks for this version:
              the render was vision-checked against the room's furniture list and
              missing pieces were repaired in place before it was stored. */}
          {activeVersion?.checklist && activeVersion.checklist.length > 0 && (
            <section className="mb-5">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
                <Icon name="ListChecks" className="size-4 text-accent" /> Furniture check
              </h3>
              <ul className="space-y-1">
                {activeVersion.checklist.map((c) => {
                  const meta: Record<string, { icon: string; cls: string; hint: string }> = {
                    present: { icon: "CircleCheck", cls: "text-success", hint: "in the render" },
                    repaired: { icon: "Wand2", cls: "text-accent", hint: "was missing — added back" },
                    missing: { icon: "CircleAlert", cls: "text-red-400", hint: "not found in the render" },
                    misplaced: { icon: "Move", cls: "text-amber-400", hint: "present but out of place" },
                    offscreen: { icon: "EyeOff", cls: "text-faint", hint: "outside this camera's frame" },
                    unchecked: { icon: "CircleDashed", cls: "text-muted", hint: "check unavailable" },
                  };
                  const m = meta[c.status] ?? meta.unchecked;
                  return (
                    <li key={c.name} className="flex items-start gap-2 text-xs">
                      <Icon name={m.icon} className={cn("mt-0.5 size-3.5 shrink-0", m.cls)} />
                      <span className="min-w-0">
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-faint">— {c.where?.trim() || m.hint}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {!!activeVersion.extras?.length && (
                <p className="mt-2 text-[11px] text-faint">
                  Not in the plan: {activeVersion.extras.join("; ")} — lasso-remove if unwanted.
                </p>
              )}
            </section>
          )}

          {/* Selective regeneration */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
              <Icon name="Lasso" className="size-4 text-accent" /> Selective edit
            </h3>
            <div
              className={cn(
                "mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
                hasMask ? "border-accent/40 bg-accent/5 text-foreground" : "border-border text-muted",
              )}
            >
              <Icon name={hasMask ? "CircleCheck" : "CircleDashed"} className={cn("size-4", hasMask && "text-accent")} />
              {hasMask ? "Region selected" : "No region — turn on Lasso and draw"}
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Describe the change, e.g. “Replace sofa with luxury leather sofa”"
              rows={3}
              className="input resize-none"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => setInstruction(p)}
                  className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-foreground cursor-pointer"
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Optional reference image to guide the change */}
            <input
              ref={refInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => onPickReference(e.target.files?.[0])}
            />
            {reference ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={reference}
                  alt="Reference"
                  className="size-12 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{refName ?? "Reference image"}</p>
                  <p className="text-[11px] text-faint">Guides this edit</p>
                </div>
                <button
                  onClick={clearReference}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-foreground cursor-pointer"
                  aria-label="Remove reference"
                >
                  <Icon name="X" className="size-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => refInputRef.current?.click()}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground cursor-pointer"
              >
                <Icon name="ImagePlus" className="size-4" /> Add reference image (optional)
              </button>
            )}

            <Button
              className="mt-3 w-full"
              icon="Wand2"
              disabled={!hasMask || processing}
              loading={processing}
              onClick={regenerate}
            >
              Regenerate selection
            </Button>
          </section>

          <div className="my-5 h-px bg-border" />

          {/* Style switching */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
              <Icon name="Palette" className="size-4 text-accent" /> Style
            </h3>
            <p className="mb-2 text-xs text-muted">Same geometry, new aesthetic — generates a fresh version.</p>
            <div className="grid grid-cols-2 gap-2">
              {STYLES.map((s) => {
                const active = s.id === displayedStyleId;
                return (
                  <button
                    key={s.id}
                    disabled={processing}
                    onClick={() => switchStyle(s.id)}
                    className={cn(
                      "overflow-hidden rounded-lg border text-left transition-colors disabled:opacity-60 cursor-pointer",
                      active ? "border-accent/60 ring-1 ring-accent/40" : "border-border hover:border-border-strong",
                    )}
                  >
                    <div className="flex h-6">
                      {s.palette.map((c, i) => (
                        <div key={i} className="flex-1" style={{ background: c }} />
                      ))}
                    </div>
                    <div className="truncate px-2 py-1.5 text-[11px] font-medium">{s.name}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="my-5 h-px bg-border" />

          {/* Version history */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted">
              <Icon name="History" className="size-4 text-accent" /> Versions · {versions.length}
            </h3>
            <div className="space-y-1.5">
              {[...versions].reverse().map((v) => {
                const active = v.id === effectiveVersionId;
                return (
                  <button
                    key={v.id}
                    onClick={() => setActiveVersionId(v.id)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer",
                      active ? "border-accent/50 bg-accent/5" : "border-border hover:bg-surface-2",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold",
                        active ? "bg-accent text-accent-foreground" : "bg-surface-3 text-muted",
                      )}
                    >
                      {v.label}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{v.note}</span>
                      <span className="block text-xs text-faint">{timeAgo(v.createdAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </aside>

      {/* toast */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-fade-up rounded-full border border-border bg-surface-3 px-4 py-2 text-sm shadow-2xl">
          <span className="flex items-center gap-2">
            <Icon name="CircleCheck" className="size-4 text-success" />
            {toast}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Fetch a (same-origin) render image and return it as a PNG/JPEG data URI so it
 * can be fed back to FLUX as an image-to-image init. Best-effort: returns
 * undefined on any failure, letting the caller fall back to text-to-image.
 */
async function fetchAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

function RenderImage({ src }: { src: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" crossOrigin="anonymous" className="absolute inset-0 h-full w-full object-cover" />
  );
}

function CompareSlider({ before, after }: { before: React.ReactNode; after: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const dragging = useRef(false);

  const move = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPct(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 select-none"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      style={{ cursor: "ew-resize" }}
    >
      {/* before (full) */}
      <div className="absolute inset-0">{before}</div>
      {/* after (clipped) */}
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
        {after}
      </div>
      {/* labels */}
      <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2 py-0.5 text-[11px] backdrop-blur">Before</span>
      <span className="absolute right-3 top-3 rounded-full bg-black/70 px-2 py-0.5 text-[11px] backdrop-blur">After</span>
      {/* handle */}
      <div className="absolute inset-y-0 w-0.5 bg-accent" style={{ left: `${pct}%` }}>
        <div className="absolute top-1/2 left-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-accent bg-surface-3 shadow-lg">
          <Icon name="GitCompare" className="size-4 text-accent" />
        </div>
      </div>
    </div>
  );
}
