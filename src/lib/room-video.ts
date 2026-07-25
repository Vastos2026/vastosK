/**
 * Client-side helpers for the room "walkthrough video" step.
 *
 * After the user finishes lasso-editing the FRONT photo, that photo is turned into
 * a Google Veo orbit clip; the browser then extracts Front/Left/Right/Back stills
 * from the clip (via <video>+canvas — the clip is served same-origin so the canvas
 * isn't tainted). Because the clip is ONE coherent generation, every frame is the
 * SAME room → the angles are guaranteed consistent.
 */

import type { RoomSpec, SpecFurniture } from "./room-spec";

/**
 * Veo video prompt — ONE CONTINUOUS TRIPOD PAN, no cuts.
 *
 * The previous "four static frames with hard cuts" prompt hallucinated: Veo
 * anchors only the FIRST frame to the uploaded photo, and every hard cut starts
 * a fresh scene the model re-imagines from text — so Back/Left/Right came out
 * as four DIFFERENT bedrooms (each with its own feature wall and a bed facing
 * the camera). A continuous rotation fixes this structurally: with unbroken
 * temporal continuity the same room must carry through the whole clip as the
 * camera turns past it — the model can't restart the scene mid-shot.
 *
 * The rotation runs CLOCKWISE at constant speed (8s = 360°): 0s FRONT →
 * 2s RIGHT → 4s BACK → 6s LEFT → 8s FRONT again. The Left/Right/Back stills
 * are sampled from the clip at those quarter-turn timestamps.
 */
export const VIDEO_PROMPT = `The video must begin with the **uploaded photograph exactly as its first frame** — the same room, same furniture, same materials, same lighting, same camera, unchanged.

From that exact starting view, rotate the camera **IN PLACE** — a smooth tripod pan to the **RIGHT (clockwise)** at a perfectly **CONSTANT angular speed** — through a **full 360° turn**, ending back on the exact starting view in the final frame.

The camera position **never moves**: no walking, no dolly, no zoom, no tilt, no height change, no framing change. **Only the viewing direction rotates** about the vertical axis, at eye level, keeping the exact same lens, focal length, field of view, exposure and white balance throughout.

Timing at constant speed over the 8-second clip:

* **0s:** facing the **FRONT wall** — the uploaded view, exactly.
* **2s:** facing the **RIGHT wall** (90° clockwise from the front).
* **4s:** facing the **BACK wall** (180° — directly opposite the front view).
* **6s:** facing the **LEFT wall** (270°).
* **8s:** facing the **FRONT wall** again (full 360°, matching the first frame).

This is **ONE continuous shot of ONE real, physically consistent room**. There must be:

* **No cuts, no scene changes, no transitions, no fades**
* **No morphing** — walls, furniture and openings stay rigidly in place as the camera turns past them
* **No re-imagining** — the room seen at 8 seconds is the identical room seen at 0 seconds
* **No objects added, removed, moved or restyled at any point of the rotation**

Use **only the uploaded image** as the source of truth for the room's style, materials, colors and lighting. Do **not** invent, modify, redesign, enhance, replace, or hallucinate any architectural elements, furniture, décor, textures, colors, materials, lighting, dimensions, or objects. Every wall the camera reveals during the turn belongs to the same room the uploaded photo shows — one coherent space photographed by one slowly rotating camera.

The result must look like a **single professional architectural walkthrough pan**: photoreal, stable verticals, constant exposure, zero flicker.`;

// The 3D capture cameras (scene-3d `cameraFor`) fix the view→wall mapping: the
// FRONT photo faces the room's NORTH wall as drawn on the 2D plan, so LEFT =
// west, RIGHT = east, BACK = south. The ground-truth block relies on this.
const VIEW_WALLS: { view: string; wall: "north" | "west" | "east" | "south" }[] = [
  { view: "FRONT", wall: "north" },
  { view: "LEFT", wall: "west" },
  { view: "RIGHT", wall: "east" },
  { view: "BACK", wall: "south" },
];

/** Clearance (ft) between a piece and each wall of the room. */
function clearances(spec: RoomSpec, f: SpecFurniture) {
  return {
    north: f.fromNorthFt,
    west: f.fromWestFt,
    east: spec.widthFt - (f.fromWestFt + f.widthFt),
    south: spec.depthFt - (f.fromNorthFt + f.depthFt),
  };
}

