/**
 * Storage stage — the "AWS S3" box.
 *
 * Stores the uploaded floor plan and lets later stages read it back by key.
 * Uses real S3 when AWS env vars are present; otherwise transparently falls
 * back to a local temp dir so the whole pipeline runs with zero cloud setup.
 * The chosen backend is reported so the UI can show which one ran.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { StorageRef } from "./types";

const BUCKET = process.env.S3_BUCKET?.trim();
const REGION = process.env.AWS_REGION?.trim() || "us-east-1";

export const s3Enabled = !!(
  BUCKET &&
  process.env.AWS_ACCESS_KEY_ID?.trim() &&
  process.env.AWS_SECRET_ACCESS_KEY?.trim()
);

const LOCAL_DIR = join(tmpdir(), "vasto-uploads");

// Lazily construct the S3 client so the SDK is only loaded when actually used.
let _client: S3Client | null = null;
async function client(): Promise<S3Client> {
  if (_client) return _client;
  const { S3Client: Ctor } = await import("@aws-sdk/client-s3");
  _client = new Ctor({ region: REGION });
  return _client;
}

/** Flatten an object key (which contains "/") into a safe local filename. */
const localPath = (key: string) => join(LOCAL_DIR, key.split("/").join("_"));

export async function putObject(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<StorageRef> {
  if (s3Enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await client();
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
  if (s3Enabled) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await client();
    const out = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(localPath(key));
}
