/**
 * This app is India-only (clients + admins), so a plain `YYYY-MM-DD` from an
 * HTML `<input type="date">` is always meant as an IST calendar date — but
 * `new Date("2026-07-31").toISOString()` parses date-only strings as UTC
 * midnight per the JS spec, which is 5:30 EARLIER than IST midnight. Found
 * as the root cause of "Scheduled stop saves but the account isn't blocked
 * yet" (console/user-row.tsx): an admin picking "today" expected the account
 * to stop around local midnight, but the stored value was UTC midnight —
 * 5.5 hours later. Same bug shape affects the Billing anchor date input.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `YYYY-MM-DD` (from a date input) → the UTC ISO instant for IST midnight of that date. */
export function istDateInputToIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00+05:30`).toISOString();
}

/** A stored UTC ISO instant → the `YYYY-MM-DD` IST calendar date, for a date input's value. Inverse of istDateInputToIso. */
export function isoToISTDateInput(iso: string | null): string {
  if (!iso) return "";
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}
