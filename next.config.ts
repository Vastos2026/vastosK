import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / binary-bundling modules used server-side. Mark them external so
  // Next/Turbopack loads them from node_modules at runtime rather than bundling
  // them — bundling breaks sharp (native .node) and ffmpeg-static (its exported
  // path to the ffmpeg binary is computed relative to its own file, which the
  // bundler rewrites, so frame extraction silently failed and fell back).
  //
  // package.json's `sharp` MUST stay within the range Next.js itself declares
  // as ITS OWN optional peer dependency (currently ^0.34.5, per this Next
  // version's own package.json) — otherwise npm installs TWO separate sharp
  // copies (root + nested under next/node_modules), each pulling a different
  // native libvips .so. That mismatch is the confirmed cause of a Vercel
  // runtime crash: "ERR_DLOPEN_FAILED: libvips-cpp.so.X.Y.Z cannot open
  // shared object file" — build succeeds (nothing dlopens sharp during build),
  // only the first API-route request that actually calls sharp fails.
  // Reproduced locally 2026-08-01: sharp 0.35.1 (root) + sharp 0.34.5 (nested
  // under next, Next 16.2.9's own peer) → two conflicting libvips versions in
  // the lockfile; corroborated by lovell/sharp#4567 (identical error, same
  // Next 16 + Turbopack + Vercel combo, confirmed 0.34.4 works / 0.35.3
  // doesn't). Fix: pin `sharp` to satisfy Next's own range so npm dedupes to
  // ONE shared install — don't bump past it without also checking Next's own
  // declared sharp peer version in node_modules/next/package.json first.
  serverExternalPackages: ["sharp", "ffmpeg-static"],
  // Pin the workspace root to this directory — without it, Turbopack infers
  // the root from the nearest lockfile above this one (the outer scratch
  // folder also has a package-lock.json), which produces a "multiple
  // lockfiles" build warning and risks Vercel resolving the wrong root.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
