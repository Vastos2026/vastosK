import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / binary-bundling modules used server-side. Mark them external so
  // Next/Turbopack loads them from node_modules at runtime rather than bundling
  // them — bundling breaks sharp (native .node) and ffmpeg-static (its exported
  // path to the ffmpeg binary is computed relative to its own file, which the
  // bundler rewrites, so frame extraction silently failed and fell back).
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
