/**
 * How much larger than its true dimensions a room is BUILT in the greybox.
 *
 * The problem this solves, measured on a 10x12 ft room — the most common
 * shape in the Indian plans this product serves:
 *
 *   - The camera stands INSIDE the room, and furniture must clear a fixed
 *     2.6 ft disk around it. For a bed that disk blocks 46% of the floor;
 *     for a wardrobe, 38%.
 *   - Add the bed's own footprint and there is nothing legal left. Measured:
 *     a wardrobe had **0.0 sq ft** of legal positions once a bed was placed.
 *     Not "tight" — literally zero. That is why the editor refused a second
 *     piece, and why every render came back with a bed and bare walls.
 *
 * Scaling the room fixes it because the clearance disk is a fixed size in
 * world units, so it covers proportionally less floor as the room grows. At
 * 1.3x that same wardrobe gets 30.9 sq ft of legal placement.
 *
 * WHY SCALE THE ROOM RATHER THAN SHRINK THE FURNITURE. The two are not
 * equivalent, which is worth stating because it looks like they should be.
 * Dropping the clearance to 2.0 ft in a true-size room yields only 1.4 sq ft
 * of legal placement; matching 1.3x would need furniture shrunk to 77% of
 * already-Indian sizes, i.e. a 3.85 ft "queen" bed — a single. FLUX
 * reproduces the reference faithfully, so undersized furniture comes back as
 * undersized furniture. Misstating the room costs nothing visible; misstating
 * the furniture costs the render.
 *
 * WHAT THIS DOES NOT CHANGE. Everything the camera and the opening census
 * depend on is preserved, because the two things that could have moved are
 * stored as FRACTIONS of the room, not in feet:
 *
 *   - `PlacedOpening.t` is 0..1 along its wall, so every opening keeps its
 *     exact relative position. `PlacedFurniture.x`/`.z` are 0..1 across the
 *     room, so every piece stays exactly where the user put it.
 *   - The camera's standoff (`INSET`) is a fraction of the room too, so the
 *     camera keeps the same relative position, the same wall, the same eye
 *     height and the same lens. Its aim and angle are untouched.
 *   - No stored data changes and nothing needs migrating. Applying the scale
 *     at render time, from the one funnel every caller already goes through
 *     (`roomSpecFor`), means it can never be applied twice.
 *
 * The room's TRUE size is what the user sees in the UI and what the image
 * prompt states — `formatRoomSize` reads `room.width`/`room.height`, never
 * this. So the prompt still says 10 x 12 ft while the reference image shows a
 * roomier box. That mismatch is the deliberate, accepted cost of this change:
 * the image model composes from what it sees, not from a number in the text.
 *
 * Ceiling height is deliberately NOT scaled. A real 13 x 15.6 ft room has an
 * ordinary 10 ft ceiling, not a 13 ft one; scaling it would turn every
 * bedroom into a hall.
 *
 * One consequence to keep in mind if this value is ever raised much further:
 * openings keep their true width in feet, so they occupy a smaller share of a
 * scaled wall and their mask component shrinks with it. `count-openings.ts`
 * ignores components under `MIN_COMPONENT_PX` (64), so a large enough scale
 * would start dropping small, distant windows out of the ledger silently. At
 * 1.3x the component is ~77% of its former width at unchanged height, which
 * leaves a real door or window an order of magnitude clear of that floor.
 */
export const GREYBOX_ROOM_SCALE = 1.3;
