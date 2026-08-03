/**
 * This repo has no test runner, and plain Node cannot import its modules —
 * extensionless relative imports and the `@/` alias resolve only through
 * Next's bundler (the ControlNet spike hit ERR_MODULE_NOT_FOUND trying).
 * So pure-function assertions live here and run inside the app.
 *
 * Hit with: curl http://localhost:3000/api/dev-check
 * Returns 404 in production. No auth, no rate limit, no provider calls — it
 * must never do anything that costs money or touches user data.
 */
import { greyboxHashFor } from "@/lib/greybox/greybox-hash";
import { openingFaceSamples, type GreyboxClass } from "@/lib/greybox/build-scene";
// Imported from ./histogram, NOT ./render-to-data-uri — the latter is
// "use client" (WebGL rendering) and this route runs server-side. histogram.ts
// carries no directive specifically so this pure-function check can import it.
import { assertHistogram, GreyboxHistogramError } from "@/lib/greybox/histogram";
// greyboxCamera/projectOpenings (camera.ts) and the render dimensions
// (dimensions.ts) carry no "use client" directive either — camera math is
// pure THREE.Vector3/PerspectiveCamera arithmetic, no WebGLRenderer, no
// canvas, no DOM — so it runs here exactly as it would in the browser.
import { greyboxCamera, projectOpenings } from "@/lib/greybox/camera";
import { GREYBOX_ASPECT, GREYBOX_RENDER_H, GREYBOX_RENDER_W } from "@/lib/greybox/dimensions";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";
import sharp from "sharp";
import { countOpenings } from "@/lib/greybox/count-openings";
import { validateOpenings } from "@/lib/greybox/validate-openings";
import { footprintAabb, resolvePlacement } from "@/lib/greybox/validate-furniture";
import { buildFurnitureMaterials } from "@/lib/greybox/furniture-layout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Builds a synthetic `ImageData`-shaped object plus the `Map<GreyboxClass,
 * number[]>` region map that assertHistogram consumes — the same two-argument
 * shape a real render + label pass produce, without needing a browser. Each
 * region is a flat run of `count` pixels all set to the same grey `value`
 * (so its luma is exactly value/255); a region with `cls: null` still
 * occupies pixel slots (and so counts toward assertHistogram's clipping
 * denominator) but is left out of the label map, standing in for background
 * pixels that a label pass didn't map to a named class. Counts are in the
 * hundreds so percentiles reflect an actual distribution, not a handful of
 * arbitrary samples.
 */
function buildHistogramFixture(
  regions: { cls: GreyboxClass | null; value: number; count: number }[],
): { real: ImageData; labels: Map<GreyboxClass, number[]> } {
  const total = regions.reduce((sum, r) => sum + r.count, 0);
  const data = new Uint8ClampedArray(total * 4);
  const labels = new Map<GreyboxClass, number[]>();
  let idx = 0;
  for (const r of regions) {
    const indices: number[] = [];
    for (let i = 0; i < r.count; i++) {
      data[idx * 4] = r.value;
      data[idx * 4 + 1] = r.value;
      data[idx * 4 + 2] = r.value;
      data[idx * 4 + 3] = 255;
      indices.push(idx);
      idx++;
    }
    if (r.cls) labels.set(r.cls, [...(labels.get(r.cls) ?? []), ...indices]);
  }
  // width/height are meaningless for this flat synthetic buffer — assertHistogram
  // only reads `.data` — but width * height * 4 must equal data.length, so shape
  // it as a single row of `total` pixels.
  const real = { data, width: total, height: 1 } as ImageData;
  return { real, labels };
}

/**
 * Shared fixture for the projectOpenings checks below (section 7.1's ledger
 * projection). `camera` is the same one `renderGreyboxBundle` would derive
 * from `anchorSpec` — this reconstructs only the math half (no WebGL).
 *
 * `anchorSpec` has exactly ONE opening: a window dead-centre (t=0.5) on the
 * south wall. A window's vertical centre — (WINDOW_SILL+WINDOW_HEAD)/2 = 5 —
 * happens to equal camera.ts's EYE_H (also 5), so the candidate that faces
 * this opening head-on down the room's Z axis (the north-wall midpoint)
 * projects its centre to NDC (0, 0) exactly: horizontally centred because
 * that candidate's X coincides with the opening's X, vertically centred
 * because the opening sits exactly at eye height. (0, 0) is the minimum
 * possible value of camera.ts's tie-break "spread", and camera.ts tries the
 * north-wall midpoint FIRST — so once it claims that minimum, no later
 * candidate's tie (spread can't go negative) can ever displace it. That
 * makes the resulting viewpoint deterministic without hand-simulating all 8
 * candidates for every spec that reuses this fixture, and — since it faces
 * south — means the returned camera backs onto the NORTH wall.
 *
 * `spec` is the one actually handed to projectOpenings: the same anchor
 * opening (renamed, and as a door rather than a window — proving the
 * function reports each opening's own type, not a fixed one) plus a second
 * opening on the NORTH wall, the wall the camera backs onto — provably
 * behind it, which is the one case Vector3.project() gets wrong on its own
 * (see projectOpenings' own comment).
 */
function projectionFixture(): { spec: GreyboxRoomSpec; camera: ReturnType<typeof greyboxCamera> } {
  const width = 20;
  const depth = 16;
  const anchorSpec: GreyboxRoomSpec = {
    width,
    depth,
    openings: [{ id: "anchor", type: "window", wall: "south", t: 0.5, span: 0.3 }],
  };
  const camera = greyboxCamera(anchorSpec, GREYBOX_ASPECT);

  const spec: GreyboxRoomSpec = {
    width,
    depth,
    openings: [
      { id: "visible-south", type: "door", wall: "south", t: 0.5, span: 0.3 },
      { id: "behind-north", type: "window", wall: "north", t: 0.5, span: 0.3 },
    ],
  };
  return { spec, camera };
}

/** Asserts `fn` throws a GreyboxHistogramError whose message matches `pattern`. */
function assertThrowsHistogram(fn: () => void, pattern: RegExp, msg: string) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof GreyboxHistogramError, `${msg}: expected a GreyboxHistogramError, got ${e}`);
    assert(
      pattern.test((e as Error).message),
      `${msg}: error message did not match ${pattern}: "${(e as Error).message}"`,
    );
    return;
  }
  assert(false, `${msg}: expected assertHistogram to throw, but it did not`);
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  // Request-local, not module-scope: two concurrent requests in the same
  // Next.js process must not share (and race on resetting) one array. Every
  // check appended here is synchronous today, but Task 6 adds an async
  // check — module-scope state plus a shared reset is exactly what turns
  // that into cross-request corruption.
  const results: Result[] = [];

  function check(name: string, fn: () => void) {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, detail: (e as Error).message });
    }
  }

  async function checkAsync(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, detail: (e as Error).message });
    }
  }

  // ---- greybox-hash ----
  check("hash is stable across calls", () => {
    const room = { width: 12, height: 14, placedOpenings: [], furniture: [] };
    eq(greyboxHashFor(room), greyboxHashFor(room), "same input, same hash");
  });

  check("hash ignores array order", () => {
    const a = {
      width: 12,
      height: 14,
      placedOpenings: [
        { id: "b", type: "window" as const, wall: "north" as const, t: 0.3, span: 0.2 },
        { id: "a", type: "door" as const, wall: "south" as const, t: 0.5, span: 0.25 },
      ],
      furniture: [],
    };
    const b = { ...a, placedOpenings: [...a.placedOpenings].reverse() };
    eq(greyboxHashFor(a), greyboxHashFor(b), "reordered openings hash identically");
  });

  check("hash changes when an opening moves", () => {
    const base = {
      width: 12,
      height: 14,
      placedOpenings: [{ id: "a", type: "door" as const, wall: "south" as const, t: 0.5, span: 0.25 }],
      furniture: [],
    };
    const moved = { ...base, placedOpenings: [{ ...base.placedOpenings[0], t: 0.6 }] };
    assert(greyboxHashFor(base) !== greyboxHashFor(moved), "moving a door must change the hash");
  });

  check("hash changes when furniture moves", () => {
    const base = {
      width: 12,
      height: 14,
      placedOpenings: [],
      furniture: [{ id: "f1", kind: "bed", x: 0.5, z: 0.2, rotation: 0 }],
    };
    const moved = { ...base, furniture: [{ ...base.furniture[0], x: 0.6 }] };
    assert(greyboxHashFor(base) !== greyboxHashFor(moved), "moving furniture must change the hash");
  });

  // ---- openingFaceSamples ----
  check("face samples land inside the opening rectangle", () => {
    const spec = {
      width: 12,
      depth: 10,
      openings: [{ id: "w1", type: "window" as const, wall: "north" as const, t: 0.5, span: 0.4 }],
    };
    const pts = openingFaceSamples(spec, spec.openings[0]);
    eq(pts.length, 25, "5x5 grid");
    // North wall sits at z = -depth/2, t runs west->east so samples vary in x only.
    for (const p of pts) {
      assert(Math.abs(p.z - -5) < 1e-6, `sample off the north wall plane: z=${p.z}`);
      assert(Math.abs(p.x) <= (0.4 * 12) / 2 + 1e-6, `sample outside the span: x=${p.x}`);
      assert(p.y >= 3 && p.y <= 7, `sample outside the window's vertical extent: y=${p.y}`);
    }
  });

  // ---- assertHistogram (section 3.7 value ladder) ----
  // Baseline "healthy" greys, reused with one deliberately broken per check:
  // wall 150, window 250 (brightest), furniture 70 (darkest), door 110.
  check("healthy value ladder passes assertHistogram", () => {
    const { real, labels } = buildHistogramFixture([
      { cls: "wall", value: 150, count: 2000 },
      { cls: "window", value: 250, count: 500 },
      { cls: "furniture", value: 70, count: 500 },
      { cls: "door", value: 110, count: 500 },
    ]);
    assertHistogram(real, labels); // must not throw
  });

  check("window darker than wall throws (condition 1)", () => {
    const { real, labels } = buildHistogramFixture([
      { cls: "wall", value: 150, count: 2000 },
      // 100 < wall's 150: window p05 <= wall p99, the exact collapse this
      // check exists to catch (e.g. the window filler losing its unlit
      // MeshBasicMaterial and picking up scene lighting like every other surface).
      { cls: "window", value: 100, count: 500 },
      { cls: "furniture", value: 70, count: 500 },
      { cls: "door", value: 110, count: 500 },
    ]);
    assertThrowsHistogram(
      () => assertHistogram(real, labels),
      /brightest/i,
      "window not brighter than wall must throw",
    );
  });

  check("furniture within 0.15 luma of wall throws (condition 2)", () => {
    const { real, labels } = buildHistogramFixture([
      { cls: "wall", value: 150, count: 2000 },
      { cls: "window", value: 250, count: 500 }, // stays healthy so this check, not the window one, fires
      // 140 vs wall's 150 is a ~0.04 median gap, well under the 0.15 floor.
      { cls: "furniture", value: 140, count: 500 },
      { cls: "door", value: 110, count: 500 },
    ]);
    assertThrowsHistogram(
      () => assertHistogram(real, labels),
      /separate from the walls/i,
      "furniture too close to wall must throw",
    );
  });

  check("door within 0.10 luma of furniture throws (condition 4)", () => {
    const { real, labels } = buildHistogramFixture([
      { cls: "wall", value: 150, count: 2000 },
      { cls: "window", value: 250, count: 500 }, // healthy
      { cls: "furniture", value: 70, count: 500 }, // healthy gap to wall
      // 90 vs furniture's 70 is a ~0.08 gap, under the 0.10 floor.
      { cls: "door", value: 90, count: 500 },
    ]);
    assertThrowsHistogram(
      () => assertHistogram(real, labels),
      /too close in value/i,
      "door too close to furniture must throw",
    );
  });

  check("over 0.5% of non-window pixels clipped at 255 throws (condition 3)", () => {
    const { real, labels } = buildHistogramFixture([
      { cls: "wall", value: 150, count: 2000 }, // all otherwise-healthy
      { cls: "window", value: 250, count: 500 },
      { cls: "furniture", value: 70, count: 500 },
      { cls: "door", value: 110, count: 500 },
      // Unlabeled (no greyboxClass in the label pass) but still real,
      // non-window pixels — exactly what a blown-out highlight off an
      // unclassified surface looks like. 50 of 3050 non-window pixels is
      // 1.6%, over the 0.5% ceiling.
      { cls: null, value: 255, count: 50 },
    ]);
    assertThrowsHistogram(
      () => assertHistogram(real, labels),
      /clipped at 255/i,
      "over-threshold clipping must throw",
    );
  });

  // ---- projectOpenings (section 7.1 ledger projection) ----
  check("projectOpenings: a visible opening lands inside the frame with its own id/type", () => {
    const { spec, camera } = projectionFixture();
    const [visible] = projectOpenings(spec, camera);
    eq(visible.id, "visible-south", "id carried through");
    eq(visible.type, "door", "type carried through, not a fixed constant");
    assert(
      visible.px >= 0 && visible.px < GREYBOX_RENDER_W,
      `px out of [0, ${GREYBOX_RENDER_W}): got ${visible.px}`,
    );
    assert(
      visible.py >= 0 && visible.py < GREYBOX_RENDER_H,
      `py out of [0, ${GREYBOX_RENDER_H}): got ${visible.py}`,
    );
  });

  check("projectOpenings: an opening behind the camera returns px=-1, py=-1", () => {
    const { spec, camera } = projectionFixture();
    const [, behind] = projectOpenings(spec, camera);
    eq(behind.id, "behind-north", "sanity: this is the wall the camera backs onto");
    // The important case: without the explicit in-front dot-product test,
    // Vector3.project() mirrors this behind-camera point back into valid NDC
    // range and it would score as visible instead.
    eq(behind.px, -1, "px must be the off-frame sentinel");
    eq(behind.py, -1, "py must be the off-frame sentinel");
  });

  check("projectOpenings: every opening appears in the output, in order", () => {
    const { spec, camera } = projectionFixture();
    const projected = projectOpenings(spec, camera);
    eq(projected.length, spec.openings.length, "no opening silently dropped");
    eq(
      projected.map((p) => p.id),
      spec.openings.map((o) => o.id),
      "order preserved",
    );
  });

  // ---- countOpenings ----
  const mask = async (w: number, h: number, rects: [number, number, number, number][]) => {
    const raw = Buffer.alloc(w * h, 0);
    for (const [x0, y0, rw, rh] of rects) {
      for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) raw[y * w + x] = 255;
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  };

  await checkAsync("counts two separate components as two openings", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40], [120, 10, 30, 40]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "door", px: 25, py: 30 },
      { id: "b", type: "window", px: 135, py: 30 },
    ]);
    eq(ledger, { doors: 1, windows: 1 }, "one door, one window");
  });

  await checkAsync("an off-frame opening is not counted", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "window", px: 25, py: 30 },
      // (-1,-1) is deliberately kept close to the rect (Chebyshev distance 11
      // to its (10,10) corner, inside SEARCH_RADIUS) rather than moved far
      // away: real off-frame projections always land on this exact sentinel
      // (camera.ts), never a proportional off-screen coordinate, so a real
      // opening near the frame's top-left corner is exactly the case this
      // guards against. `b` is given a DIFFERENT type than `a` on purpose —
      // if the px<0/py<0 guard is ever deleted, labelNear(-1,-1) finds this
      // same rect and overwrites `a`'s entry with "door", flipping the
      // ledger to {doors:1,windows:0}. Giving both openings the same type
      // would let that overwrite go unnoticed (same value written twice).
      { id: "b", type: "door", px: -1, py: -1 },
    ]);
    eq(ledger, { doors: 0, windows: 1 }, "behind-camera opening dropped");
  });

  await checkAsync("an occluded opening (no white pixels) is not counted", async () => {
    const png = await mask(200, 100, []);
    const ledger = await countOpenings(png, [{ id: "a", type: "door", px: 25, py: 30 }]);
    eq(ledger, { doors: 0, windows: 0 }, "fully occluded opening dropped");
  });

  await checkAsync("antialiasing crumbs below the area floor are ignored", async () => {
    const png = await mask(200, 100, [[10, 10, 30, 40], [180, 90, 3, 3]]);
    const ledger = await countOpenings(png, [
      { id: "a", type: "window", px: 25, py: 30 },
      { id: "b", type: "window", px: 181, py: 91 },
    ]);
    eq(ledger, { doors: 0, windows: 1 }, "9px component dropped");
  });

  // ---- validateOpenings (section 5) ----
  const op = (id: string, wall: "north" | "south" | "east" | "west", t: number, span: number, type: "door" | "window" = "window") =>
    ({ id, type, wall, t, span }) as const;

  check("a well-placed opening passes", () => {
    eq(validateOpenings([op("a", "north", 0.5, 0.3)], 12, 10), [], "no violations");
  });

  check("overlapping openings on the same wall are rejected", () => {
    const v = validateOpenings([op("a", "north", 0.4, 0.3), op("b", "north", 0.55, 0.3)], 12, 10);
    assert(v.some((x) => x.message.includes("overlap")), `expected an overlap violation, got ${JSON.stringify(v)}`);
  });

  check("openings closer than 0.5ft of solid wall are rejected", () => {
    // 12ft wall: a is t=0.25/span=0.3 -> spans [0.10, 0.40]; b is t=0.5667/span=0.3
    // -> spans [0.4167, 0.7167]. Gap = (0.4167-0.40)*12 = 0.2ft, under the 0.5ft
    // floor, and b.lo(0.4167) > a.hi(0.40) so this trips separation, not overlap.
    const v = validateOpenings([op("a", "north", 0.25, 0.3), op("b", "north", 0.5667, 0.3)], 12, 10);
    assert(v.some((x) => x.message.includes("solid wall")), `expected a separation violation, got ${JSON.stringify(v)}`);
  });

  check("an opening flush to a corner is rejected", () => {
    const v = validateOpenings([op("a", "north", 0.13, 0.25)], 12, 10);
    assert(v.some((x) => x.message.includes("corner")), `expected a corner violation, got ${JSON.stringify(v)}`);
  });

  check("an opening narrower than 2ft is rejected", () => {
    const v = validateOpenings([op("a", "north", 0.5, 0.1)], 12, 10);
    assert(v.some((x) => x.message.includes("niche")), `expected a min-span violation, got ${JSON.stringify(v)}`);
  });

  check("east and west walls are measured against depth, not width", () => {
    // span 0.25 on a 40ft-wide / 4ft-deep room: 1ft on the east wall -> too narrow.
    const v = validateOpenings([op("a", "east", 0.5, 0.25)], 40, 4);
    assert(v.some((x) => x.message.includes("niche")), `east wall must use depth, got ${JSON.stringify(v)}`);
  });

  // ---- resolvePlacement / footprintAabb (section 6) ----
  // Shared by every check below. `farCamera` sits near the room's SE corner
  // (matching camera.ts's corner-camera convention) but far enough from the
  // origin/negative-quadrant positions the other fixtures use below that it
  // never trips their camera-exclusion check by accident — verified by hand
  // for each fixture, see task-9-report.md.
  const room = { width: 12, depth: 10 };
  const farCamera = { x: 5.7, z: 4.7 };

  check("a legal move is accepted unchanged", () => {
    const r = resolvePlacement(
      { kind: "bed", rotation: 0, x: 0, z: 0, fromX: -1, fromZ: -1 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "unchanged");
  });

  check("a move outside the room is refused", () => {
    const r = resolvePlacement(
      { kind: "bed", rotation: 0, x: 100, z: 100, fromX: 0, fromZ: 0 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "held at the previous position");
  });

  check("overlapping another item falls back to one axis", () => {
    // side-table (1.5x1.5ft) moves diagonally from (0,2) onto a sofa
    // (7x3ft) centred at (-2,-3): the full move overlaps the sofa, the
    // x-only candidate (-2,2) clears it (z stays out of the sofa's
    // [-4.5,-1.5] span), and the z-only candidate (0,-3) does NOT clear it
    // (x stays inside the sofa's [-5.5,1.5] span) — a genuinely
    // axis-discriminating fixture.
    //
    // An earlier draft had fromX equal to the proposed x (both 3). That
    // collapses candidate 3 (legal(fromX, z), the z-only move) into
    // candidate 1 (legal(x, z), the full move) — both evaluate legal(3,3) —
    // which is already a real defect. But the fixture-killing defect is
    // that it also makes candidate 2's RESULT ({x: input.x, z: input.fromZ}
    // = {3,-2}) numerically identical to the unconditional final
    // fallback's result ({x: fromX, z: fromZ} = {3,-2}), since
    // input.x === fromX. So the old `assert(r.z === -2)` would have passed
    // even with the entire axis-fallback mechanism deleted and the
    // function falling straight through to the trivial hold — it could
    // not distinguish "axis fallback works" from "axis fallback is gone."
    const r = resolvePlacement(
      { kind: "side-table", rotation: 0, x: -2, z: -3, fromX: 0, fromZ: 2 },
      [{ kind: "sofa", x: -2, z: -3, rotation: 0 }],
      room,
      farCamera,
    );
    eq(r, { x: -2, z: 2 }, "x accepted at the proposed value, z held at the last-good value");
  });

  check("a rug may overlap other furniture", () => {
    const r = resolvePlacement(
      { kind: "rug", rotation: 0, x: 0, z: 0, fromX: -2, fromZ: -2 },
      [{ kind: "coffee-table", x: 0, z: 0, rotation: 0 }],
      room,
      farCamera,
    );
    eq(r, { x: 0, z: 0 }, "rug is overlap-exempt");
  });

  check("furniture cannot be placed inside the camera exclusion zone", () => {
    // A bed (reach 3.25ft) at (2.5, 2.5): fully inside room bounds on its
    // own (so the room-bounds check never fires and can't be mistaken for
    // the mechanism under test), but within CAMERA_EXCLUSION_FT (2.6) +
    // reach (3.25) = 5.85ft of farCamera (distance ~3.88ft). Both axis
    // fallbacks — (2.5, 0) at ~5.69ft and (1, 2.5) at ~5.19ft from the
    // camera — are also inside that 5.85ft disk, so all three candidates
    // are refused purely by the exclusion rule and the position holds at
    // (1, 0).
    const r = resolvePlacement(
      { kind: "bed", rotation: 0, x: 2.5, z: 2.5, fromX: 1, fromZ: 0 },
      [],
      room,
      farCamera,
    );
    eq(r, { x: 1, z: 0 }, "refused within the camera exclusion disk on every candidate axis");
  });

  check("rotation widens the footprint box", () => {
    const flat = footprintAabb("bed", 0, 0, 0);
    const turned = footprintAabb("bed", 0, 0, Math.PI / 2);
    assert(
      Math.abs(flat.maxX - flat.minX - (turned.maxZ - turned.minZ)) < 1e-6,
      "a 90-degree turn should swap the extents",
    );
  });

  // ---- buildFurnitureMaterials ----
  const tokens = { wood: "walnut", soft: "cream boucle", stone: "marble" };
  const f = (id: string, kind: string) => ({ id, kind, x: 0.5, z: 0.5, rotation: 0 });

  check("an empty furniture list omits the line entirely", () => {
    eq(buildFurnitureMaterials([], tokens), "", "empty string, not 'zero pieces'");
  });

  check("phrases interpolate the brief's material tokens", () => {
    const line = buildFurnitureMaterials([f("1", "wardrobe")], tokens);
    assert(line.includes("walnut wardrobe"), `expected interpolation, got: ${line}`);
    assert(!line.includes("{wood}"), "token left uninterpolated");
  });

  check("output is stable catalogue order, not insertion order", () => {
    const a = buildFurnitureMaterials([f("1", "bed"), f("2", "plant")], tokens);
    const b = buildFurnitureMaterials([f("2", "plant"), f("1", "bed")], tokens);
    eq(a, b, "byte-identical regardless of insertion order");
  });

  check("duplicates of one type collapse to a single phrase", () => {
    const line = buildFurnitureMaterials([f("1", "nightstand"), f("2", "nightstand")], tokens);
    eq((line.match(/nightstand/g) ?? []).length, 1, "one mention");
  });

  check("the line never exceeds its budget and never truncates mid-phrase", () => {
    const many = ["bed", "wardrobe", "dresser", "nightstand", "bookshelf"].map((k, i) => f(String(i), k));
    const line = buildFurnitureMaterials(many, tokens, 80);
    assert(line.length <= 80, `over budget: ${line.length} chars — ${line}`);
    assert(line.endsWith("."), `truncated mid-phrase: ${line}`);
  });

  check("the lowest-priority item is dropped first under budget", () => {
    const line = buildFurnitureMaterials([f("1", "bed"), f("2", "plant")], tokens, 60);
    assert(line.includes("bed"), `bed (priority 100) should survive: ${line}`);
    assert(!line.includes("plant"), `plant (priority 15) should be dropped: ${line}`);
  });

  check("a single nightstand renders singular; two render the plural form", () => {
    const single = buildFurnitureMaterials([f("1", "nightstand")], tokens);
    assert(
      single.includes("walnut nightstand") && !single.includes("nightstands"),
      `expected the singular phrase for one nightstand, got: ${single}`,
    );
    const pair = buildFurnitureMaterials([f("1", "nightstand"), f("2", "nightstand")], tokens);
    assert(pair.includes("walnut nightstands"), `expected the plural phrase for two nightstands, got: ${pair}`);
  });

  const failed = results.filter((r) => !r.ok);
  return Response.json(
    { passed: results.length - failed.length, failed: failed.length, results },
    { status: failed.length ? 500 : 200 },
  );
}
