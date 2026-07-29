"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject, useVasto } from "@/lib/store";
import { emptyPlan } from "@/lib/pipeline/empty-plan";
import { categoryForPropertyType, getProjectTypeConfig } from "@/lib/project-types/config";
import { fromFeet, ftInToFeet, feetToFtIn, toFeet, formatDimensions } from "@/lib/units";
import { UNITS } from "@/lib/data";
import { ROOM_PALETTE, cn, uid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SketchCanvas } from "@/components/project/sketch-canvas";
import {
  splitCellByLine,
  computeEdgeMeta,
  computeFeetPerPixel,
  cellDimensionsFt,
  type CellData,
  type EdgeMeta,
  type Pt,
} from "@/lib/sketch/geometry";
import type { Room, Unit } from "@/lib/types";
import type { RoomOpening } from "@/lib/pipeline/assign-openings";

/**
 * The Sketch Tool (docs/VASTOS_REVAMP_PLAN.md's "No-floor-plan flow: Sketch
 * Tool") — the "No, not yet" answer on the Floor Plan screen routes here
 * instead of straight into an empty Room Confirmation list. Four steps:
 * draw the outer boundary, calibrate it against one real-world measurement,
 * subdivide it into rooms with straight cut lines, then fill in each room's
 * type/size and click-to-cycle doors/windows. The output is a plain `Room[]`
 * handed to the exact same store actions the manual-entry and upload paths
 * already use — Room Confirmation itself is untouched.
 */

type Step = "boundary" | "scale" | "divide" | "rooms";

interface RoomDraft {
  name: string;
  type: string;
  widthFt: number;
  heightFt: number;
  /** true once the user has hand-edited the drawn-from-the-cell size */
  overridden: boolean;
  /** edgeIndex -> opening kind */
  openings: Record<number, "door" | "window">;
}

const STEPS: { id: Step; label: string }[] = [
  { id: "boundary", label: "Boundary" },
  { id: "scale", label: "Scale" },
  { id: "divide", label: "Rooms" },
  { id: "rooms", label: "Details" },
];

