"use client";

/**
 * Greybox rendering is client-side WebGL. Rendering a seven-room gallery in
 * parallel opens seven WebGL contexts at once and hits the browser's ~16
 * context cap with unpredictable eviction — a card whose context is evicted
 * mid-render produces a blank or partial PNG and uploads it as if it were
 * fine. One at a time, always.
 */
type Job<T> = () => Promise<T>;

let chain: Promise<unknown> = Promise.resolve();

export function enqueueGreyboxRender<T>(job: Job<T>): Promise<T> {
  const run = chain.then(job, job);
  // Keep the chain alive regardless of individual failures: one room that
  // cannot render must not stall every room behind it.
  chain = run.catch(() => undefined);
  return run;
}
