import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / binary-bundling modules used server-side. Mark them external so
  // Next/Turbopack loads them from node_modules at runtime rather than bundling
  // them — bundling breaks sharp (native .node) and ffmpeg-static (its exported
  // path to the ffmpeg binary is computed relative to its own file, which the
  // bundler rewrites, so frame extraction silently failed and fell back).
  //
  // package.json's `sharp` MUST resolve to a version that satisfies whatever
  // range THIS Next version declares for sharp in its own package.json —
  // currently `optionalDependencies: { sharp: "^0.35.3" }` (it was an optional
  // PEER dependency up to Next 16.2.x, which is why this note used to say
  // "peer"; an optionalDependency is installed unconditionally, so the only
  // thing that prevents a second copy is npm being able to dedupe against the
  // root one). Miss the range and npm installs TWO separate sharp copies (root
  // + nested under next/node_modules), each pulling its own native libvips.
  //
  // Two distinct failures come from that, both observed in this repo:
  //   1. "ERR_DLOPEN_FAILED: libvips-cpp.so.X.Y.Z cannot open shared object
  //      file" on Vercel — the build succeeds (nothing dlopens sharp during a
  //      build), and only the first API-route request that calls sharp fails.
  //      Reproduced locally 2026-08-01 with sharp 0.35.1 (root) + 0.34.5
  //      (nested under Next 16.2.9); corroborated by lovell/sharp#4567.
  //   2. "GLib-GObject-CRITICAL: value \"32\" of type 'gint' is invalid or out
  //      of range for property 'space' of type 'VipsInterpretation'" on every
  //      sharp call — two libvips builds in ONE process, where the first to
  //      initialise registers the VipsInterpretation GEnum globally and the
  //      second then passes it enum members that registration doesn't contain
  //      (8.18 added interpretations 8.17 has no name for). Noisy rather than
  //      fatal, but it is the same root cause as (1) and the same fix.
  //      Observed 2026-08-24 with root 0.34.5 (libvips 8.17.3) + nested 0.35.3
  //      (libvips 8.18.3) after the Next 16.3.2 bump moved the range.
  //
  // Fix, and the check to run after ANY `next` upgrade:
  //   node -p "require('next/package.json').optionalDependencies.sharp"
  //   npm ls sharp        # must print exactly one non-deduped sharp
  // `npm ls sharp` showing a nested copy means this is broken again.
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