export default function SketchPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useProject(id);
  const setFloorPlan = useVasto((s) => s.setFloorPlan);
  const setStatus = useVasto((s) => s.setStatus);
  const patchProject = useVasto((s) => s.patchProject);

  const [step, setStep] = useState<Step>("boundary");
  const [boundaryPts, setBoundaryPts] = useState<Pt[]>([]);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [refFt, setRefFt] = useState(10);
  const [refIn, setRefIn] = useState(0);
  const [feetPerPixel, setFeetPerPixel] = useState(0);
  const [cells, setCells] = useState<CellData[]>([]);
  const [cutError, setCutError] = useState<string | null>(null);
  const [edgeMeta, setEdgeMeta] = useState<EdgeMeta[][]>([]);
  const [rooms, setRooms] = useState<RoomDraft[]>([]);

  const cellColors = cells.map((_, i) => ROOM_PALETTE[i % ROOM_PALETTE.length]);

  const openingsFlat = useMemo(() => {
    const out: Record<string, "door" | "window"> = {};
    rooms.forEach((r, ci) => {
      Object.entries(r.openings).forEach(([ei, kind]) => {
        out[`${ci}:${ei}`] = kind;
      });
    });
    return out;
  }, [rooms]);

  if (!project) return null;

  const unit: Unit = project.units ?? "ft-in";
  const category = categoryForPropertyType(project.propertyType);
  const roomTypes = getProjectTypeConfig(category)?.roomTypes ?? [];

  const handleBoundaryPoint = (pt: Pt) => setBoundaryPts((prev) => [...prev, pt]);

  const handleBoundaryClose = () => {
    if (boundaryPts.length < 3) return;
    setStep("scale");
  };

  const confirmScale = () => {
    const enteredFeet = ftInToFeet(refFt, refIn);
    if (enteredFeet <= 0 || containerSize.w === 0) return;
    const fpp = computeFeetPerPixel(boundaryPts[0], boundaryPts[1], containerSize.w, containerSize.h, enteredFeet);
    setFeetPerPixel(fpp);
    setCells([{ points: boundaryPts, boundaryFlags: boundaryPts.map(() => true) }]);
    setStep("divide");
  };

  const handleCutComplete = (a: Pt, b: Pt) => {
    for (let i = 0; i < cells.length; i++) {
      const result = splitCellByLine(cells[i], a, b);
      if (result) {
        const next = [...cells];
        next.splice(i, 1, result[0], result[1]);
        setCells(next);
        setCutError(null);
        return;
      }
    }
    setCutError("That line needs to fully cross one room, from one side to the other. Try a different line.");
  };

  const finishDividing = () => {
    setEdgeMeta(computeEdgeMeta(cells));
    setRooms(
      cells.map((cell, i) => {
        const { width, height } = cellDimensionsFt(cell, containerSize.w, containerSize.h, feetPerPixel);
        return {
          name: `Room ${i + 1}`,
          type: "",
          widthFt: Math.max(1, Math.round(width * 10) / 10),
          heightFt: Math.max(1, Math.round(height * 10) / 10),
          overridden: false,
          openings: {},
        };
      }),
    );
    setStep("rooms");
  };

  const updateRoom = (i: number, patch: Partial<RoomDraft>) =>
    setRooms((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const cycleOpening = (cellIndex: number, edgeIndex: number) => {
    setRooms((prev) =>
      prev.map((r, i) => {
        if (i !== cellIndex) return r;
        const current = r.openings[edgeIndex];
        const openings = { ...r.openings };
        if (current === undefined) openings[edgeIndex] = "door";
        else if (current === "door") openings[edgeIndex] = "window";
        else delete openings[edgeIndex];
        return { ...r, openings };
      }),
    );
  };

  const finish = () => {
    const finalRooms: Room[] = cells.map((_, i) => {
      const r = rooms[i];
      const openings: RoomOpening[] = Object.entries(r.openings).map(([edgeIndexStr, kind]) => {
        const edgeIndex = Number(edgeIndexStr);
        const m = edgeMeta[i][edgeIndex];
        const connectsTo = m.isExterior
          ? "exterior"
          : m.neighborIndex !== null
            ? rooms[m.neighborIndex].name.trim() || `Room ${m.neighborIndex + 1}`
            : null;
        return { type: kind, side: m.side, connectsTo };
      });
      return {
        id: uid("room"),
        name: r.name.trim() || `Room ${i + 1}`,
        type: r.type || undefined,
        width: r.widthFt,
        height: r.heightFt,
        x: 0,
        y: 0,
        color: ROOM_PALETTE[i % ROOM_PALETTE.length],
        openings: openings.length > 0 ? openings : undefined,
      };
    });

    setFloorPlan(id, { ...emptyPlan(), rooms: finalRooms });
    setStatus(id, "parsed");
    router.push(`/projects/${id}/review`);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Sketch your floor plan</h2>
          <p className="mt-1 text-sm text-muted">
            A quick whiteboard sketch. Draw the outline, split it into rooms, then add doors and windows.
          </p>
        </div>

        <StepDots step={step} />

        <div className={cn("mt-6 grid gap-6", step === "rooms" && "lg:grid-cols-[1.2fr_1fr]")}>
          <div>
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-border bg-grid bg-surface">
              <SketchCanvas
                mode={step === "divide" ? "cut" : step}
                boundaryPoints={boundaryPts}
                onBoundaryPoint={handleBoundaryPoint}
                onBoundaryClose={handleBoundaryClose}
                cells={cells}
                cellColors={cellColors}
                onCutComplete={handleCutComplete}
                openings={openingsFlat}
                onEdgeClick={cycleOpening}
                onResize={(w, h) => setContainerSize({ w, h })}
              />
            </div>

            {step === "boundary" && (
              <div className="mt-3 flex items-start justify-between gap-3">
                <p className="text-xs text-muted">
                  Click to place points around the outer wall. Click near the first point again (it turns
                  green) or press Close boundary once you have at least 3 points. Each new edge snaps to the
                  nearest 15 degrees, so walls come out straight.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {boundaryPts.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setBoundaryPts([])}>
                      Clear
                    </Button>
                  )}
                  <Button size="sm" disabled={boundaryPts.length < 3} onClick={handleBoundaryClose}>
                    Close boundary
                  </Button>
                </div>
              </div>
            )}

            {step === "scale" && (
              <div className="mt-4 rounded-2xl border border-border bg-surface-2 p-4">
                <p className="text-sm font-medium">How long is the highlighted edge (in green)?</p>
                <p className="mt-1 text-xs text-muted">
                  That&apos;s the only measurement you need to enter. Every room&apos;s size is worked out from it.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <input
                      type="number"
                      min={0}
                      value={refFt}
                      onChange={(e) => setRefFt(Math.max(0, Number(e.target.value) || 0))}
                      className="input w-16"
                      aria-label="Reference edge feet"
                    />
                    ft
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <input
                      type="number"
                      min={0}
                      max={11}
                      value={refIn}
                      onChange={(e) => setRefIn(Math.max(0, Math.min(11, Number(e.target.value) || 0)))}
                      className="input w-14"
                      aria-label="Reference edge inches"
                    />
                    in
                  </span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    iconRight="ArrowRight"
                    onClick={confirmScale}
                    disabled={ftInToFeet(refFt, refIn) <= 0}
                  >
                    Confirm and continue
                  </Button>
                </div>
              </div>
            )}

            {step === "divide" && (
              <div className="mt-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-muted">
                    Click two points on opposite sides of a room to draw a straight wall splitting it in two.
                    Repeat until every room is its own colour.
                  </p>
                  {cutError && <p className="mt-1 text-xs text-danger">{cutError}</p>}
                </div>
                <Button size="sm" className="shrink-0" iconRight="ArrowRight" onClick={finishDividing}>
                  Done dividing ({cells.length} room{cells.length === 1 ? "" : "s"})
                </Button>
              </div>
            )}

            {step === "rooms" && (
              <p className="mt-3 text-xs text-muted">
                Click a wall to cycle it: none, door, then window. A door or window on a shared wall
                automatically connects the two rooms; on the outer wall it connects to the exterior.
              </p>
            )}
          </div>

          {step === "rooms" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Rooms ({rooms.length})</h3>
                <UnitSelect value={unit} onChange={(u) => patchProject(id, { units: u })} />
              </div>
              <div className="scrollbar-thin max-h-[28rem] space-y-2.5 overflow-y-auto pr-1">
                {rooms.map((r, i) => (
                  <RoomCardEditor
                    key={i}
                    index={i}
                    room={r}
                    color={cellColors[i]}
                    unit={unit}
                    roomTypes={roomTypes}
                    onChange={(patch) => updateRoom(i, patch)}
                  />
                ))}
              </div>
              <Button className="w-full" iconRight="ArrowRight" onClick={finish}>
                Continue to Room Confirmation
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDots({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              i === idx ? "bg-accent/15 text-accent" : i < idx ? "text-success" : "text-faint",
            )}
          >
            <span
              className={cn(
                "grid size-4 place-items-center rounded-full text-[9px]",
                i === idx ? "bg-accent text-accent-foreground" : i < idx ? "bg-success/20" : "bg-surface-3",
              )}
            >
              {i < idx ? <Icon name="Check" className="size-2.5" /> : i + 1}
            </span>
            {s.label}
          </span>
          {i < STEPS.length - 1 && <Icon name="ChevronRight" className="size-3 text-faint" />}
        </div>
      ))}
    </div>
  );
}

