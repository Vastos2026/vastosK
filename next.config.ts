import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / binary-bundling modules used server-side. Mark them external so
  // Next/Turbopack loads them from node_modules at runtime rather than bundling
  // them — bundling breaks sharp (native .node) and ffmpeg-static (its exported
  // path to the ffmpeg binary is computed relative to its own file, which the
  // bundler rewrites, so frame extraction silently failed and fell back).
  serverExternalPackages: ["sharp", "ffmpeg-static"],
};

export default nextConfig;
