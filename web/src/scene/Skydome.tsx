import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';

// Deep-space backdrop: a camera-following inverted sphere with a near-black gradient
// and procedural stars. It rides with the camera (so it sits at infinity, no parallax)
// and ROTATES with the eye's position, so the starfield sweeps as you pan and turn —
// never a static flat backdrop. depthWrite off so all terrain draws over it. NOT
// curvature-patched: it's the far backdrop the curved-away terrain is silhouetted on.
const STAR_PAN_K = 0.0016; // radians of sky rotation per world unit panned

export default function Skydome() {
  const ref = useRef<THREE.Group>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(mapTheme.palette.skyTop) },
          horizon: { value: new THREE.Color(mapTheme.palette.skyHorizon) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        // Direction-hashed stars: each cell of a direction-space grid may hold one
        // round star; two layers (coarse bright + fine faint) for depth. Because the
        // pattern is keyed on the view direction, turning/panning sweeps it.
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform vec3 top;
          uniform vec3 horizon;
          float hash(vec3 p){
            p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }
          float stars(vec3 dir, float density, float thresh){
            vec3 g = dir * density;
            vec3 id = floor(g);
            vec3 f = fract(g) - 0.5;
            float on = step(thresh, hash(id));
            float pt = smoothstep(0.5, 0.0, length(f)) * (0.4 + 0.6 * hash(id + 7.3));
            return on * pt;
          }
          void main(){
            vec3 dir = normalize(vDir);
            float h = dir.y * 0.5 + 0.5;
            vec3 sky = mix(horizon, top, smoothstep(0.0, 0.85, h));
            float s = stars(dir, 150.0, 0.986) + 0.6 * stars(dir, 320.0, 0.992);
            gl_FragColor = vec4(sky + vec3(s) * vec3(0.9, 0.95, 1.0), 1.0);
          }
        `,
      }),
    [],
  );

  // Center on the camera (so it's at infinity) and size to just inside the far plane.
  // Rotate the whole sky by the eye's position so the stars sweep as you roam.
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    g.position.copy(camera.position);
    const far = (camera as THREE.PerspectiveCamera).far ?? 400;
    g.scale.setScalar(far * 0.9);
    g.rotation.set(camera.position.z * STAR_PAN_K, -camera.position.x * STAR_PAN_K, 0);
  });

  return (
    <group ref={ref}>
      <mesh material={material} frustumCulled={false}>
        <sphereGeometry args={[1, 48, 24]} />
      </mesh>
    </group>
  );
}
