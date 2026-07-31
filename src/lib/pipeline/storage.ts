/**
 * Storage stage — the "AWS S3" box.
 *
 * Stores the uploaded floor plan and lets later stages read it back by key.
 * Two S3-API-compatible remote backends are supported, both through the same
 * @aws-sdk/client-s3 package — just pointed at different endpoints/creds:
 *   - Cloudflare R2 (preferred): zero egress/bandwidth fees, which matters
 *     for this app's video walkthrough downloads/playback. Also simpler and
 *     cheaper than Cloudinary (~$89/mo minimum for video) or Cloudflare
 *     Images+Stream (per-image/per-minute tiers) at this app's expected
 *     ~100-1000 images+videos/month volume — plain storage + minimal request
 *     costs, no per-unit fee tiers.
 *   - Plain AWS S3: kept working unchanged for any deployment that still
 *     uses it.
 * When neither is configured, transparently falls back to a local temp dir
 * so the whole pipeline runs with zero cloud setup. R2 takes priority over
 * S3 when both happen to be configured. The chosen backend is reported so
 * the UI can show which one ran.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { StorageRef } from "./types";

const BUCKET = process.env.S3_BUCKET?.trim();
const REGION = process.env.AWS_REGION?.trim() || "us-east-1";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID?.trim();
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID?.trim();
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY?.trim();
const R2_BUCKET = process.env.R2_BUCKET?.trim();

/** Cloudflare R2 — preferred remote backend, see file header for why. */
export const r2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

/** Plain AWS S3 — only actually used when R2 isn't configured (R2 wins ties). */
export const s3Enabled =
  !r2Enabled &&
  !!(BUCKET && process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());

const LOCAL_DIR = join(tmpdir(), "vasto-uploads");

// Lazily construct each client so the SDK is only loaded when actually used,
// and so an unconfigured backend never pays for a client it doesn't need.
let _s3Client: S3Client | null = null;
async function s3Client(): Promise<S3Client> {
  if (_s3Client) return _s3Client;
  const { S3Client: Ctor } = await import("@aws-sdk/client-s3");
  _s3Client = new Ctor({ region: REGION });
  return _s3Client;
}

let _r2Client: S3Client | null = null;
async function r2Client(): Promise<S3Client> {
  if (_r2Client) return _r2Client;
  const { S3Client: Ctor } = await import("@aws-sdk/client-s3");
  // R2's S3-compatible endpoint is per-account, not per-region — AWS SDK
  // credential/region resolution is bypassed entirely in favor of explicit
  // values, and R2's own convention is `region: "auto"` (there's no real
  // region to pick since the endpoint already pins the account).
  _r2Client = new Ctor({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
  });
  return _r2Client;
}

/**
 * Flatten an object key (which contains "/") into a safe local filename.
 * Both "/" and "\" are flattened (Windows honors "\" as a path separator
 * too, so leaving it alone would let a key escape LOCAL_DIR via path.join's
 * normalization), and any ".." sequence is stripped so no key can traverse
 * out of LOCAL_DIR regardless of separator style.
 */
const localPath = (key: string) =>
  join(LOCAL_DIR, key.replace(/[\\/]/g, "_").replace(/\.\./g, "_"));

export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<StorageRef> {
  if (r2Enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await r2Client();
    await c.send(
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, ContentType: contentType }),
    );
    // R2 is S3-API-compatible, not a distinct StorageRef.backend variant —
    // reported as "s3" like plain S3 (see pipeline/types.ts's StorageRef).
    return { key, backend: "s3" };
  }
  if (s3Enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Client();
    await c.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: contentType }),
    );
    return { key, backend: "s3" };
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(localPath(key), bytes);
  return { key, backend: "local" };
}

export async function getObject(key: string): Promise<Buffer> {
  if (r2Enabled) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await r2Client();
    const out = await c.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  if (s3Enabled) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Client();
    const out = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(localPath(key));
}

/**
 * Bytes served back to the browser (`/api/render`, the public `/api/s/[token]/asset`
 * proxy) always come from the same key convention here, so both routes should
 * agree on the content type they report — kept in one place after the two
 * copies had already drifted (one checked only ".jpg", the other ".jpg"/".jpeg").
 */
export function servedStorageResponse(bytes: Buffer, key: string): Response {
  const contentType = key.endsWith(".mp4")
    ? "video/mp4"
    : key.endsWith(".jpg") || key.endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
