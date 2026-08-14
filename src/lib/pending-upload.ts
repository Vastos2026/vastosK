/**
 * One-shot, in-memory handoff for a File picked on the "Do you have a floor
 * plan?" page, read once by the Upload page right after.
 *
 * Exists because a native file-picker dialog can only be opened
 * programmatically from within a direct, synchronous user gesture (the click
 * handler itself). A client-side route change from floor-plan/page.tsx to
 * upload/page.tsx runs data fetching and a fresh render pass before any
 * effect on the new page fires, which is well outside the window browsers
 * treat as still "user-activated" — an input.click() called from that
 * page's mount effect is unreliable and silently does nothing in several
 * browsers. So the file input lives on floor-plan/page.tsx itself (where the
 * click that opens it can be truly synchronous), and only the resulting File
 * — not the dialog trigger — crosses the navigation.
 *
 * A plain module-level variable, not a store field: a File object can't be
 * persisted to localStorage anyway, and this is read exactly once by the
 * next page load, never restored across a reload.
 */
let pendingFile: File | null = null;

export function setPendingUploadFile(file: File): void {
  pendingFile = file;
}

/** Reads and clears the pending file. A second call in the same session returns null. */
export function takePendingUploadFile(): File | null {
  const file = pendingFile;
  pendingFile = null;
  return file;
}
