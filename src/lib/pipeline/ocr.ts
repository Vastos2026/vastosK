/**
 * OCR Extraction stage.
 *
 * Uses Gemini *vision* purely as an OCR engine: transcribe the text printed on
 * the plan (room names, dimension labels, scale bars, annotations, raw
 * measurements) with a coarse category and approximate position. No layout
 * reasoning happens here — that is the next stage (semantic.ts). Degrades to an
 * empty result (the pipeline then proceeds on geometry alone) when Gemini is
 * not configured.
 */

import { generateJson, type GeminiPart } from "./gemini-client";
import { downscaleForGemini } from "./image-utils";
import type { OcrResult, OcrToken } from "./types";

const PROMPT = `You are an OCR engine for architectural floor plans.
Transcribe ONLY text actually printed on the image — never invent or infer text.
For each readable token return:
- "text": the exact string
- "category": one of "room_name","dimension","scale","annotation","measurement","other"
- "bbox": approximate {x,y,w,h} in normalized 0..1 image coordinates (top-left origin)
Return JSON: { "tokens": [ ... ] }. If nothing is readable, return { "tokens": [] }.`;

const CATEGORIES = new Set<OcrToken["category"]>([
  "room_name",
  "dimension",
  "scale",
  "annotation",
  "measurement",
  "other",
]);

interface RawOcr {
  tokens?: {
    text?: string;
    category?: string;
    bbox?: { x?: number; y?: number; w?: number; h?: number };
  }[];
}

// Constrained-decoding schema: keeps the transcription from drifting into the
// degenerate repetition loop JSON mode is prone to on vision reads (observed as
// a ~64k-char MAX_TOKENS blowup that read as "0 labels" on a text-dense plan).
const OCR_SCHEMA = {
  type: "OBJECT",
  properties: {
    tokens: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          category: {
            type: "STRING",
            enum: ["room_name", "dimension", "scale", "annotation", "measurement", "other"],
          },
          bbox: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              w: { type: "NUMBER" },
              h: { type: "NUMBER" },
            },
          },
        },
        required: ["text"],
        propertyOrdering: ["text", "category", "bbox"],
      },
    },
  },
  required: ["tokens"],
} as const;

export async function extractText(bytes: Buffer, _mimeType: string): Promise<OcrResult> {
  const img = await downscaleForGemini(bytes);
  const parts: GeminiPart[] = [
    { inlineData: { mimeType: img.mimeType, data: img.data } },
    { text: PROMPT },
  ];

  const raw = await generateJson<RawOcr>(parts, {
    temperature: 0,
    thinkingBudget: 0,
    maxOutputTokens: 16384,
    responseSchema: OCR_SCHEMA,
  });
  if (!raw?.tokens?.length) {
    // raw === null → Gemini unavailable; raw with no tokens → nothing readable.
    return { tokens: [], rawText: "", source: raw ? "gemini-vision" : "none" };
  }

  const tokens: OcrToken[] = raw.tokens
    .filter((t) => !!t?.text?.trim())
    .map((t) => ({
      text: t.text!.trim(),
      category: (CATEGORIES.has(t.category as OcrToken["category"])
        ? t.category
        : "other") as OcrToken["category"],
      bbox: t.bbox
        ? {
            x: clamp01(t.bbox.x),
            y: clamp01(t.bbox.y),
            w: clamp01(t.bbox.w),
            h: clamp01(t.bbox.h),
          }
        : undefined,
    }));

  return { tokens, rawText: tokens.map((t) => t.text).join(" "), source: "gemini-vision" };
}

function clamp01(n: number | undefined): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
