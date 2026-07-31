import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Short id generator for client-created mock entities. */
export function uid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Relative time like "2h ago" from an ISO string. */
export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Format ft dimensions, e.g. "12 × 10 ft". */
export function dims(w: number, h: number) {
  return `${w} × ${h} ft`;
}

/** Lighten (amt > 0) or darken (amt < 0) a hex color by a 0–1 amount. */
export function shade(hex: string, amt: number) {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const num = parseInt(full, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  r = Math.round((t - r) * p) + r;
  g = Math.round((t - g) * p) + g;
  b = Math.round((t - b) * p) + b;
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** Slugify a room name for use in a download filename, e.g. "Living Room" -> "living-room". */
export function slugifyRoomName(name: string): string {
  return name.replace(/\s+/g, "-").toLowerCase();
}

/** Palette assigned to rooms by index — shared by the extraction pipeline and the Room Confirmation "Add room" form so a room's colour never changes as it moves between screens. */
export const ROOM_PALETTE = [
  "#e6a45c", "#6da8e2", "#5cc98a", "#d4972a", "#b98ce2",
  "#e27d9a", "#6dc7e2", "#8ac98a", "#c98a8a", "#8a9ec9",
] as const;