/**
 * The room's REAL wall-by-wall inventory, from the reviewed plan. This is what
 * stops the unseen walls from being hallucinated: instead of "infer
 * conservatively", Veo is told exactly which furniture, doors and windows exist
 * on each of the four walls — and that anything unlisted does not exist.
 */
export function roomGroundTruth(spec: RoomSpec): string {
  const NEAR = 1.2; // ft — a piece this close to a wall reads as standing on it
  const ends: Record<"north" | "south" | "west" | "east", string> = {
    north: "west",
    south: "west",
    west: "north",
    east: "north",
  };

  const lines: string[] = [
    `ROOM GROUND TRUTH — the room in the uploaded image is the ${spec.room.toLowerCase()}, ` +
      `exactly ${spec.widthFt} ft wide × ${spec.depthFt} ft deep with a ${spec.ceilingFt} ft ceiling. ` +
      `The uploaded image faces the FRONT wall. The floor plan says PRECISELY what the camera ` +
      `passes as it rotates — each wall must show exactly this and NOTHING else:`,
  ];

  const freestanding: string[] = [];
  const byWall = new Map<string, string[]>(VIEW_WALLS.map((v) => [v.wall, []]));
  for (const f of spec.furniture) {
    const c = clearances(spec, f);
    const near = VIEW_WALLS.filter((v) => c[v.wall] <= NEAR);
    const desc = `${f.name} (${f.widthFt}×${f.depthFt} ft, ${f.heightFt} ft high)`;
    if (near.length === 0) {
      freestanding.push(
        `${desc} standing ${f.fromWestFt} ft from the west wall and ${f.fromNorthFt} ft from the north wall`,
      );
    } else {
      for (const v of near) byWall.get(v.wall)!.push(desc);
    }
  }
  for (const d of spec.doors) {
    byWall
      .get(d.wall)!
      .push(`a door (~${d.lengthFt} ft opening) centred ${d.offsetFt} ft from the wall's ${ends[d.wall]} end`);
  }
  for (const w of spec.windows) {
    byWall
      .get(w.wall)!
      .push(`a window ${w.lengthFt} ft wide centred ${w.offsetFt} ft from the wall's ${ends[w.wall]} end`);
  }

  for (const v of VIEW_WALLS) {
    const items = byWall.get(v.wall)!;
    lines.push(
      `* **${v.view} wall**: ${items.length ? items.join("; ") : "a plain finished wall with skirting — no furniture, no door, no window"}.`,
    );
  }
  if (freestanding.length) {
    lines.push(`* **Free-standing (away from the walls)**: ${freestanding.join("; ")}.`);
  }
  lines.push(
    `Anything NOT listed above does not exist in this room. Do not add any furniture, door, ` +
      `window, TV, artwork, mirror, plant, rug or décor beyond this list — a wall with nothing ` +
      `listed stays a plain wall. Every listed piece keeps its stated size and position in every view. ` +
      `Each piece exists exactly ONCE, on its stated wall only — NEVER repeat the front wall's ` +
      `furniture, TV or media wall on any other wall as the camera turns.`,
  );
  return lines.join("\n");
}

/**
 * The full Veo prompt for a room: the continuous-rotation instructions grounded
 * by the room's real wall-by-wall inventory. Falls back to the bare
 * instructions when no spec is available (roomless renders).
 */
export function buildVideoPrompt(spec?: RoomSpec | null): string {
  return spec ? `${VIDEO_PROMPT}\n\n${roomGroundTruth(spec)}` : VIDEO_PROMPT;
}

/**
 * The 360° orbit as FOUR quarter-turn segments, in clockwise order. Each segment
 * is a separate Veo generation pinned to a real photo at BOTH ends (first frame =
 * this view's still, last frame = the next view's still), so Veo only fills the
 * 90° turn between two grounded images instead of inventing the unseen walls —
 * the structural fix for "furniture disappears / back side never shown": every
 * wall is a real endpoint the clip MUST pass through, each for equal time.
 */
export const ORBIT_SEGMENTS: { from: "front" | "right" | "back" | "left"; to: "front" | "right" | "back" | "left" }[] = [
  { from: "front", to: "right" },
  { from: "right", to: "back" },
  { from: "back", to: "left" },
  { from: "left", to: "front" },
];

