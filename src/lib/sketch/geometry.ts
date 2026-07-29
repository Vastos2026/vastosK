/**
 * Pure geometry helpers for the Sketch Tool (docs/VASTOS_REVAMP_PLAN.md's
 * "No-floor-plan flow: Sketch Tool"). Framework-free, canvas-agnostic — all
 * points are normalized [0,1] coordinates relative to the drawing container,
 * matching lasso-canvas.tsx's convention.
 *
 * The one non-obvious design choice: dimensions in feet are derived from
 * PIXEL distances (normalized point * current container width/height), not
 * normalized-unit distances directly. That keeps the math correct even when
 * the container isn't square, as long as its aspect ratio is fixed — see the
 * Sketch Tool page for the container's CSS. Both the calibration edge and
 * every room's bounding box are converted through the same container size
 * snapshot, so results stay internally consistent regardless of when they're
 * computed.
 */

export type Pt = [number, number];
export type Side = "north" | "south" | "east" | "west";

/** One boundary or subdivided cell: a simple polygon plus, per edge (points[i] -> points[i+1]),
 * whether that edge is a remnant of the ORIGINAL outer boundary (true) or was introduced by a
 * dividing cut (false). Needed later to resolve each edge's opening `connectsTo`. */
export interface CellData {
  points: Pt[];
  boundaryFlags: boolean[];
}

export interface EdgeMeta {
  side: Side;
  isExterior: boolean;
  /** index into the cells array of the neighboring cell sharing this edge, if any */
  neighborIndex: number | null;
}

const EPS = 1e-6;

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function cross(vx: number, vy: number, wx: number, wy: number): number {
  return vx * wy - vy * wx;
}

/** Bounded segment-segment intersection (both segments' own endpoints, not infinite lines). */
function segmentIntersection(p1: Pt, p2: Pt, a: Pt, b: Pt): Pt | null {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const denom = cross(rx, ry, sx, sy);
  if (Math.abs(denom) < 1e-9) return null; // parallel (or collinear) — not handled, out of scope
  const qpx = a[0] - p1[0];
  const qpy = a[1] - p1[1];
  const t = cross(qpx, qpy, sx, sy) / denom;
  const u = cross(qpx, qpy, rx, ry) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return [p1[0] + t * rx, p1[1] + t * ry];
}

