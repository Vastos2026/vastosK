"use client";

import { useMemo, useState } from "react";
import { GreyboxPreview } from "@/components/project/greybox-preview";
import { openingCentre } from "@/lib/greybox/build-scene";
import { greyboxCamera } from "@/lib/greybox/camera";
import type { GreyboxRoomSpec } from "@/lib/greybox/types";

/**
 * THROWAWAY — Phase 0 proof spike. Delete with the rest of the spike files
 * once the gate decision is recorded. Unlinked from the app on purpose.
 *
 * Grounded in the top-right BEDROOM 13'1" x 14'9" of
 * 3BHK-house-plan-ground-floor.jpg. The opening positions are hand-authored,
 * not traced — deliberately ASYMMETRIC so "did the model put it where we said"
 * is objectively checkable rather than passable by a lucky centred guess.
 */

const SPIKE_ROOM: GreyboxRoomSpec = {
  width: 13.08,
  depth: 14.75,
  openings: [
    { id: "d1", type: "door", wall: "south", t: 0.28, span: 0.22 },
    { id: "w1", type: "window", wall: "east", t: 0.3, span: 0.34 },
    { id: "w2", type: "window", wall: "north", t: 0.72, span: 0.3 },
  ],
};

export default function GreyboxSpikePage() {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  // Where each opening lands in the rendered frame, so the greybox can be
  // checked against the SPEC rather than just eyeballed. A mirrored wall axis
  // would look perfectly plausible in the render and would silently corrupt
  // every plan-editor mapping later — this is the check that catches it.
  const debug = useMemo(() => {
    const camera = greyboxCamera(SPIKE_ROOM, 1376 / 768);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const p = camera.position;
    return {
      camera: `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
      openings: SPIKE_ROOM.openings.map((o) => {
        const ndc = openingCentre(SPIKE_ROOM, o).project(camera);
        // NDC x: -1 = left edge, +1 = right edge.
        return `${o.type} on ${o.wall} (t=${o.t}) → screen x ${ndc.x.toFixed(2)}, y ${ndc.y.toFixed(2)}`;
      }),
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="text-xl font-bold">Greybox spike</h1>
      <p className="mt-1 text-sm text-muted">
        Bedroom 13&apos;1&quot; x 14&apos;9&quot;. Door on the south wall left-of-centre, window on the east
        wall towards its north end, window on the north wall towards its east end.
      </p>
      <div className="mt-6">
        <GreyboxPreview spec={SPIKE_ROOM} width={1376} height={768} onReady={setDataUrl} />
      </div>
      <p className="mt-2 text-xs text-faint">
        {dataUrl ? `PNG ready (${dataUrl.length} chars)` : "rendering..."}
      </p>
      <pre id="greybox-debug" className="mt-2 text-xs text-muted">
        {`camera ${debug.camera}\n${debug.openings.join("\n")}`}
      </pre>
    </div>
  );
}
