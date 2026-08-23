"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Backoff schedule, ms between each attempt — widened from a flat 3×700ms
// (~2.1s total) after a direct user report: "Generate More" would finish,
// the ring would revert to idle, and the freshly generated image just never
// appeared until a manual page refresh. 3 quick retries can be too short a
// window for the ownership row / storage object to be fully read-consistent
// under load; this schedule gives ~7.6s of total runway before giving up,
// on the reasoning that a slow-but-real load is far more common than a
// truly broken key, so it's worth waiting longer before showing a dead icon.
const RETRY_SCHEDULE_MS = [500, 800, 1300, 2000, 3000];

/**
 * `<img>` with an auto-retry on load failure. A freshly-generated image can
 * very rarely still fail to load for a moment right after generation — a
 * slow DB read for the ownership check, or a storage read racing the write
 * — and browsers never retry a failed `<img>` on their own, so without this
 * a rare miss just sits broken (or, worse, silently absent) until the user
 * manually reloads the page. Use this instead of a bare `<img>` anywhere an
 * image can be displayed moments after this app itself generated it
 * (freshly rendered room images, edits, floor-plan uploads) — see
 * generate/page.tsx, generate/[roomId]/page.tsx, approve/page.tsx,
 * furnish/[roomId]/page.tsx, plan/page.tsx.
 *
 * Remounting via a changing `key` (not just re-setting `src`) forces the
 * browser to actually re-issue the request rather than reuse a cached
 * failure.
 */
export function RetryImg({
  src,
  alt,
  className,
  draggable,
  onLoad,
  // Defaults to "lazy": every known call site sits in a gallery/grid/strip
  // where most tiles start off-screen, so deferring their network request
  // until they near the viewport is the right default (see CLAUDE.md's
  // "images sometimes don't render" complaint and the task's requirement
  // that below-the-fold generated images be lazy). Pass "eager" explicitly
  // for the rare single always-visible image (e.g. the floor-plan side
  // panel's one reference thumbnail) where deferring buys nothing and only
  // delays a load the user will see immediately anyway.
  loading = "lazy",
}: {
  src: string;
  alt: string;
  className?: string;
  draggable?: boolean;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  loading?: "lazy" | "eager";
}) {
  // Resets attempt/gaveUp whenever `src` changes — done by comparing against
  // a stored previous value DURING RENDER (React's documented pattern for
  // "adjust state when a prop changes" without an effect,
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
  // rather than a useEffect + setState, which eslint-plugin-react-hooks flags
  // as a cascading-render risk.
  const [prevSrc, setPrevSrc] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  // Whether the CURRENT attempt's <img> has actually finished loading. Kept
  // separate from `gaveUp` — this is false for the entire loading phase AND
  // for every failed attempt in between, which is exactly the window where
  // we need to keep the raw <img> hidden (see below).
  const [loaded, setLoaded] = useState(false);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setAttempt(0);
    setGaveUp(false);
    setLoaded(false);
  }

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  if (gaveUp) {
    return (
      <div className={cn("grid place-items-center bg-grid", className)}>
        <Icon name="CircleAlert" className="size-5 text-faint" />
      </div>
    );
  }

  // Browsers never hide a failed <img> on their own — the broken-image
  // glyph sits there for the entire gap between a failed attempt and the
  // next retry (up to RETRY_SCHEDULE_MS[attempt] ms, see the schedule above)
  // since the element stays mounted with a broken `src` until we bump
  // `attempt`, and it can also flash briefly during a slow initial load.
  // Reported as "sometimes I can see that jpeg symbol" on the Furnish cards.
  // Fix: wrap in a positioned container, keep the real <img> at opacity-0
  // (NOT unmounted — unmounting would cancel the in-flight request) until
  // `onLoad` actually fires, and show a plain skeleton surface behind it in
  // the meantime. `object-fit` only affects a replaced element like <img>,
  // so leaving the caller's full className on the wrapper too is harmless
  // there (a no-op on a <div>) and keeps every call site's sizing/position
  // classes byte-for-byte unchanged; only the one `object-*` token needs to
  // be pulled out and re-applied on the inner <img> directly.
  const objectFit = className?.match(/\bobject-(cover|contain|fill|none|scale-down)\b/)?.[0] ?? "object-cover";
  // Most callers pass "absolute inset-0 ..." (this already establishes a
  // positioning context for children), but a few lay the image out in
  // normal flow instead (e.g. "aspect-square w-full object-cover") — those
  // need `relative` added so the absolutely-positioned skeleton/img below
  // anchor to THIS wrapper instead of drifting up to whatever positioned
  // ancestor happens to be further up the tree.
  const isPositioned = /\b(absolute|fixed|sticky|relative)\b/.test(className ?? "");

  return (
    <div className={cn(className, !isPositioned && "relative")}>
      {!loaded && <div className="absolute inset-0 bg-surface-2" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={attempt}
        src={src}
        alt={alt}
        draggable={draggable}
        loading={loading}
        decoding="async"
        className={cn(
          "absolute inset-0 h-full w-full transition-opacity duration-150",
          objectFit,
          loaded ? "opacity-100" : "opacity-0",
        )}
        onError={() => {
          if (attempt >= RETRY_SCHEDULE_MS.length) {
            setGaveUp(true);
            return;
          }
          timeoutRef.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_SCHEDULE_MS[attempt]);
        }}
        onLoad={(e) => {
          setLoaded(true);
          onLoad?.(e);
        }}
      />
    </div>
  );
}
