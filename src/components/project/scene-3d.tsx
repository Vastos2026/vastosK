"use client";

import { useEffect, useMemo, type MutableRefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows, PerspectiveCamera } from "@react-three/drei";
import type { Door, FloorPlan, PlacedItem, DesignStyle, Window } from "@/lib/types";
import type { RenderView } from "@/lib/render/flux-client";

const WALL_H = 9;
const WALL_T = 0.4;

/** A focused room's four walls, by compass side (scene-space). */
type Side = "n" | "s" | "e" | "w";

/**
 * Renders a frame and returns it as a PNG data URI. Pass a `view` to capture
 * that angle of the focused room (corner/front/side/top); omit it for the
 * current interactive framing.
 */
export type CaptureFn = (view?: RenderView) => string | null;

type CameraPose = { pos: [number, number, number]; target: [number, number, number] };

/** A room's plan-space bounds (feet, top-left origin) to frame the camera on. */
export interface SceneFocus {
  x: number;
  y: number;
  width: number;
  height: number;
  /** ceiling height in feet; walls are drawn this tall (defaults to WALL_H). */
  ceilingFt?: number;
}

interface SceneProps {
  plan: FloorPlan;
  items: PlacedItem[];
  style: DesignStyle;
  selectedId: string | null;
  onSelectItem: (id: string | null) => void;
  /** Populated with a capture function so callers can screenshot the scene. */
  captureRef?: MutableRefObject<CaptureFn | null>;
  /** When set, frame the camera on this room (room-by-room flow). */
  focusRoom?: SceneFocus | null;
}

