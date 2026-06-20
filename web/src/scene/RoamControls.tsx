import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mapTheme } from "../mapTheme";
import { curveUniforms } from "./curvature";
import { terrainHeight } from "../terrain";

// Google-Earth-style oblique roam. The eye flies at a fixed altitude above the
// (smoothed) terrain, tilted down at a constant pitch — drag or WASD pan it
// across the map, shift-drag or Q/E turn the heading (right-click is inert). The eye XZ
// is the LOD/fog center, so detail is densest in the near foreground and coarsens
// into the distance. The scene stores z south-up, so the rendered terrain is
// z-negated (north up); the camera, look target, and fog center are negated to
// match, while the eye published for LOD/height stays in true world space.

const { cameraHeight, pitch, edgeMargin, minAltitude, maxAltitude } = mapTheme.view;
const PAN_SPEED = 0.0133; // drag pixel → world impulse (scaled by zoom below)
const KEY_SPEED = 5.3; // world units / second under WASD (scaled by zoom)
const ROTATE_SPEED = 0.005; // drag pixel → heading impulse
const KEY_ROTATE = 1.4; // radians / second under Q/E
const DAMP = 0.84; // per-frame velocity decay
const Y_LERP = 0.08; // height smoothing toward target (lower = smoother)
const SAMPLE_R = 8; // radius of the height-averaging disk (world units)
const SAMPLE_N = 8; // samples on the disk
const CLEARANCE = 1; // min gap kept above the highest nearby terrain (low so the eye can drop in)
const LOOK_DIST = 100; // distance to the aim point along the heading
const TAU = Math.PI * 2;
// Wheel zoom moves the camera Y: altitude = cameraHeight × zoom, clamped to the
// theme's [minAltitude, maxAltitude]. The low end reaches the LOD's finest level
// (L0=0); the high end is a coarse overview. ZOOM bounds are derived so the wheel
// spans exactly that altitude range.
const ZOOM_SPEED = 0.0012; // wheel delta → zoom factor change
const ZOOM_MIN = minAltitude / cameraHeight; // fully zoomed in → altitude = minAltitude
const ZOOM_MAX = maxAltitude / cameraHeight; // fully zoomed out → altitude = maxAltitude

interface Props {
  focus: React.MutableRefObject<THREE.Vector3>; // shared LOD/fog center = the eye (world)
  bounds: [number, number, number, number]; // [minX, minZ, maxX, maxZ]
}

