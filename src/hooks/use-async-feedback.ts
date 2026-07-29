"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Busy flag + transient feedback message for a one-off async action button
 * (e.g. "copy share link", "export PDF") — shows a spinner while the action
 * runs, then a short message that clears itself after `clearAfterMs`.
 * `action` returns the feedback string to show, or nothing for silent success.
 */
export function useAsyncFeedback(clearAfterMs = 2500) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const busyRef = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (action: () => Promise<string | void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setFeedback(null);
      try {
        const message = await action();
        if (message) setFeedback(message);
      } catch (e) {
        setFeedback(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (clearTimer.current) clearTimeout(clearTimer.current);
        clearTimer.current = setTimeout(() => setFeedback(null), clearAfterMs);
      }
    },
    [clearAfterMs],
  );

  return { busy, feedback, run };
}
