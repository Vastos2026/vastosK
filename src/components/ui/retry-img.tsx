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
}: {
  src: string;
  alt: string;
  className?: string;
  draggable?: boolean;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
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
  if (src !== prevSrc) {
    setPrevSrc(src);
    setAttempt(0);
    setGaveUp(false);
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

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={attempt}
      src={src}
      alt={alt}
      draggable={draggable}
      className={className}
      onError={() => {
        if (attempt >= RETRY_SCHEDULE_MS.length) {
          setGaveUp(true);
          return;
        }
        timeoutRef.current = setTimeout(() => setAttempt((a) => a + 1), RETRY_SCHEDULE_MS[attempt]);
      }}
      onLoad={onLoad}
    />
  );
}