const SEGMENT_WALL: Record<"front" | "right" | "back" | "left", string> = {
  front: "FRONT wall",
  right: "RIGHT wall (90° clockwise from the front)",
  back: "BACK wall (directly opposite the front)",
  left: "LEFT wall (90° counter-clockwise from the front)",
};

/** Veo prompt for ONE quarter-turn segment of the orbit (first→last frame pinned). */
export function buildSegmentPrompt(
  seg: { from: "front" | "right" | "back" | "left"; to: "front" | "right" | "back" | "left" },
  spec?: RoomSpec | null,
): string {
  const core = `Two photographs of the SAME real room are provided: the clip's **first frame** is the first photo (camera facing the ${SEGMENT_WALL[seg.from]}) and its **last frame** is the second photo (camera facing the ${SEGMENT_WALL[seg.to]}, exactly 90° clockwise from the start).

Film ONE continuous, smooth camera move between them: a steady **clockwise** turn at **constant speed** inside the room, at eye level — no walking towards anything, no zoom, no tilt, no height change. The clip starts EXACTLY on the first photo and ends EXACTLY on the second photo.

This is one unbroken shot of one physically consistent room:
* **No cuts, no fades, no scene changes**
* **No morphing** — walls, furniture and openings stay rigidly in place as the camera turns past them
* **Nothing appears, disappears, moves or is restyled** at any point — every object visible in either photo keeps its exact position, size, colours and materials
* The corner passed between the two walls belongs to the same room; show only what the room ground truth lists there

Photoreal, stable verticals, constant exposure and white balance, zero flicker — a professional architectural walkthrough pan.`;
  return spec ? `${core}\n\n${roomGroundTruth(spec)}` : core;
}

/** Prompts for all four orbit segments, in clockwise order. */
export function buildSegmentPrompts(spec?: RoomSpec | null): string[] {
  return ORBIT_SEGMENTS.map((seg) => buildSegmentPrompt(seg, spec));
}

// The clip rotates CLOCKWISE at constant speed (0s front → 2s right → 4s back →
// 6s left → 8s front again), so the wall stills are sampled at the quarter
// turns. Front is the base photo (not from the video).
export interface FrameSample {
  view: "left" | "right" | "back";
  label: string;
  at: number;
}
export const FRAME_SAMPLES: FrameSample[] = [
  { view: "right", label: "Right", at: 0.25 }, // 90° clockwise = the east wall
  { view: "back", label: "Back", at: 0.5 }, // 180° = the south wall
  { view: "left", label: "Left", at: 0.75 }, // 270° = the west wall
];

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

/**
 * Extract still frames (JPEG data URIs) from a same-origin video at the given
 * duration fractions. Resolves in the same order as `fractions`.
 *
 * CRUCIAL: after seeking we wait for the new frame to actually be PRESENTED
 * (`requestVideoFrameCallback`) before drawing — drawing immediately on `seeked`
 * grabbed a stale frame, so every extracted still came out identical (the bug).
 */
export function extractVideoFrames(videoUrl: string, fractions: number[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video") as FrameCallbackVideo;
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = videoUrl;
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

    const seek = (t: number) =>
      new Promise<void>((res) => {
        const onSeeked = () => {
          v.removeEventListener("seeked", onSeeked);
          res();
        };
        v.addEventListener("seeked", onSeeked);
        v.currentTime = t;
      });

    // Wait until a frame for the current time is actually painted. rVFC fires when a
    // new frame is presented; race it with a timeout so it can't hang if unsupported.
    const waitForFrame = () =>
      new Promise<void>((res) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            res();
          }
        };
        if (typeof v.requestVideoFrameCallback === "function") {
          v.requestVideoFrameCallback(() => finish());
        }
        setTimeout(finish, 280);
      });

    const run = async () => {
      try {
        const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 8;
        const canvas = document.createElement("canvas");
        const out: string[] = [];
        for (const f of fractions) {
          await seek(clamp(f * dur, 0, Math.max(0, dur - 0.05)));
          await waitForFrame();
          canvas.width = v.videoWidth || 1280;
          canvas.height = v.videoHeight || 720;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no canvas context");
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.92));
        }
        resolve(out);
      } catch (e) {
        reject(e);
      }
    };

    v.onloadeddata = () => void run();
    v.onerror = () => reject(new Error("could not load the video for frame extraction"));
  });
}

/** Fetch a same-origin image/video URL and return it as a data URI. */
export async function urlToDataUri(url: string): Promise<string | undefined> {
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