/** Signed area via the shoelace formula (magnitude only matters to callers here). */
export function polygonArea(points: Pt[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function polygonBounds(points: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function polygonCentroid(points: Pt[]): Pt {
  const n = points.length;
  const x = points.reduce((s, p) => s + p[0], 0) / n;
  const y = points.reduce((s, p) => s + p[1], 0) / n;
  return [x, y];
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

/**
 * Snap a newly-clicked boundary point so the edge from `prev` to it lands on
 * the nearest 15-degree increment (this single rule covers horizontal/vertical
 * at 0/90/180/270 and the diagonals at the 45s too, so no separate axis-snap
 * rule is needed) — deliberately simple, not a constraint solver.
 */
export function snapAngle(prev: Pt, candidate: Pt, incrementDeg = 15): Pt {
  const dx = candidate[0] - prev[0];
  const dy = candidate[1] - prev[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return candidate;
  const angle = Math.atan2(dy, dx);
  const deg = (angle * 180) / Math.PI;
  const snappedDeg = Math.round(deg / incrementDeg) * incrementDeg;
  const rad = (snappedDeg * Math.PI) / 180;
  return [prev[0] + Math.cos(rad) * d, prev[1] + Math.sin(rad) * d];
}

/**
 * Splits `cell` by the straight line through `rawA`/`rawB` (the user's two
 * clicks). The click points are extended a little past themselves before
 * intersecting, so the user doesn't have to click exactly on/past the cell's
 * edge for a cut to register as "fully crossing" it — but the cut is still a
 * bounded segment, not an infinite line, so it can't jump to an unrelated,
 * merely-collinear cell elsewhere on the boundary.
 *
 * Returns the two resulting sub-cells, or null if the line doesn't cross this
 * cell at exactly two distinct edges (not a valid full crossing).
 */
export function splitCellByLine(cell: CellData, rawA: Pt, rawB: Pt, extendFactor = 0.15): [CellData, CellData] | null {
  const dx = rawB[0] - rawA[0];
  const dy = rawB[1] - rawA[1];
  const p1: Pt = [rawA[0] - dx * extendFactor, rawA[1] - dy * extendFactor];
  const p2: Pt = [rawB[0] + dx * extendFactor, rawB[1] + dy * extendFactor];

  const { points, boundaryFlags } = cell;
  const n = points.length;
  if (n < 3) return null;

  const hits: { edgeIndex: number; point: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const hit = segmentIntersection(p1, p2, a, b);
    if (hit) hits.push({ edgeIndex: i, point: hit });
  }

  // Dedupe hits landing on (nearly) the same point — happens when the cut
  // passes through a shared vertex, registering on both adjacent edges.
  const deduped: { edgeIndex: number; point: Pt }[] = [];
  for (const h of hits) {
    if (!deduped.some((d) => dist(d.point, h.point) < 0.004)) deduped.push(h);
  }
  if (deduped.length !== 2) return null;

  const [h1, h2] = deduped[0].edgeIndex <= deduped[1].edgeIndex ? deduped : [deduped[1], deduped[0]];
  if (h1.edgeIndex === h2.edgeIndex) return null;

  const cellA = buildSubPolygon(points, boundaryFlags, h1.edgeIndex, h1.point, h2.edgeIndex, h2.point);
  const cellB = buildSubPolygon(points, boundaryFlags, h2.edgeIndex, h2.point, h1.edgeIndex, h1.point);

  const MIN_AREA = 0.0005; // in normalized-unit^2 — rejects degenerate slivers
  if (cellA.points.length < 3 || cellB.points.length < 3) return null;
  if (Math.abs(polygonArea(cellA.points)) < MIN_AREA || Math.abs(polygonArea(cellB.points)) < MIN_AREA) return null;

  return [cellA, cellB];
}

/**
 * Walks a polygon's vertex list from the intersection point on `startEdge` to
 * the intersection point on `endEdge` (wrapping via modulo), splicing in the
 * two new intersection points and closing the new cell with the cut edge —
 * the "walk the edges, splice in two points" algorithm the spec describes.
 */
function buildSubPolygon(
  points: Pt[],
  flags: boolean[],
  startEdge: number,
  qStart: Pt,
  endEdge: number,
  qEnd: Pt,
): CellData {
  const n = points.length;
  const verts: Pt[] = [qStart];
  const bflags: boolean[] = [];
  let k = startEdge;
  while (k !== endEdge) {
    const nextIdx = (k + 1) % n;
    verts.push(points[nextIdx]);
    bflags.push(flags[k]);
    k = nextIdx;
  }
  verts.push(qEnd);
  bflags.push(flags[endEdge]);
  bflags.push(false); // the new cut edge (qEnd -> qStart), never part of the outer boundary
  return { points: verts, boundaryFlags: bflags };
}

/** Which wall an edge reads as, from its dominant direction relative to the cell's own bounding box. */
export function edgeSide(a: Pt, b: Pt, bounds: { centerX: number; centerY: number }): Side {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const midX = (a[0] + b[0]) / 2;
  const midY = (a[1] + b[1]) / 2;
  if (dx >= dy) return midY < bounds.centerY ? "north" : "south";
  return midX < bounds.centerX ? "west" : "east";
}

/**
 * Collinear-and-overlapping test for two segments — used to find the
 * neighboring cell sharing a cut edge. Returns the fraction of `a1->a2`'s own
 * length that `b1->b2` covers (0 = no overlap, 1 = fully covered), not just a
 * boolean — a cut edge that later gets re-cut on ITS side fragments into two
 * shorter neighbor edges, each covering only PART of this cell's still-whole
 * edge. Requiring near-total coverage (see computeEdgeMeta) rather than
 * "any overlap" avoids confidently picking whichever fragment happens to be
 * checked first when there are really two different neighbors along one edge.
 */
function segmentOverlapFraction(a1: Pt, a2: Pt, b1: Pt, b2: Pt, eps = 0.01): number {
  const dx = a2[0] - a1[0];
  const dy = a2[1] - a1[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const nx = dx / len;
  const ny = dy / len;
  const perp1 = (b1[0] - a1[0]) * ny - (b1[1] - a1[1]) * nx;
  const perp2 = (b2[0] - a1[0]) * ny - (b2[1] - a1[1]) * nx;
  if (Math.abs(perp1) > eps || Math.abs(perp2) > eps) return 0; // not collinear
  const t1 = (b1[0] - a1[0]) * nx + (b1[1] - a1[1]) * ny;
  const t2 = (b2[0] - a1[0]) * nx + (b2[1] - a1[1]) * ny;
  const bMin = Math.min(t1, t2);
  const bMax = Math.max(t1, t2);
  const overlap = Math.min(len, bMax) - Math.max(0, bMin);
  return overlap > eps ? overlap / len : 0;
}

// An edge fragmented by a later cut on the neighbor's side (a normal outcome
// of subdividing further — e.g. cut 1 gives a cell a full-height edge, cut 2
// re-splits the cell across from it, and that one edge now borders two
// different neighbor cells along two different fragments of its length)
// should NOT be confidently assigned to whichever fragment is found first —
// require near-total coverage before trusting a single neighbor, matching
// this app's "never assert what wasn't confidently determined" rule (see
// the retired assign-openings.ts's doc comment: state only what's positively
// found). Below this threshold, `connectsTo` resolves to null instead of a
// specific — possibly wrong — room name.
const CONFIDENT_NEIGHBOR_COVERAGE = 0.9;

/**
 * For every edge of every cell: which wall it reads as, whether it sits on
 * the outer boundary ("exterior"), and — if not — which other cell shares it
 * (only when a single neighbor covers nearly the whole edge; see the
 * coverage-threshold note above). Computed once, right after dividing is
 * finalized (before the openings step), since cells don't change shape after
 * that point.
 */
export function computeEdgeMeta(cells: CellData[]): EdgeMeta[][] {
  return cells.map((cell, ci) => {
    const bounds = polygonBounds(cell.points);
    const n = cell.points.length;
    return cell.points.map((a, i) => {
      const b = cell.points[(i + 1) % n];
      const side = edgeSide(a, b, bounds);
      if (cell.boundaryFlags[i]) return { side, isExterior: true, neighborIndex: null };

      let bestIndex: number | null = null;
      let bestCoverage = 0;
      for (let cj = 0; cj < cells.length; cj++) {
        if (cj === ci) continue;
        const other = cells[cj];
        const on = other.points.length;
        for (let j = 0; j < on; j++) {
          if (other.boundaryFlags[j]) continue;
          const oa = other.points[j];
          const ob = other.points[(j + 1) % on];
          const coverage = segmentOverlapFraction(a, b, oa, ob);
          if (coverage > bestCoverage) {
            bestCoverage = coverage;
            bestIndex = cj;
          }
        }
      }
      const neighborIndex = bestCoverage >= CONFIDENT_NEIGHBOR_COVERAGE ? bestIndex : null;
      return { side, isExterior: false, neighborIndex };
    });
  });
}

/** Feet-per-pixel derived from the one user-entered reference dimension (see module doc comment). */
export function computeFeetPerPixel(refA: Pt, refB: Pt, containerW: number, containerH: number, enteredFeet: number): number {
  const dx = (refB[0] - refA[0]) * containerW;
  const dy = (refB[1] - refA[1]) * containerH;
  const pixelDist = Math.hypot(dx, dy);
  if (pixelDist < 1e-6) return 0;
  return enteredFeet / pixelDist;
}

/** A cell's bounding-box width/height in feet — the "simplest reasonable approximation" for non-rectangular cells. */
export function cellDimensionsFt(cell: CellData, containerW: number, containerH: number, feetPerPixel: number) {
  const b = polygonBounds(cell.points);
  return {
    width: b.width * containerW * feetPerPixel,
    height: b.height * containerH * feetPerPixel,
  };
}
