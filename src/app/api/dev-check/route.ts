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
import { clamp } from "@/lib/ai/prompting/design-planning";
import { buildRoomPrompt } from "@/lib/ai/prompting/prompt-builder";
import type { DesignSpecification, UniversalInput, UniversalInputRoom } from "@/lib/ai/prompting/types";
// Pure aspect-tolerance guard (Task 13, section 3.4) — no network call, safe
// to import here even though the rest of runware-client.ts does real HTTP.
import { assertGenerationAspect } from "@/lib/render/runware-client";

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

  // ---- buildRoomPrompt (Task 12: 512-token-budget rewrite) ----
  const uiInput: UniversalInput = {
    project: { category: "Residential", subcategory: "Independent House" },
    layout: { rooms: [] },
    design: { style: "Modern", luxury_level: "Premium", colour_palette: "warm neutrals" },
  };
  const uiRoom: UniversalInputRoom = { name: "Master Bedroom", type: "Bedroom" };
  const dspec: DesignSpecification = {
    // Verbose fields — deliberately oversized. None of this may reach the
    // image prompt any more; only compactBrief/compactGuidance/materialTokens do.
    designLanguage: "x".repeat(400),
    materialPalette: "x".repeat(400),
    lightingStrategy: "x".repeat(400),
    colourStrategy: "x".repeat(400),
    furnitureLanguage: "x".repeat(400),
    cameraGuidelines: "x".repeat(400),
    negativeConstraints: "x".repeat(400),
    compactBrief: "Warm neutrals over walnut and honed limestone, soft morning light from one side.",
    materialTokens: { wood: "walnut", soft: "cream boucle", stone: "honed limestone" },
    roomGuidelines: [{ room: "Master Bedroom", guidance: "y".repeat(500), compactGuidance: "Keep the palette calm." }],
  };

  await checkAsync("the verbose design spec never reaches the prompt", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 1, windows: 2 } });
    assert(!p.includes("x".repeat(50)), "a verbose field leaked into the prompt");
    assert(!p.includes("y".repeat(50)), "verbose room guidance leaked into the prompt");
  });

  await checkAsync("prompt stays under the 1800-char cap", async () => {
    const p = await buildRoomPrompt(uiInput, { ...uiRoom, additional_notes: "z".repeat(2000) }, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 2 },
      furniture: [f("1", "bed"), f("2", "nightstand"), f("3", "wardrobe")],
    });
    assert(p.length <= 1800, `prompt is ${p.length} chars`);
  });

  await checkAsync("the ledger uses number words, not digits", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 1, windows: 2 } });
    assert(p.includes("two windows and one door"), `expected word-form counts, got: ${p}`);
    assert(!/\b[0-9]+ (window|door)/.test(p), "digits used for opening counts");
  });

  await checkAsync("the furniture-placed clause agrees in number: singular noun+verb for one piece, plural for more", async () => {
    // Correction 3 fixed subject-verb agreement in openingLedger ("One
    // furniture piece IS already placed." vs "Two furniture pieces ARE
    // already placed.") — this is the assertion that actually protects it.
    // Asserting the full clause, not just the verb in isolation, so a
    // regression in either the noun or the verb fails this.
    const single = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: [f("1", "bed")],
    });
    assert(single.includes("One furniture piece is already placed."), `expected singular noun+verb, got: ${single}`);

    const many = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: [f("1", "bed"), f("2", "nightstand")],
    });
    assert(many.includes("Two furniture pieces are already placed."), `expected plural noun+verb, got: ${many}`);
  });

  await checkAsync("no deleted phrasing survives", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: [f("1", "bed")],
    });
    for (const banned of ["defect", "Count them", "Do not", "no more", "tack-sharp", "watermark", "near the"]) {
      assert(!p.toLowerCase().includes(banned.toLowerCase()), `banned phrasing "${banned}" is still in the prompt`);
    }
  });

  await checkAsync("a room with no openings gets a positive statement", async () => {
    const p = await buildRoomPrompt(uiInput, uiRoom, dspec, { hasGreybox: true, ledger: { doors: 0, windows: 0 } });
    assert(p.includes("Every wall in this room is solid."), `expected positive phrasing, got: ${p}`);
  });

  await checkAsync("reordering furniture does not change a single byte of the prompt", async () => {
    // The real invariant (not "same args in, same string out", which no
    // clock/randomness/shared-mutable-state function could ever fail):
    // moving a piece in the 3D editor reorders room.furniture, and that must
    // not bust the prompt cache. Two arrays, same three items, deliberately
    // in two DIFFERENT orders — and neither order is catalogue order
    // (bed, nightstand, wardrobe), so a naive insertion-order implementation
    // would render each array differently and this fixture would catch it.
    const furnitureA = [f("1", "wardrobe"), f("2", "bed"), f("3", "nightstand")];
    const furnitureB = [f("3", "nightstand"), f("1", "wardrobe"), f("2", "bed")];
    assert(
      furnitureA.map((x) => x.kind).join(",") !== furnitureB.map((x) => x.kind).join(","),
      "fixture must present furniture in genuinely different orders, or this proves nothing",
    );
    const pA = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: furnitureA,
    });
    const pB = await buildRoomPrompt(uiInput, uiRoom, dspec, {
      hasGreybox: true,
      ledger: { doors: 1, windows: 1 },
      furniture: furnitureB,
    });
    eq(pA, pB, "reordering furniture must not change the prompt");
  });

  await checkAsync("an unbounded non-greybox style/subcategory cannot be trimmed into budget and throws, naming the room", async () => {
    // The contract clause is never trimmed by the overflow ladder (by
    // design — section 4.4 never trims the contract or the ledger), so for
    // the non-greybox path (where the contract interpolates input.design.style
    // and input.project.subcategory unbounded) a pathologically long value
    // cannot be rescued by dropping accent/furniture/brief. buildRoomPrompt
    // must reject rather than silently send an over-budget prompt.
    const overlongInput: UniversalInput = {
      project: { category: "Custom", subcategory: "S".repeat(5000) },
      layout: { rooms: [] },
      design: { style: "Modern", luxury_level: "Premium", colour_palette: "warm neutrals" },
    };
    let threw = false;
    let message = "";
    try {
      await buildRoomPrompt(overlongInput, uiRoom, dspec, { hasGreybox: false });
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    assert(threw, "expected buildRoomPrompt to throw for an unbounded non-greybox contract");
    assert(message.includes(uiRoom.name), `error message should name the room, got: ${message}`);
  });

  await checkAsync("the overflow ladder trims the brief but preserves the furniture line", async () => {
    // Sized (see task-12-report.md for the arithmetic) so the assembled
    // prompt lands at 1827 chars — just over the 1800 cap — with a single
    // furniture kind (so buildFurnitureMaterials' own budget-100 retry is a
    // no-op: one entry can never be dropped) and no accent. That forces the
    // THIRD ladder stage (brief trimming) to be the one that brings it back
    // under budget, proving furniture is trimmed/preserved, never dropped
    // outright, unlike the earlier buggy stage 3 this fixture was written to
    // catch.
    const overflowInput: UniversalInput = {
      project: { category: "Custom", subcategory: "S".repeat(1500) },
      layout: { rooms: [] },
      design: { style: "Modern", luxury_level: "Premium", colour_palette: "warm neutrals" },
    };
    const p = await buildRoomPrompt(overflowInput, uiRoom, dspec, {
      hasGreybox: false,
      furniture: [f("1", "bed")],
    });
    assert(p.length <= 1800, `prompt is ${p.length} chars, ladder failed to bring it under budget`);
    assert(p.includes("cream boucle"), `furniture material phrase dropped from prompt: ${p}`);
  });

  // ---- clamp (design-planning.ts) ----
  check("clamp: a string already under the limit is trimmed but otherwise unchanged", () => {
    eq(clamp("  Hello world  ", 50), "Hello world", "surrounding whitespace trimmed, content untouched");
  });

  check("clamp: an overlong string is cut at a word boundary, never mid-word", () => {
    // 20 space-joined "wordN" tokens; max=15 lands inside "word2" (the third
    // token), so a correct clamp backs up to the last full token ("word1")
    // instead of returning the partial "...wor" fragment.
    const s = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const out = clamp(s, 15);
    eq(out, "word0 word1", "cut lands after the last complete word, dropping the partial one");
    assert(out.length <= 15, `over budget: ${out.length}`);
  });

  check("clamp: falls back to a hard cut when the only boundary is before 60% of max", () => {
    // Single space at index 2, then an unbroken 40-char run with no further
    // boundary. At max=20 the only candidate boundary (that space) sits at
    // stop=2, well under max*0.6=12 — so the `stop > max * 0.6` guard must
    // reject it and fall back to the raw 20-char hard cut ("ab " + 17 x's).
    // Without the guard, clamp would instead cut at that early boundary and
    // return the near-useless "ab" (2 chars) — a very different, much
    // shorter result, so this fixture genuinely distinguishes the two paths.
    const s = "ab " + "x".repeat(40);
    const out = clamp(s, 20);
    eq(out, "ab " + "x".repeat(17), "hard cut used, not the early word boundary");
    eq(out.length, 20, "uses the full budget rather than backing up to the early boundary");
  });

  check("clamp: a trailing comma or semicolon left by the cut is stripped", () => {
    // max=8 lands the word-boundary cut exactly on "Alpha," (comma included);
    // clamp must strip the trailing punctuation the boundary cut leaves behind.
    const out = clamp("Alpha, beta gamma delta epsilon zeta eta theta iota kappa", 8);
    eq(out, "Alpha", "trailing comma stripped");
  });

  check("clamp: undefined or empty input returns an empty string", () => {
    eq(clamp(undefined, 240), "", "undefined input");
    eq(clamp("", 240), "", "empty input");
  });

  check("clamp: a late sentence boundary wins over a later word boundary, period included", () => {
    // max=30: "Warm walnut and stone. Soft li" is the raw cut. Its ". "
    // boundary sits at index 21 (past max*0.6=18, so it's late enough to
    // prefer), and a LATER plain-space word boundary sits at index 27
    // (after "Soft"). A clamp that (wrongly) always picks the word boundary
    // would return "Warm walnut and stone. Soft" — the sentence-aware clamp
    // must instead stop at the sentence, WITH its period.
    const out = clamp("Warm walnut and stone. Soft light everywhere across the room", 30);
    eq(out, "Warm walnut and stone.", "cuts at the sentence, period included, not the later word boundary");
  });

  // ---- assertGenerationAspect (Task 13, section 3.4: the FLUX camera-match guard) ----
  check("assertGenerationAspect: the greybox's own 1376x768 passes", () => {
    assertGenerationAspect(GREYBOX_RENDER_W, GREYBOX_RENDER_H); // must not throw
  });

  check(
    "assertGenerationAspect: 1280x704 (IMAGE_DIMENSIONS.sd — the real, currently-shipping mismatch) throws, naming both aspects",
    () => {
      let threw = false;
      let message = "";
      try {
        assertGenerationAspect(1280, 704);
      } catch (e) {
        threw = true;
        message = (e as Error).message;
      }
      assert(threw, "expected assertGenerationAspect(1280, 704) to throw — this is the mismatch the guard exists to catch");
      assert(message.includes("1280x704"), `error must name the offending dimensions, got: ${message}`);
      assert(
        message.includes(GREYBOX_ASPECT.toFixed(4)),
        `error must name the greybox aspect a human can compare against, got: ${message}`,
      );
    },
  );

  check(
    "assertGenerationAspect: a pair inside the 0.002 tolerance but not exactly equal passes (proves this is a tolerance check, not an equality check)",
    () => {
      // 1380x770 is deliberately NOT 1376x768 (nor any integer multiple of
      // it) but its ratio (1.79221) sits well inside the 0.002 tolerance
      // band around GREYBOX_ASPECT (1.79167, drift ~0.00054). A stricter
      // `width / height === GREYBOX_ASPECT` equality check would reject this
      // exact pair (confirmed live: 1380/770 !== 1376/768 as floats) — so a
      // fixture that passed under BOTH an equality check and this tolerance
      // check would prove nothing about which one is actually implemented.
      const width = 1380;
      const height = 770;
      assert(
        width / height !== GREYBOX_ASPECT,
        "fixture must not be an exact match to GREYBOX_ASPECT, or this proves nothing about tolerance vs equality",
      );
      const drift = Math.abs(width / height - GREYBOX_ASPECT);
      assert(drift > 0 && drift <= 0.002, `fixture must actually sit inside tolerance, drift was ${drift}`);
      assertGenerationAspect(width, height); // must not throw
    },
  );

  check("GREYBOX_ASPECT is derived from GREYBOX_RENDER_W/GREYBOX_RENDER_H, not a separately hardcoded literal", () => {
    // If GREYBOX_ASPECT were ever replaced with a hardcoded `1.7917` (the
    // rounded value someone might reasonably hand-copy), this fails: 1376/768
    // is 1.7916666666666667 in floating point, not 1.7917 — proving the
    // documented "change the two W/H numbers and nothing else moves" claim
    // actually holds, rather than silently relying on a second copy agreeing
    // by coincidence.
    eq(
      GREYBOX_ASPECT,
      GREYBOX_RENDER_W / GREYBOX_RENDER_H,
      "GREYBOX_ASPECT must equal a live division of the two exported dimensions",
    );
  });

  // ---- greyboxCamera (Task 14: the fixed-camera editor's aspect contract) ----
  // The editor viewport is locked to GREYBOX_ASPECT rather than the
  // container's own aspect (task-14-report.md, "Resolution 1") specifically
  // BECAUSE aspect can flip which of camera.ts's 8 candidate viewpoints wins
  // — this fixture is a real, verified instance of that, not a hypothetical:
  // a 30x8ft room with a single door centred on the north wall. At
  // GREYBOX_ASPECT the SW corner candidate wins (its wider horizontal FOV
  // pulls the door's projection close enough to frame-centre to beat the
  // south-wall-midpoint candidate on the tie-break "spread" metric); at a
  // portrait 9:16 aspect, the corner's narrower horizontal FOV pushes that
  // same door too far off-axis and south-mid wins instead — an 11.5ft swing
  // in camera X (-13.8 vs 0), not a rounding-level difference. If the editor
  // used the viewport's own aspect instead, a browser window resize alone
  // could silently re-pick this same wrong candidate.
  const cameraContractSpec: GreyboxRoomSpec = {
    width: 30,
    depth: 8,
    openings: [{ id: "d1", type: "door", wall: "north", t: 0.5, span: 0.15 }],
  };
  const PORTRAIT_ASPECT = 9 / 16; // ~0.5625 vs GREYBOX_ASPECT's ~1.7917 — not adjacent, not a rounding neighbour.

  check("greyboxCamera: GREYBOX_ASPECT and a clearly different aspect select materially different cameras", () => {
    const wide = greyboxCamera(cameraContractSpec, GREYBOX_ASPECT);
    const portrait = greyboxCamera(cameraContractSpec, PORTRAIT_ASPECT);
    eq(
      { x: wide.position.x, y: wide.position.y, z: wide.position.z },
      { x: -13.8, y: 5, z: 3.68 },
      "GREYBOX_ASPECT must win the SW corner candidate for this fixture",
    );
    eq(
      { x: portrait.position.x, y: portrait.position.y, z: portrait.position.z },
      { x: 0, y: 5, z: 3.68 },
      "the portrait aspect must win the south-wall-midpoint candidate instead",
    );
    assert(
      Math.abs(wide.position.x - portrait.position.x) > 1,
      `expected a material (>1ft) camera-X difference between aspects, got ${wide.position.x} vs ${portrait.position.x}`,
    );
  });

  check("greyboxCamera: deterministic — the same (spec, aspect) yields an identical camera on every call", () => {
    const a = greyboxCamera(cameraContractSpec, GREYBOX_ASPECT);
    const b = greyboxCamera(cameraContractSpec, GREYBOX_ASPECT);
    eq(a.position.toArray(), b.position.toArray(), "position");
    eq(a.quaternion.toArray(), b.quaternion.toArray(), "orientation (the lookAt target)");
    eq(a.fov, b.fov, "fov");
  });

  const failed = results.filter((r) => !r.ok);
  return Response.json(
    { passed: results.length - failed.length, failed: failed.length, results },
    { status: failed.length ? 500 : 200 },
  );
}