export default function Scene3D({
  plan,
  items,
  style,
  selectedId,
  onSelectItem,
  captureRef,
  focusRoom,
}: SceneProps) {
  const cx = plan.planWidth / 2;
  const cz = plan.planHeight / 2;

  // Camera pose for a given view — framed on the focused room (4 angles), else
  // the whole plan. Plan→scene coords subtract the plan centre (cx, cz).
  const cameraFor = (view: RenderView | "default"): CameraPose => {
    if (focusRoom) {
      // INTERIOR "missing fourth wall" cameras: stand just OUTSIDE the room and
      // look in through the wall nearest the camera (that wall is removed per
      // view during capture). Being outside the footprint means the camera can
      // never sit inside furniture or a wall — the clipping that made furnished
      // rooms render as dark boxes. The far + side walls frame a magazine shot.
      const tx = focusRoom.x + focusRoom.width / 2 - cx;
      const tz = focusRoom.y + focusRoom.height / 2 - cz;
      const hw = focusRoom.width / 2;
      const hd = focusRoom.height / 2;
      const span = Math.max(focusRoom.width, focusRoom.height);
      const EYE = 5.4; // eye level (ft) — magazine framing
      const LOOK = 2.3; // aim low so the floor + furniture are the subject
      const OUT = span * 0.45 + 2.5; // stand this far beyond the near wall
      switch (view) {
        case "front": // camera south of the room, looking north (faces the front wall)
          return { pos: [tx, EYE, tz + hd + OUT], target: [tx, LOOK, tz - hd * 0.15] };
        case "side": // camera east of the room, looking west
        case "left": // face the LEFT (west) wall head-on — camera east, looking west
          return { pos: [tx + hw + OUT, EYE, tz], target: [tx - hw * 0.15, LOOK, tz] };
        case "right": // face the RIGHT (east) wall head-on — camera west, looking east
          return { pos: [tx - hw - OUT, EYE, tz], target: [tx + hw * 0.15, LOOK, tz] };
        case "back": // face the BACK (south) wall head-on — camera north, looking south
          return { pos: [tx, EYE, tz - hd - OUT], target: [tx, LOOK, tz + hd * 0.15] };
        case "top": // straight-down dollhouse
          return { pos: [tx, span * 1.7 + 14, tz + 0.01], target: [tx, 0, tz] };
        case "corner-back": // OPPOSITE corner — outside the NW corner, looking SE
          // Aim across the room toward the far (SE) corner so two walls meet at a
          // central vertical edge — a true diagonal corner shot, not a flat wall.
          return {
            pos: [tx - hw - OUT * 0.7, EYE, tz - hd - OUT * 0.7],
            target: [tx + hw * 0.55, LOOK, tz + hd * 0.55],
          };
        default: // corner — outside the SE corner, looking to the far NW corner
          return {
            pos: [tx + hw + OUT * 0.7, EYE, tz + hd + OUT * 0.7],
            target: [tx - hw * 0.55, LOOK, tz - hd * 0.55],
          };
      }
    }
    return {
      pos: [plan.planWidth * 0.9, plan.planHeight * 1.1, plan.planHeight * 1.1],
      target: [0, 1.5, 0],
    };
  };

  const defaultView: RenderView | "default" = focusRoom ? "corner" : "default";
  const { pos: camPos, target } = cameraFor(defaultView);

  // Which of the focused room's walls sit between the camera and the room for a
  // view — removed so the outside camera can see in. The on-screen view uses the
  // default (corner); the capture toggles them per view.
  const hiddenForView = (view: RenderView | "default"): Side[] => {
    if (!focusRoom) return [];
    switch (view) {
      case "front":
        return ["s"];
      case "side":
      case "left":
        return ["e"]; // near east wall removed so we can see the west wall
      case "right":
        return ["w"];
      case "back":
        return ["n"];
      case "top":
        return [];
      case "corner-back":
        return ["n", "w"]; // opposite corner — hide the near NW walls
      default:
        return ["s", "e"]; // corner
    }
  };
  const hiddenSides = useMemo(
    () => new Set<Side>(focusRoom ? hiddenForView(defaultView) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusRoom, defaultView],
  );

  // Isolate the focused room: only its floor/walls/furniture are drawn (the
  // caller passes just this room's items). Without a focus, the whole plan shows.
  const fcx = focusRoom ? focusRoom.x + focusRoom.width / 2 - cx : 0;
  const fcz = focusRoom ? focusRoom.y + focusRoom.height / 2 - cz : 0;
  const spanW = focusRoom ? focusRoom.width : plan.planWidth;
  const spanH = focusRoom ? focusRoom.height : plan.planHeight;
  const wallRooms = focusRoom ? [focusRoom] : plan.rooms;

  return (
    <Canvas
      shadows
      frameloop="demand"
      dpr={[1, 1.5]}
      // Required so the WebGL backbuffer can be read back via toDataURL().
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onPointerMissed={() => onSelectItem(null)}
    >
      {captureRef && (
        <CaptureBridge
          captureRef={captureRef}
          cameraFor={cameraFor}
          defaultView={defaultView}
          hiddenForView={hiddenForView}
        />
      )}
      <color attach="background" args={["#0a0a0d"]} />
      <PerspectiveCamera makeDefault position={camPos} fov={focusRoom ? 58 : 42} />
      <OrbitControls
        target={target}
        enableDamping={false}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={focusRoom ? 1 : 8}
        maxDistance={90}
        makeDefault
      />

      {/* lighting */}
      <ambientLight intensity={0.6} />
      <hemisphereLight intensity={0.4} groundColor="#1a1410" />
      <directionalLight
        position={[plan.planWidth, 30, plan.planHeight]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />
      <pointLight position={[fcx, 7, fcz]} intensity={0.5} color={style.accentColor} distance={50} />

      {/* floor (room-sized when a room is focused) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[fcx, 0, fcz]} receiveShadow>
        <planeGeometry args={[spanW, spanH]} />
        <meshStandardMaterial color={style.floorColor} roughness={0.85} metalness={0.05} />
      </mesh>

      {/* walls (only the focused room's, when focused; near walls hidden so the
          outside camera can see in) */}
      <Walls
        rooms={wallRooms}
        cx={cx}
        cz={cz}
        color={style.wallColor}
        hiddenSides={focusRoom ? hiddenSides : undefined}
      />

      {/* door / window openings recessed into the focused room's walls, so the
          captured screenshot GROUNDS each opening's real position (the image
          model then renders the door/window there instead of inventing one). */}
      {focusRoom && (
        <Openings
          room={focusRoom}
          doors={plan.doors ?? []}
          windows={plan.windows ?? []}
          cx={cx}
          cz={cz}
          hiddenSides={hiddenSides}
        />
      )}

      {/* furniture */}
      {items.map((item) => (
        <FurnitureBox
          key={item.id}
          item={item}
          cx={cx}
          cz={cz}
          accent={style.accentColor}
          selected={item.id === selectedId}
          onSelect={onSelectItem}
        />
      ))}

      {/* grounding shadow */}
      <ContactShadows
        position={[fcx, 0.01, fcz]}
        scale={Math.max(spanW, spanH) * 1.4}
        resolution={512}
        far={10}
        blur={2}
        opacity={0.5}
      />

      {/* base platform */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[fcx, -0.05, fcz]} receiveShadow>
        <planeGeometry args={[spanW + 6, spanH + 6]} />
        <meshStandardMaterial color="#0e0e12" roughness={1} />
      </mesh>
    </Canvas>
  );
}

/**
 * Lives inside the Canvas so it can reach the renderer via `useThree`. Wires a
 * capture function into `captureRef` that forces a fresh frame (the canvas runs
 * `frameloop="demand"`) and reads it back as a PNG data URI.
 */
function CaptureBridge({
  captureRef,
  cameraFor,
  defaultView,
  hiddenForView,
}: {
  captureRef: MutableRefObject<CaptureFn | null>;
  cameraFor: (view: RenderView | "default") => CameraPose;
  defaultView: RenderView | "default";
  hiddenForView: (view: RenderView | "default") => Side[];
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    captureRef.current = (view) => {
      try {
        const v = view ?? defaultView;
        const { pos, target } = cameraFor(v);
        // Remove the wall(s) between the camera and the room for THIS view so the
        // outside camera can see in; remember each wall's prior visibility.
        const want = new Set(hiddenForView(v));
        const saved: { o: { visible: boolean }; vis: boolean }[] = [];
        scene.traverse((o) => {
          const side = (o.userData as { fwSide?: Side }).fwSide;
          if (side) {
            saved.push({ o, vis: o.visible });
            o.visible = !want.has(side);
          }
        });
        const prev = camera.position.clone();
        camera.position.set(pos[0], pos[1], pos[2]);
        camera.lookAt(target[0], target[1], target[2]);
        gl.render(scene, camera);
        const url = gl.domElement.toDataURL("image/png");
        // Restore wall visibility + the interactive pose.
        for (const s of saved) s.o.visible = s.vis;
        const home = cameraFor(defaultView);
        camera.position.copy(prev);
        camera.lookAt(home.target[0], home.target[1], home.target[2]);
        gl.render(scene, camera);
        return url;
      } catch {
        return null;
      }
    };
    return () => {
      captureRef.current = null;
    };
  }, [gl, scene, camera, captureRef, cameraFor, defaultView, hiddenForView]);

  return null;
}

