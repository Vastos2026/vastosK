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
import { openingFaceSamples } from "@/lib/greybox/build-scene";

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

  const failed = results.filter((r) => !r.ok);
  return Response.json(
    { passed: results.length - failed.length, failed: failed.length, results },
    { status: failed.length ? 500 : 200 },
  );
}
