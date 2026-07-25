/**
 * Server-side video frame extraction via the bundled ffmpeg binary
 * (`ffmpeg-static` — no system install needed). Used to pull the Left/Right/Back
 * stills out of the Veo walkthrough clip: frame-perfect, fast, and free of the
 * browser `<video>`+canvas timing quirks (which once produced identical frames).
 *
 * Node runtime only (spawns a child process) — the render route is `runtime:"nodejs"`.
 */

import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function ffmpegAvailable(): boolean {
  return !!ffmpegPath;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not found"));
    const p = spawn(ffmpegPath, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`)),
    );
  });
}

/** Parse the clip's duration (seconds) from ffmpeg's stderr; defaults to 8. */
function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(8);
    const p = spawn(ffmpegPath, ["-i", file]);
    let e = "";
    p.stderr.on("data", (d) => (e += d.toString()));
    p.on("error", () => resolve(8));
    p.on("close", () => {
      const m = e.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 8);
    });
  });
}

/**
 * Assemble still frames into a HARD-CUT slideshow mp4 — each frame held for
 * `secondsEach` seconds, instant cuts between them, no motion. This is how we get a
 * "video that waits 2 seconds on each angle": stills stitched together, NOT a video
 * model trying (and failing) to hold still. Frames are scaled/padded to a uniform
 * 1280×720 so they concatenate cleanly.
 */
export async function assembleSlideshow(frames: Buffer[], secondsEach = 2): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available");
  if (!frames.length) throw new Error("no frames to assemble");
  const dir = await mkdtemp(path.join(os.tmpdir(), "veo-slideshow-"));
  try {
    // Normalise every frame to the same size (concat requires identical dimensions).
    const scaled: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const raw = path.join(dir, `raw_${i}.jpg`);
      await writeFile(raw, frames[i]);
      const out = path.join(dir, `s_${i}.jpg`);
      await run([
        "-i", raw,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
        "-y", out,
      ]);
      scaled.push(out);
    }
    // concat demuxer list: each frame held `secondsEach`; last entry repeated (a
    // documented concat quirk so the final frame gets its full duration).
    const fwd = (p: string) => p.replace(/\\/g, "/");
    let list = "";
    for (const f of scaled) list += `file '${fwd(f)}'\nduration ${secondsEach}\n`;
    list += `file '${fwd(scaled[scaled.length - 1])}'\n`;
    const listPath = path.join(dir, "list.txt");
    await writeFile(listPath, list);

    const outMp4 = path.join(dir, "slideshow.mp4");
    await run([
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-vsync", "vfr", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart",
      "-y", outMp4,
    ]);
    return await readFile(outMp4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Trim a clip to exactly `seconds` from its start. Veo's shortest supported
 * duration is 4s (no 3s option), so the walkthrough (revamp Workstream 8.5 —
 * every clip must be exactly 3 seconds) requests the model's minimum and trims
 * here rather than depending on the API to honor an unsupported duration.
 */
export async function trimVideo(clip: Buffer, seconds: number): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available");
  const dir = await mkdtemp(path.join(os.tmpdir(), "veo-trim-"));
  try {
    const raw = path.join(dir, "raw.mp4");
    await writeFile(raw, clip);
    const out = path.join(dir, "trimmed.mp4");
    await run([
      "-i", raw,
      "-t", seconds.toFixed(2),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
      "-y", out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Concatenate mp4 clips into ONE seamless video, in order. Every input is
 * normalised to 1280×720/24fps first (Veo segments are already uniform, but the
 * concat demuxer hard-fails on any mismatch — a $10 walkthrough must not die on
 * a stray resolution), then joined with a single re-encode.
 */
export async function concatVideos(clips: Buffer[]): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available");
  if (!clips.length) throw new Error("no clips to concatenate");
  const dir = await mkdtemp(path.join(os.tmpdir(), "veo-concat-"));
  try {
    const norm: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const raw = path.join(dir, `raw_${i}.mp4`);
      await writeFile(raw, clips[i]);
      const out = path.join(dir, `n_${i}.mp4`);
      await run([
        "-i", raw,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast",
        "-y", out,
      ]);
      norm.push(out);
    }
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const listPath = path.join(dir, "list.txt");
    await writeFile(listPath, norm.map((f) => `file '${fwd(f)}'`).join("\n"));
    const outMp4 = path.join(dir, "joined.mp4");
    await run([
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c:v", "copy", "-movflags", "+faststart",
      "-y", outMp4,
    ]);
    return await readFile(outMp4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Extract one JPEG frame per fraction (0..1 of the clip's duration), in order.
 * Returns the JPEG buffers. Throws if ffmpeg is unavailable.
 */
export async function extractFramesFromVideo(
  video: Buffer,
  fractions: number[],
): Promise<Buffer[]> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available");
  const dir = await mkdtemp(path.join(os.tmpdir(), "veo-frames-"));
  try {
    const vid = path.join(dir, "clip.mp4");
    await writeFile(vid, video);
    const dur = await probeDuration(vid);
    const out: Buffer[] = [];
    for (let i = 0; i < fractions.length; i++) {
      const t = Math.max(0, Math.min(dur - 0.1, fractions[i] * dur));
      const outPath = path.join(dir, `frame_${i}.jpg`);
      // -ss before -i = fast seek; -frames:v 1 = a single frame; -q:v 3 = high quality.
      await run(["-ss", t.toFixed(2), "-i", vid, "-frames:v", "1", "-q:v", "3", "-y", outPath]);
      out.push(await readFile(outPath));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