export default function RoamControls({ focus, bounds }: Props) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const vel = useRef(new THREE.Vector2(0, 0)); // XZ velocity (world)
  const heading = useRef(Math.PI); // start facing north (scene is south-up)
  const headingVel = useRef(0);
  const zoom = useRef(1); // altitude factor (wheel)
  const dragging = useRef(false);
  const rotateMode = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const keys = useRef<Record<string, boolean>>({});
  const camY = useRef<number | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    const basis = () => {
      const h = heading.current;
      return {
        forward: new THREE.Vector2(-Math.sin(h), -Math.cos(h)),
        // The render frame mirrors z (north up), which flips handedness, so
        // screen-right is the NEGATED world right.
        right: new THREE.Vector2(-Math.cos(h), Math.sin(h)),
      };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom.current = THREE.MathUtils.clamp(
        zoom.current * Math.exp(e.deltaY * ZOOM_SPEED),
        ZOOM_MIN,
        ZOOM_MAX,
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) return; // right-click is inert — it must not rotate (or pan) the camera
      dragging.current = true;
      rotateMode.current = e.shiftKey; // rotation only via shift-drag (and Q/E keys)
      last.current = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      if (rotateMode.current) {
        headingVel.current += dx * ROTATE_SPEED;
        return;
      }
      const { forward, right } = basis();
      const k = PAN_SPEED * zoom.current; // pan faster when zoomed out (higher)
      vel.current.x += (-right.x * dx + forward.x * dy) * k;
      vel.current.y += (-right.y * dx + forward.y * dy) * k;
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging.current = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = down;
    };
    const kd = onKey(true);
    const ku = onKey(false);

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    el.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [gl]);

  // Smoothed ground height around a point: average a small disk (low-passes the
  // fine bumps) and track the local max (to keep clearance over sharp features).
  const sampleGround = (x: number, z: number) => {
    let sum = terrainHeight(x, z);
    let max = sum;
    for (let i = 0; i < SAMPLE_N; i++) {
      const a = (i / SAMPLE_N) * TAU;
      const h = terrainHeight(
        x + Math.cos(a) * SAMPLE_R,
        z + Math.sin(a) * SAMPLE_R,
      );
      sum += h;
      if (h > max) max = h;
    }
    return { avg: sum / (SAMPLE_N + 1), max };
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const h0 = heading.current;
    const forward = new THREE.Vector2(-Math.sin(h0), -Math.cos(h0));
    // Negated world right — the render frame mirrors z (see basis()).
    const right = new THREE.Vector2(-Math.cos(h0), Math.sin(h0));

    const k = keys.current;
    const step = KEY_SPEED * dt * zoom.current;
    if (k["w"] || k["arrowup"]) {
      vel.current.x += forward.x * step;
      vel.current.y += forward.y * step;
    }
    if (k["s"] || k["arrowdown"]) {
      vel.current.x -= forward.x * step;
      vel.current.y -= forward.y * step;
    }
    if (k["d"]) {
      vel.current.x += right.x * step;
      vel.current.y += right.y * step;
    }
    if (k["a"]) {
      vel.current.x -= right.x * step;
      vel.current.y -= right.y * step;
    }
    if (k["e"] || k["arrowright"]) headingVel.current += KEY_ROTATE * dt;
    if (k["q"] || k["arrowleft"]) headingVel.current -= KEY_ROTATE * dt;

    heading.current += headingVel.current;
    headingVel.current *= DAMP;

    // Eye (world) in the shared focus ref. Keep it inside the map by a FIXED
    // inset, independent of zoom — so the framing stays put as you zoom in/out
    // (no jump) and the same coastal regions are reachable at every zoom level.
    // Capped to 40% of each span so a small map can't invert.
    const eye = focus.current;
    const mx = Math.min(edgeMargin, (bounds[2] - bounds[0]) * 0.4);
    const mz = Math.min(edgeMargin, (bounds[3] - bounds[1]) * 0.4);
    eye.x = THREE.MathUtils.clamp(
      eye.x + vel.current.x,
      bounds[0] + mx,
      bounds[2] - mx,
    );
    eye.z = THREE.MathUtils.clamp(
      eye.z + vel.current.y,
      bounds[1] + mz,
      bounds[3] - mz,
    );
    vel.current.multiplyScalar(DAMP);

    // Smooth altitude: damp toward averaged ground + zoomed altitude, never below
    // the nearby max + clearance.
    const g = sampleGround(eye.x, eye.z);
    const altitude = THREE.MathUtils.clamp(
      cameraHeight * zoom.current,
      minAltitude,
      maxAltitude,
    );
    const target = g.avg + altitude;
    camY.current =
      camY.current == null
        ? target
        : THREE.MathUtils.lerp(camY.current, target, Y_LERP);
    camY.current = Math.max(camY.current, g.max + CLEARANCE);
    eye.y = camY.current;

    // Render frame is z-negated (north up); place the camera + aim there, while
    // the eye stays world-space for LOD/height.
    const h = heading.current;
    const fwx = -Math.sin(h);
    const fwz = -Math.cos(h);
    const horiz = Math.cos(pitch) * LOOK_DIST;
    camera.position.set(eye.x, camY.current, -eye.z);
    camera.lookAt(
      eye.x + fwx * horiz,
      camY.current - Math.sin(pitch) * LOOK_DIST,
      -(eye.z + fwz * horiz),
    );

    curveUniforms.uCenter.value.set(eye.x, -eye.z);
  });

  return null;
}