function UnitSelect({ value, onChange }: { value: Unit; onChange: (u: Unit) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Units
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Unit)}
        className="input cursor-pointer !w-auto !py-1.5 text-xs"
        aria-label="Units"
      >
        {UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RoomCardEditor({
  index,
  room,
  color,
  unit,
  roomTypes,
  onChange,
}: {
  index: number;
  room: RoomDraft;
  color: string;
  unit: Unit;
  roomTypes: string[];
  onChange: (patch: Partial<RoomDraft>) => void;
}) {
  const doors = Object.values(room.openings).filter((k) => k === "door").length;
  const windows = Object.values(room.openings).filter((k) => k === "window").length;

  return (
    <div className="rounded-2xl border border-border bg-surface p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="size-3 shrink-0 rounded-sm" style={{ background: color }} />
        <input
          value={room.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="input min-w-0 flex-1 font-medium"
          aria-label={`Room ${index + 1} name`}
        />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {roomTypes.length > 0 ? (
          <select
            value={room.type}
            onChange={(e) => onChange({ type: e.target.value })}
            className="input w-36 shrink-0 cursor-pointer"
            aria-label={`Room ${index + 1} type`}
          >
            <option value="">Unset type</option>
            {roomTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={room.type}
            onChange={(e) => onChange({ type: e.target.value })}
            placeholder="Room type"
            className="input w-36 shrink-0"
            aria-label={`Room ${index + 1} type`}
          />
        )}

        {room.overridden ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <DimensionField label="W" feet={room.widthFt} unit={unit} onChange={(v) => onChange({ widthFt: v })} />
            <DimensionField label="H" feet={room.heightFt} unit={unit} onChange={(v) => onChange({ heightFt: v })} />
          </div>
        ) : (
          <span className="text-xs text-muted">{formatDimensions(room.widthFt, room.heightFt, unit)}</span>
        )}
        <button
          type="button"
          onClick={() => onChange({ overridden: !room.overridden })}
          className="cursor-pointer text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          {room.overridden ? "Use drawn size" : "Override size"}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: "#e6c15c" }} />
          {doors} door{doors === 1 ? "" : "s"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: "#6da8e2" }} />
          {windows} window{windows === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function DimensionField({
  label,
  feet,
  unit,
  onChange,
}: {
  label: string;
  feet: number;
  unit: Unit;
  onChange: (feet: number) => void;
}) {
  if (unit === "ft-in") {
    const { ft, inches } = feetToFtIn(feet);
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
        {label}
        <input
          type="number"
          value={ft}
          onChange={(e) => onChange(ftInToFeet(Number(e.target.value) || 0, inches))}
          className="input w-14"
          aria-label={`${label} feet`}
        />
        <span className="text-faint">ft</span>
        <input
          type="number"
          min={0}
          max={11}
          value={inches}
          onChange={(e) => onChange(ftInToFeet(ft, Number(e.target.value) || 0))}
          className="input w-12"
          aria-label={`${label} inches`}
        />
        <span className="text-faint">in</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
      {label}
      <input
        type="number"
        value={fromFeet(feet, unit)}
        onChange={(e) => onChange(toFeet(Number(e.target.value) || 0, unit))}
        className="input w-16"
        aria-label={label}
      />
      <span className="text-faint">{unit}</span>
    </span>
  );
}
