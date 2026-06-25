import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mapTheme } from "../mapTheme";
import { terrainHeight } from "../terrain";
import { cameraControls } from "./cameraControls";
import {
  GLOBE_R,
  flatToECEF,
  ecefToFlat,
  enuBasis,
  lonLatToWorld,
  worldToLonLat,
  type ENU,
} from "./globe";
import { debug } from "./debug";

// Geospatial ORBIT camera (Google-Earth style). The camera lives in ECEF/sphere
// space and orbits a FOCUS point on the globe (the geographic point at screen
// centre, kept in flat world XZ and published for the LOD clipmap). State is a
// focus + an orbit DISTANCE (wheel) + a HEADING + a TILT (pitch). The camera faces
// straight down (nadir) by default and stays at whatever tilt the user dials — zoom
// NEVER changes the tilt. At nadir the focus and the globe centre coincide on screen,
// so the whole globe is centred; tilting reveals the horizon.
// pitch = π/2 looks straight down (nadir); pitch → 0 looks at the horizon.
//
//   left-drag   : grab the surface and drag it (the grabbed point tracks the
//                 cursor); near the limb it degrades to a tangent-plane pan. A
//                 drag that starts OFF the globe (in space) does nothing.
//   middle-drag : change orientation (Google-Earth scroll-button) — horizontal
//                 rotates heading, vertical TILTS (drag down → near-horizon
//                 "from the ground plane" view; drag up → top-down)
//   wheel       : zoom (distance), biased toward the point under the cursor; no
//                 zoom-out cap short of the whole globe. Zoom does not change the tilt.
//   right-drag  : rotate heading (north-up by default; the on-screen compass shows
//                 heading and resets both heading and tilt)
//   WASD        : pan the focus;  Q/E : rotate heading
//
//   TOUCH (mobile, mirrors the above without mouse buttons):
//   one finger  : pan (same grab as left-drag; in space does nothing)
//   two fingers : pinch = zoom (biased toward the midpoint), twist = heading,
//                 vertical drag = tilt. The three are the independent components of
//                 the two-finger transform, decomposed each move.
//
// The flat clipmap and voxelizer stay flat — the curvature.ts vertex shader bends
// the geometry onto the same sphere these helpers place the camera on, so eye and
// ground share one space.

const { minAltitude } = mapTheme.view;
const PITCH_INIT = mapTheme.view.pitch; // opening tilt + compass-reset target
const PITCH_MIN = mapTheme.view.pitchMin; // near-horizon limit (ground-plane view)
const PITCH_MAX = mapTheme.view.pitchMax; // nadir, kept off π/2 so cosP > 0 (camera.up stable)
const TILT_SPEED = mapTheme.view.tiltSpeed; // middle-drag vertical → tilt radians/pixel

const D_MIN = minAltitude / Math.sin(PITCH_MAX); // closest orbit (steepest pitch → smallest D)
const D_MAX = mapTheme.view.maxDistR * GLOBE_R; // whole globe + headroom (no region cap)
const D_INIT = mapTheme.view.initialDistR * GLOBE_R; // opening framing

const ZOOM_SPEED = 0.0012; // wheel delta → distance factor (log scale)
const ROTATE_SPEED = 0.005; // drag pixel → heading radians
const KEY_PAN = 1.1; // focus pan speed (× distance / second) under WASD
const KEY_ROTATE = 1.4; // heading radians / second under Q/E
const RESET_LERP = 0.18; // per-frame ease of heading → north on compass reset
const SAMPLE_R = 8; // ground-clearance disk radius (world units)
const SAMPLE_N = 8;
const CLEARANCE = 1; // min gap kept above the highest nearby terrain
const TAU = Math.PI * 2;
// Keep the focus a few degrees short of the pole: the data + ENU frame degenerate
// at the poles, so clamping here (in BOTH the focus z-band and the grab-pan
// direction) stops the camera before the singularity. The grab carries heading
// across the pole (rigid rotation), so this only needs to dodge the exact
// singularity — keep it close to the pole so the cap skip across is small.
const MAX_LAT = (87 * Math.PI) / 180;
const MAX_SIN_LAT = Math.sin(MAX_LAT);
const Z_AT_MAX_LAT = lonLatToWorld(0, MAX_LAT)[1];
const Z_AT_MIN_LAT = lonLatToWorld(0, -MAX_LAT)[1];

