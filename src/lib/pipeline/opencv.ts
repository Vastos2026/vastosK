/**
 * OpenCV Analysis stage.
 *
 * Spawns the Python detector (`scripts/parse_plan.py`, unchanged) which returns
 * pixel-space walls, doors, windows and room boxes. This stage knows nothing
 * about scale or room names — it is purely geometry. Scale (feet/pixel) and
 * semantics are applied afterwards by the Merge Engine.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { DetectedGeometry } from "@/lib/types";

const PYTHON_BIN = process.env.PYTHON_BIN || "python";

// DETECTOR=labeled swaps the contour detector for the label-anchored one
// (detect_rooms_labeled.py): it reads the plan's printed room labels locally
// (easyocr) and grows exactly one named room per label out to the walls — same
// JSON contract, plus `name`/`type` per room. Defaults to the original detector.
const SCRIPT = join(
  process.cwd(),
  "scripts",
  process.env.DETECTOR === "labeled" ? "detect_rooms_labeled.py" : "parse_plan.py",
);

/** Pixel-space detection plus the detector's self-reported confidence. */
export interface OpenCvResult extends DetectedGeometry {
  confidence: number;
}

// The Python script emits everything except `scale` (resolved in the merge).
interface PyResult extends Omit<DetectedGeometry, "scale"> {
  buildingBox?: DetectedGeometry["buildingBox"];
  wallThicknessPx?: number;
  scaleFtPerPx?: number;
  overallWidthFt?: number;
  overallHeightFt?: number;
  style?: string;
  confidence?: number;
  error?: string;
}

function runPython(imagePath: string): Promise<PyResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, imagePath]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) =>
      reject(new Error(`Failed to start Python (${PYTHON_BIN}): ${e.message}`)),
    );
    proc.on("close", (code) => {
      const lastLine = out.trim().split("\n").pop();
      if (!lastLine) {
        // No stdout at all — e.g. PYTHON_BIN resolves to a stub (Windows Store
        // alias), a missing dependency (cv2/numpy) crashed before the script's
        // own try/except, or the process was killed. Surface stderr (the real
        // diagnostic) instead of silently treating this as an empty-but-valid
        // detection result, which used to reach merge.ts as `rooms: undefined`.
        reject(new Error(`Python produced no output (exit ${code}): ${err || "no stderr"}`));
        return;
      }
      let parsed: PyResult;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        reject(new Error(`Python output not JSON (exit ${code}): ${err || out}`));
        return;
      }
      if (parsed.error) {
        reject(new Error(parsed.error));
        return;
      }
      if (!Array.isArray(parsed.rooms) || !Array.isArray(parsed.walls) ||
        !Array.isArray(parsed.doors) || !Array.isArray(parsed.windows)) {
        reject(new Error(`Python output missing rooms/walls/doors/windows arrays (exit ${code}): ${lastLine}`));
        return;
      }
      resolve(parsed);
    });
  });
}

/** Run OpenCV detection on raw image bytes; returns pixel-space geometry. */
export async function detectGeometry(bytes: Buffer, fileName: string): Promise<OpenCvResult> {
  const dir = await mkdtemp(join(tmpdir(), "vasto-plan-"));
  const ext = fileName.split(".").pop() || "png";
  const imagePath = join(dir, `plan.${ext}`);
  try {
    await writeFile(imagePath, bytes);
    const g = await runPython(imagePath);
    return {
      imageWidth: g.imageWidth,
      imageHeight: g.imageHeight,
      walls: g.walls,
      doors: g.doors,
      windows: g.windows,
      rooms: g.rooms,
      buildingBox: g.buildingBox,
      wallThicknessPx: g.wallThicknessPx,
      scale: 0, // resolved by the Merge Engine
      scaleFtPerPx: g.scaleFtPerPx,
      overallWidthFt: g.overallWidthFt,
      overallHeightFt: g.overallHeightFt,
      style: g.style,
      confidence: g.confidence ?? 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * No-op geometry: skips the Python subprocess entirely (no walls/doors/
 * windows/room boxes), keeping only the image's real pixel dimensions (read
 * via `sharp`, already a dependency — no OpenCV/Python involved). Used when
 * `DETECTION_MODE=gemini` (see pipeline.ts): with zero detected room boxes,
 * the Merge Engine's existing under-segmentation fallback (merge.ts,
 * `buildFromSemanticOnly`) kicks in automatically and builds the plan purely
 * from Gemini's vision reconstruction — this doesn't need its own merge
 * logic, it rides the same fallback already used when OpenCV finds too few
 * rooms. This is what makes a Python-free deploy possible (the plan's
 * "Gemini-only unlocks plain Vercel" hosting note) and lets a dev with a
 * broken local Python still exercise the pipeline.
 */
export async function emptyGeometry(bytes: Buffer): Promise<OpenCvResult> {
  let imageWidth = 1024;
  let imageHeight = 1024;
  try {
    const meta = await sharp(bytes).metadata();
    if (meta.width && meta.height) {
      imageWidth = meta.width;
      imageHeight = meta.height;
    }
  } catch {
    /* fall back to the placeholder dimensions above */
  }
  return {
    imageWidth,
    imageHeight,
    walls: [],
    doors: [],
    windows: [],
    rooms: [],
    scale: 0,
    confidence: 0,
  };
}