function Walls({
  rooms,
  cx,
  cz,
  color,
  hiddenSides,
}: {
  rooms: { x: number; y: number; width: number; height: number; ceilingFt?: number }[];
  cx: number;
  cz: number;
  color: string;
  /** sides to hide (focused room only) so the outside camera can see in */
  hiddenSides?: Set<Side>;
}) {
  const segments = useMemo(() => {
    const segs: {
      pos: [number, number, number];
      size: [number, number, number];
      side: Side | null;
    }[] = [];
    const single = rooms.length === 1; // focused room → walls are toggleable
    for (const r of rooms) {
      const wh = r.ceilingFt ?? WALL_H; // per-room ceiling height
      const x0 = r.x - cx;
      const z0 = r.y - cz;
      const x1 = r.x + r.width - cx;
      const z1 = r.y + r.height - cz;
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const y = wh / 2;
      // north, south (run along X)
      segs.push({ pos: [mx, y, z0], size: [r.width, wh, WALL_T], side: single ? "n" : null });
      segs.push({ pos: [mx, y, z1], size: [r.width, wh, WALL_T], side: single ? "s" : null });
      // west, east (run along Z)
      segs.push({ pos: [x0, y, mz], size: [WALL_T, wh, r.height], side: single ? "w" : null });
      segs.push({ pos: [x1, y, mz], size: [WALL_T, wh, r.height], side: single ? "e" : null });
    }
    return segs;
  }, [rooms, cx, cz]);

  return (
    <group>
      {segments.map((s, i) => (
        <mesh
          key={i}
          position={s.pos}
          visible={s.side && hiddenSides ? !hiddenSides.has(s.side) : true}
          userData={s.side ? { fwSide: s.side } : undefined}
          castShadow
          receiveShadow
        >
          <boxGeometry args={s.size} />
          <meshStandardMaterial color={color} roughness={0.9} metalness={0.02} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Door + window markers recessed onto the interior face of the focused room's
 * walls. NOT structural holes (which would mean splitting every wall run and risk
 * breaking the capture the whole render depends on) — a thin plate on the wall
 * face: a dark leaf for a door (floor → ~7 ft), a glazed panel for a window
 * (~sill → header). Enough for the screenshot to pin WHERE each opening sits, so
 * the image model renders it there instead of guessing. Each plate carries its
 * wall's `fwSide` so it hides together with that wall (near-wall removal + the
 * on-screen view).
 */
function Openings({
  room,
  doors,
  windows,
  cx,
  cz,
  hiddenSides,
}: {
  room: SceneFocus;
  doors: Door[];
  windows: Window[];
  cx: number;
  cz: number;
  hiddenSides?: Set<Side>;
}) {
  const TOL = 1.5; // ft — how close to a wall an opening must be to sit on it
  const FACE = WALL_T / 2 + 0.03; // proud of the wall's interior face
  const PLATE_T = 0.12;
  const ceil = room.ceilingFt ?? WALL_H;

  interface Plate {
    key: string;
    side: Side;
    pos: [number, number, number];
    size: [number, number, number];
    color: string;
    emissive: string;
    emissiveIntensity: number;
  }

  const plates: Plate[] = [];
  const addPlate = (
    kind: "door" | "window",
    id: string,
    x: number,
    y: number,
    orientation: "h" | "v",
    lengthFt: number,
  ) => {
    // Vertical extent: a door runs from the floor up; a window is a mid-height band.
    const top = kind === "door" ? Math.min(7, ceil - 0.2) : Math.min(6.5, ceil - 0.4);
    const bottom = kind === "door" ? 0 : Math.min(2.5, top - 1);
    const h = Math.max(0.6, top - bottom);
    const yc = (top + bottom) / 2;
    const color = kind === "door" ? "#4a382a" : "#a8cbe6";
    const emissive = kind === "door" ? "#000000" : "#6f9fc4";
    const emissiveIntensity = kind === "door" ? 0 : 0.25;

    if (orientation === "h") {
      // north or south wall (runs along x); which one?
      let side: Side | null = null;
      if (Math.abs(y - room.y) <= TOL) side = "n";
      else if (Math.abs(y - (room.y + room.height)) <= TOL) side = "s";
      if (!side) return;
      const wz = (side === "n" ? room.y : room.y + room.height) - cz;
      const faceZ = side === "n" ? wz + FACE : wz - FACE;
      plates.push({
        key: `${kind}-${id}`,
        side,
        pos: [x - cx, yc, faceZ],
        size: [lengthFt, h, PLATE_T],
        color,
        emissive,
        emissiveIntensity,
      });
    } else {
      // west or east wall (runs along z)
      let side: Side | null = null;
      if (Math.abs(x - room.x) <= TOL) side = "w";
      else if (Math.abs(x - (room.x + room.width)) <= TOL) side = "e";
      if (!side) return;
      const wx = (side === "w" ? room.x : room.x + room.width) - cx;
      const faceX = side === "w" ? wx + FACE : wx - FACE;
      plates.push({
        key: `${kind}-${id}`,
        side,
        pos: [faceX, yc, y - cz],
        size: [PLATE_T, h, lengthFt],
        color,
        emissive,
        emissiveIntensity,
      });
    }
  };

  for (const d of doors) addPlate("door", d.id, d.x, d.y, d.orientation, 2.8);
  for (const w of windows) addPlate("window", w.id, w.x, w.y, w.orientation, Math.max(1, w.length));

  return (
    <group>
      {plates.map((p) => (
        <mesh
          key={p.key}
          position={p.pos}
          visible={hiddenSides ? !hiddenSides.has(p.side) : true}
          userData={{ fwSide: p.side }}
          castShadow
          receiveShadow
        >
          <boxGeometry args={p.size} />
          <meshStandardMaterial
            color={p.color}
            roughness={0.6}
            metalness={0.05}
            emissive={p.emissive}
            emissiveIntensity={p.emissiveIntensity}
          />
        </mesh>
      ))}
    </group>
  );
}

function FurnitureBox({
  item,
  cx,
  cz,
  accent,
  selected,
  onSelect,
}: {
  item: PlacedItem;
  cx: number;
  cz: number;
  accent: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const x = item.x + item.w / 2 - cx;
  const z = item.y + item.d / 2 - cz;
  const y = item.h / 2;
  const rot = (-item.rotation * Math.PI) / 180;

  return (
    <group position={[x, y, z]} rotation={[0, rot, 0]}>
      <mesh
        castShadow
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onSelect(item.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => (document.body.style.cursor = "")}
      >
        <boxGeometry args={[item.w, item.h, item.d]} />
        <meshStandardMaterial
          color={item.color}
          roughness={0.6}
          metalness={0.1}
          transparent={item.ghost}
          opacity={item.ghost ? 0.4 : 1}
          emissive={selected ? accent : "#000000"}
          emissiveIntensity={selected ? 0.35 : 0}
        />
      </mesh>
      {selected && (
        <mesh>
          <boxGeometry args={[item.w + 0.15, item.h + 0.15, item.d + 0.15]} />
          <meshBasicMaterial color={accent} wireframe />
        </mesh>
      )}
    </group>
  );
}