interface Props {
  focus: React.MutableRefObject<THREE.Vector3>; // shared LOD centre = the look-at point (flat world XZ)
  bounds: [number, number, number, number]; // [minX, minZ, maxX, maxZ]
}

// Heading wrapped to [-π, π] (for the reset-to-north ease).
const wrapPi = (a: number) => {
  a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a;
};

export default function RoamControls({ focus, bounds }: Props) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const dist = useRef(D_INIT);
  const heading = useRef(0); // 0 = north-up
  const userPitch = useRef(PITCH_INIT); // tilt the user dials with middle-drag
  const resetting = useRef(false); // easing heading → north + tilt → default
  const dragging = useRef(false);
  const rotateMode = useRef(false); // right-drag: heading only
  const orientMode = useRef(false); // middle-drag: heading + tilt
  const panActive = useRef(false); // left-drag, but only after an on-globe hit
  const last = useRef({ x: 0, y: 0 });
  const keys = useRef<Record<string, boolean>>({});

  // Active TOUCH pointers (id → last client position) and the current two-finger
  // gesture snapshot. Mouse/pen never populate these — they keep the single-pointer
  // button paths below. Two fingers decompose into pinch→zoom, twist→heading,
  // vertical-drag→tilt (the three independent components of a 2-point transform).
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef({ active: false, dist: 0, angle: 0, midX: 0, midY: 0 });

  // Grab-drag snapshot: the camera pose + grabbed surface point + forward at drag
  // start, so the grab is a rigid globe rotation computed against a FROZEN view
  // (recomputed from the start each move → no drift). Carrying the start forward
  // (fwd0/heading0) lets the grab rotate heading too, so dragging over a pole stays
  // continuous (the longitude flip is matched by a heading flip — no snap).
  const grab = useRef<{
    cam: THREE.PerspectiveCamera | null; // frozen camera pose
    hitN: THREE.Vector3; // grabbed surface direction (unit); limb-clamped, never null
    focusDir: THREE.Vector3; // focus surface direction at drag start (unit)
    fwd0: THREE.Vector3; // forward tangent (ECEF) at drag start
    heading0: number;
  }>({
    cam: null,
    hitN: new THREE.Vector3(),
    focusDir: new THREE.Vector3(),
    fwd0: new THREE.Vector3(),
    heading0: 0,
  });

  // Scratch (avoid per-frame allocation).
  const enu = useRef<ENU>({
    east: new THREE.Vector3(),
    north: new THREE.Vector3(),
    up: new THREE.Vector3(),
  });
  const grabEnu = useRef<ENU>({
    east: new THREE.Vector3(),
    north: new THREE.Vector3(),
    up: new THREE.Vector3(),
  });
  const grabFwd = useRef(new THREE.Vector3());
  const S = useRef(new THREE.Vector3());
  const fwd = useRef(new THREE.Vector3());
  const eye = useRef(new THREE.Vector3());
  const sphere = useRef(new THREE.Sphere(new THREE.Vector3(0, 0, 0), GLOBE_R));
  const ray = useRef(new THREE.Ray());
  const tmp = useRef(new THREE.Vector3());
  const quat = useRef(new THREE.Quaternion());

  const [wMinX, , wMaxX] = bounds;
  const spanX = wMaxX - wMinX;

  // Wrap longitude (spin all the way around — the globe has no E/W edge) and clamp
  // latitude a few degrees short of the pole (where the frame degenerates).
  const settleFocus = () => {
    const f = focus.current;
    f.x = ((f.x - wMinX) % spanX + spanX) % spanX + wMinX;
    f.z = THREE.MathUtils.clamp(f.z, Z_AT_MIN_LAT, Z_AT_MAX_LAT);
  };

  // Clamp a focus DIRECTION to ±MAX_LAT, keeping its longitude. Clamping in
  // direction space (rather than converting to flat then clamping z) is what
  // prevents the grab-pan from flipping longitude as it crosses a pole.
  const clampDirLat = (v: THREE.Vector3) => {
    const r = v.length() || 1;
    if (Math.abs(v.y / r) <= MAX_SIN_LAT) return;
    const sign = v.y < 0 ? -1 : 1;
    const horiz = Math.hypot(v.x, v.z) || 1e-9;
    const k = (Math.cos(MAX_LAT) * r) / horiz;
    v.x *= k;
    v.z *= k;
    v.y = sign * MAX_SIN_LAT * r;
  };

  // Build a ray for a client (x,y) pixel against a given camera pose.
  const rayFor = (cam: THREE.PerspectiveCamera, cx: number, cy: number) => {
    const r = gl.domElement.getBoundingClientRect();
    const nx = ((cx - r.left) / r.width) * 2 - 1;
    const ny = -((cy - r.top) / r.height) * 2 + 1;
    const p = tmp.current.set(nx, ny, 0.5).unproject(cam);
    ray.current.origin.copy(cam.position);
    ray.current.direction.copy(p.sub(cam.position).normalize());
    return ray.current;
  };

  // Surface point under a pixel, as a UNIT direction (or null if the ray misses).
  const hitDir = (cam: THREE.PerspectiveCamera, cx: number, cy: number) => {
    const hit = rayFor(cam, cx, cy).intersectSphere(sphere.current, tmp.current);
    return hit ? hit.clone().normalize() : null;
  };

  // Like hitDir but ALWAYS returns a unit direction: when the ray misses the globe
  // (cursor out past the limb), it returns the nearest silhouette direction — the
  // closest point on the ray to the centre, normalized. This is C0-continuous across
  // the limb (there the ray is tangent, so the closest point IS the hit), so the grab
  // stays a bounded, smooth rigid rotation instead of running away off-globe.
  const grabDir = (cam: THREE.PerspectiveCamera, cx: number, cy: number) => {
    const r = rayFor(cam, cx, cy);
    const hit = r.intersectSphere(sphere.current, tmp.current);
    if (hit) return hit.clone().normalize();
    // centre is the origin: closest point on the ray = origin + dir·(−origin·dir).
    const t = -r.origin.dot(r.direction);
    return tmp.current.copy(r.origin).addScaledVector(r.direction, t).normalize().clone();
  };

  useEffect(() => {
    const el = gl.domElement;

    // Snapshot the grab for a pan starting at pixel (cx,cy): freeze the camera pose +
    // grabbed surface point + forward tangent, so each move is a rigid globe rotation
    // recomputed from the start (no drift). Returns false if the pixel is off the
    // globe (no pan starts). Shared by mouse left-drag and single-finger touch.
    const beginGrab = (cx: number, cy: number): boolean => {
      const cam = camera as THREE.PerspectiveCamera;
      if (!hitDir(cam, cx, cy)) {
        panActive.current = false;
        grab.current.cam = null;
        return false;
      }
      panActive.current = true;
      const snap = cam.clone();
      grab.current.cam = snap;
      grab.current.hitN.copy(grabDir(snap, cx, cy));
      flatToECEF(focus.current.x, focus.current.z, 0, grab.current.focusDir).normalize();
      enuBasis(focus.current.x, focus.current.z, grabEnu.current);
      grab.current.heading0 = heading.current;
      grab.current.fwd0
        .copy(grabEnu.current.north)
        .multiplyScalar(Math.cos(heading.current))
        .addScaledVector(grabEnu.current.east, Math.sin(heading.current));
      return true;
    };

    // Rigid globe-rotation pan: the rotation carrying the current cursor point back to
    // the grabbed point is applied to BOTH the focus direction and the forward tangent
    // (carrying heading so crossing a pole stays continuous). Computed against the
    // frozen drag-start camera → no drift. Shared by mouse left-drag and 1-finger touch.
    const applyGrabPan = (cx: number, cy: number) => {
      const g = grab.current;
      if (!g.cam) return;
      const now = grabDir(g.cam, cx, cy);
      quat.current.setFromUnitVectors(now, g.hitN); // current-hit → grabbed point
      tmp.current.copy(g.focusDir).applyQuaternion(quat.current);
      clampDirLat(tmp.current); // dodge the exact-pole singularity (heading carries the flip)
      const [fx, fz] = ecefToFlat(tmp.current);
      focus.current.x = fx;
      focus.current.z = fz;
      settleFocus();
      grabFwd.current.copy(g.fwd0).applyQuaternion(quat.current);
      enuBasis(focus.current.x, focus.current.z, grabEnu.current);
      heading.current = Math.atan2(
        grabFwd.current.dot(grabEnu.current.east),
        grabFwd.current.dot(grabEnu.current.north),
      );
      resetting.current = false; // a manual grab cancels any reset-north ease
    };

    // Snapshot the two-finger gesture baseline: finger spread (→zoom), twist angle
    // (→heading), and midpoint (→tilt). The pointer-map insertion order is stable
    // while both fingers persist, so the angle stays continuous move-to-move. Called
    // on the 2nd finger down and re-baselined when the finger set changes mid-gesture.
    const beginPinch = () => {
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      pinch.current.active = true;
      pinch.current.dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      pinch.current.angle = Math.atan2(b.y - a.y, b.x - a.x);
      pinch.current.midX = (a.x + b.x) / 2;
      pinch.current.midY = (a.y + b.y) / 2;
      panActive.current = false; // a second finger cancels the single-finger pan
      grab.current.cam = null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const old = dist.current;
      dist.current = THREE.MathUtils.clamp(
        old * Math.exp(e.deltaY * ZOOM_SPEED),
        D_MIN,
        D_MAX,
      );
      // Zoom toward the cursor: bias the focus toward the point under it by the
      // fraction the distance shrank (only when zooming in).
      if (dist.current < old) {
        const d = hitDir(camera as THREE.PerspectiveCamera, e.clientX, e.clientY);
        if (d) {
          const [hx, hz] = ecefToFlat(d);
          const f = mapTheme.view.cursorBias * (1 - dist.current / old);
          focus.current.x = THREE.MathUtils.lerp(focus.current.x, hx, f);
          focus.current.z = THREE.MathUtils.lerp(focus.current.z, hz, f);
          settleFocus();
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      // Touch: track every finger. One finger pans (like left-drag); a second finger
      // starts a pinch gesture (zoom + twist-rotate + vertical-drag tilt). Mouse-only
      // button modes (middle/right) don't exist on touch, so skip them entirely.
      if (e.pointerType === "touch") {
        resetting.current = false;
        el.setPointerCapture?.(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const n = pointers.current.size;
        if (n === 1) beginGrab(e.clientX, e.clientY); // 1-finger pan (no-op off the globe)
        else if (n === 2) beginPinch();
        // a 3rd+ finger is ignored; the first two keep driving the gesture
        return;
      }

      resetting.current = false;
      last.current = { x: e.clientX, y: e.clientY };
      orientMode.current = e.button === 1; // middle-drag: heading + tilt
      rotateMode.current = e.button === 2 || e.shiftKey; // right-drag (or shift) rotates heading
      panActive.current = false;

      // Orientation/heading drags need no globe hit — they change the view, not the focus.
      if (orientMode.current || rotateMode.current) {
        dragging.current = true;
        el.setPointerCapture?.(e.pointerId);
        return;
      }

      // Left-drag = pan. Off-globe guard: a ray that misses the sphere starts NO pan.
      if (!beginGrab(e.clientX, e.clientY)) {
        dragging.current = false; // clicking/dragging in empty space does nothing
        return;
      }
      dragging.current = true;
      el.setPointerCapture?.(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      // Touch path: update this finger, then drive the gesture. Runs before the
      // mouse `dragging` guard since touch uses the pointer map, not that flag.
      if (e.pointerType === "touch") {
        const p = pointers.current.get(e.pointerId);
        if (!p) return;
        p.x = e.clientX;
        p.y = e.clientY;

        if (pinch.current.active && pointers.current.size >= 2) {
          const pts = [...pointers.current.values()];
          const a = pts[0];
          const b = pts[1];
          const nd = Math.hypot(b.x - a.x, b.y - a.y) || 1; // finger spread
          const na = Math.atan2(b.y - a.y, b.x - a.x); // twist angle
          const nmx = (a.x + b.x) / 2;
          const nmy = (a.y + b.y) / 2; // midpoint
          const pc = pinch.current;

          // Pinch → zoom (distance). Spreading the fingers (nd grows) → ratio < 1 →
          // distance shrinks → zoom in; pinching together zooms out.
          const old = dist.current;
          dist.current = THREE.MathUtils.clamp(old * (pc.dist / nd), D_MIN, D_MAX);
          // Bias the focus toward the gesture midpoint when zooming in — mirrors the
          // wheel's cursor-bias so a pinch zooms toward what's between the fingers.
          if (dist.current < old) {
            const d = hitDir(camera as THREE.PerspectiveCamera, nmx, nmy);
            if (d) {
              const [hx, hz] = ecefToFlat(d);
              const f = mapTheme.view.cursorBias * (1 - dist.current / old);
              focus.current.x = THREE.MathUtils.lerp(focus.current.x, hx, f);
              focus.current.z = THREE.MathUtils.lerp(focus.current.z, hz, f);
              settleFocus();
            }
          }
          // Twist → heading. A symmetric pinch barely twists, so zoom stays decoupled.
          // Subtract: screen y is down, so a clockwise finger twist must turn the
          // globe the same way the fingers move (otherwise it feels reversed).
          heading.current -= wrapPi(na - pc.angle);
          // Two-finger vertical drag → tilt: drag DOWN (midpoint y grows) lowers the
          // pitch toward the horizon (matches the middle-drag convention). A pure
          // pinch barely moves the midpoint, so zoom and tilt stay decoupled too.
          userPitch.current = THREE.MathUtils.clamp(
            userPitch.current - (nmy - pc.midY) * TILT_SPEED,
            PITCH_MIN,
            PITCH_MAX,
          );

          pc.dist = nd;
          pc.angle = na;
          pc.midX = nmx;
          pc.midY = nmy;
          resetting.current = false;
        } else if (panActive.current) {
          applyGrabPan(e.clientX, e.clientY); // single-finger pan
        }
        return;
      }

      if (!dragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };

      if (rotateMode.current) {
        heading.current += dx * ROTATE_SPEED;
        resetting.current = false;
        return;
      }

      if (orientMode.current) {
        // Google-Earth scroll-button drag: horizontal spins the compass, vertical
        // tilts. Drag DOWN (dy>0) lowers the pitch toward the horizon (ground-plane
        // view); drag UP raises it back toward top-down.
        heading.current += dx * ROTATE_SPEED;
        userPitch.current = THREE.MathUtils.clamp(
          userPitch.current - dy * TILT_SPEED,
          PITCH_MIN,
          PITCH_MAX,
        );
        resetting.current = false;
        return;
      }

      if (!panActive.current) return; // left-drag that missed the globe: no-op
      applyGrabPan(e.clientX, e.clientY);
    };

    const onPointerUp = (e: PointerEvent) => {
      // Touch: drop the lifted finger and re-baseline the gesture so the count change
      // never jumps. Also serves pointercancel (the OS can revoke a touch mid-gesture).
      if (e.pointerType === "touch") {
        pointers.current.delete(e.pointerId);
        el.releasePointerCapture?.(e.pointerId);
        const n = pointers.current.size;
        if (pinch.current.active) {
          if (n >= 2) {
            beginPinch(); // re-baseline from the remaining two fingers (no jump)
          } else {
            pinch.current.active = false;
            // Hand a lingering finger back to a fresh pan so pinch→pan never jumps.
            const rem = [...pointers.current.values()][0];
            if (rem) beginGrab(rem.x, rem.y);
            else {
              panActive.current = false;
              grab.current.cam = null;
            }
          }
        } else if (n === 0) {
          panActive.current = false;
          grab.current.cam = null;
        }
        return;
      }

      dragging.current = false;
      panActive.current = false;
      orientMode.current = false;
      rotateMode.current = false;
      grab.current.cam = null;
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
    window.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [gl, camera, focus]);

  // Smoothed max ground height around the focus (keep clearance over sharp peaks).
  const groundMax = (x: number, z: number) => {
    let max = terrainHeight(x, z);
    for (let i = 0; i < SAMPLE_N; i++) {
      const a = (i / SAMPLE_N) * TAU;
      const h = terrainHeight(x + Math.cos(a) * SAMPLE_R, z + Math.sin(a) * SAMPLE_R);
      if (h > max) max = h;
    }
    return max;
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);

    // Consume UI intents from the bridge.
    if (cameraControls._zoomFactor !== 1) {
      dist.current = THREE.MathUtils.clamp(
        dist.current * cameraControls._zoomFactor,
        D_MIN,
        D_MAX,
      );
      cameraControls._zoomFactor = 1;
    }
    if (cameraControls._resetNorth) {
      resetting.current = true;
      cameraControls._resetNorth = false;
    }
    if (cameraControls._tiltStep !== 0) {
      userPitch.current = THREE.MathUtils.clamp(
        userPitch.current + cameraControls._tiltStep,
        PITCH_MIN,
        PITCH_MAX,
      );
      cameraControls._tiltStep = 0;
      resetting.current = false; // a manual tilt cancels any reset ease
    }

    // Keyboard pan/rotate (direct, no inertia).
    const k = keys.current;
    const sh = Math.sin(heading.current);
    const ch = Math.cos(heading.current);
    const step = KEY_PAN * dt * dist.current;
    let mx = 0;
    let mz = 0;
    if (k["w"] || k["arrowup"]) { mx += sh * step; mz += ch * step; }
    if (k["s"] || k["arrowdown"]) { mx -= sh * step; mz -= ch * step; }
    if (k["d"]) { mx += ch * step; mz -= sh * step; }
    if (k["a"]) { mx -= ch * step; mz += sh * step; }
    if (mx || mz) {
      focus.current.x += mx;
      focus.current.z += mz;
      settleFocus();
    }
    if (k["e"] || k["arrowright"]) { heading.current += KEY_ROTATE * dt; resetting.current = false; }
    if (k["q"] || k["arrowleft"]) { heading.current -= KEY_ROTATE * dt; resetting.current = false; }

    // Ease heading back to north AND tilt back to the default pitch on compass reset.
    if (resetting.current) {
      const h = wrapPi(heading.current);
      heading.current = h * (1 - RESET_LERP);
      userPitch.current = THREE.MathUtils.lerp(userPitch.current, PITCH_INIT, RESET_LERP);
      if (Math.abs(heading.current) < 0.001 && Math.abs(userPitch.current - PITCH_INIT) < 0.001) {
        heading.current = 0;
        userPitch.current = PITCH_INIT;
        resetting.current = false;
      }
    }

    const fx = focus.current.x;
    const fz = focus.current.z;
    const groundH = terrainHeight(fx, fz);

    // Effective tilt is purely the user's middle-drag pitch — zoom NEVER changes it.
    // Defaults to PITCH_INIT (= nadir), so the camera faces straight down until the
    // user tilts. userPitch is already clamped to [PITCH_MIN, PITCH_MAX]; PITCH_MAX
    // (≈ nadir − ε) keeps cos(pitch) > 0 so camera.up never collapses.
    const pitchEff = userPitch.current;
    const sinP = Math.sin(pitchEff);
    const cosP = Math.cos(pitchEff);

    // Minimum orbit distance so the eye clears the highest nearby terrain.
    const peak = groundMax(fx, fz);
    const dMin = Math.max(D_MIN, (peak - groundH + CLEARANCE) / sinP);
    if (dist.current < dMin) dist.current = dMin;
    const d = dist.current;

    // ECEF frame at the focus.
    flatToECEF(fx, fz, groundH, S.current);
    enuBasis(fx, fz, enu.current);
    const { east, north, up } = enu.current;

    // Forward (where the camera faces, projected to the ground): north at heading 0.
    fwd.current
      .copy(north)
      .multiplyScalar(Math.cos(heading.current))
      .addScaledVector(east, Math.sin(heading.current));

    // Eye: up by sin(pitch)·d, back along −forward by cos(pitch)·d, looking at S.
    eye.current
      .copy(S.current)
      .addScaledVector(up, sinP * d)
      .addScaledVector(fwd.current, -cosP * d);

    camera.position.copy(eye.current);
    // Screen-up of the orbit (perpendicular to the view): up·cos(pitch) + fwd·sin(pitch).
    // Same as the old radial `up` at this pitch (lookAt projects to the same direction),
    // but it stays well-defined at nadir (cosP > 0) where the view nears the radial.
    camera.up.copy(up).multiplyScalar(cosP).addScaledVector(fwd.current, sinP);
    // Always look at the surface focus, so the area stays centred on screen. The
    // top-down framing comes from the default pitch (nadir), not from sliding the
    // target toward the globe centre (which swung the camera up).
    camera.lookAt(S.current);

    // Per-frame depth range: see across the globe, keep precision over the huge
    // altitude span.
    const cam = camera as THREE.PerspectiveCamera;
    const camDist = eye.current.length();
    cam.far = camDist + 2 * GLOBE_R + 10;
    cam.near = Math.max(0.1, d * 0.05);
    cam.updateProjectionMatrix();

    // Publish for the LOD (radial altitude above the surface) and the compass.
    cameraControls.surfaceAltitude = Math.max(d * sinP, 0.001);
    cameraControls.heading = heading.current;
    cameraControls.pitch = userPitch.current;

    // Publish pose for the hidden debug overlay (so an exact view can be reproduced).
    const [flon, flat] = worldToLonLat(fx, fz);
    debug.pitchDeg = (pitchEff * 180) / Math.PI;
    debug.headingDeg = ((((heading.current * 180) / Math.PI) % 360) + 360) % 360;
    debug.distR = d / GLOBE_R;
    debug.altitude = cameraControls.surfaceAltitude;
    debug.lon = (flon * 180) / Math.PI;
    debug.lat = (flat * 180) / Math.PI;
  });

  return null;
}
