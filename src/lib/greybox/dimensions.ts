/**
 * The ONE place greybox output dimensions are decided. Section 3.4 requires
 * the generation width/height to produce exactly this aspect — any mismatch
 * and FLUX letterboxes or crops, which breaks the camera match the whole
 * pipeline depends on. runware-client.ts imports these rather than keeping
 * its own numbers, so the two cannot drift.
 *
 * Split out of render-to-data-uri.ts (which is "use client" for its WebGL
 * calls) so server-side code — camera.ts's projectOpenings, the section 7.1
 * mask/label passes, and runware-client.ts's aspect assertion — can import
 * these three numbers without dragging in a client boundary.
 * render-to-data-uri.ts re-exports all three so existing imports keep working.
 *
 * 1376x768 is section 3.4's stated target (both divisible by 16). If Runware
 * rejects it on bfl:5@1 with invalidWidth — FLUX.1-dev required divisibility
 * by 64 and the ControlNet spike hit exactly this — change these two numbers
 * to 1280x704 and nothing else needs to move. Task 13 verifies which applies.
 */
export const GREYBOX_RENDER_W = 1376;
export const GREYBOX_RENDER_H = 768;
export const GREYBOX_ASPECT = GREYBOX_RENDER_W / GREYBOX_RENDER_H;
