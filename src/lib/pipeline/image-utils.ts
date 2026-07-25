/**
 * Shrink an uploaded plan before sending it to Gemini. Full-resolution CAD
 * exports (e.g. 2720×3440) make a multi-MB base64 payload that is slow to
 * upload and prone to dropped connections ("fetch failed"); a ~1280px JPEG is a
 * fraction of the size and Gemini still reads the room labels + dimensions fine.
 * Falls back to the original bytes if sharp can't process them.
 */

import sharp from "sharp";

export interface InlineImage {
  data: string; // base64
  mimeType: string;
}

export async function downscaleForGemini(bytes: Buffer, maxDim = 1280): Promise<InlineImage> {
  try {
    const out = await sharp(bytes)
      .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { data: out.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return { data: bytes.toString("base64"), mimeType: "image/png" };
  }
}
