import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';

// A stylized gradient backdrop (warm at the horizon, dark above) so the
// curved-away terrain dissolves into sky, not void. NOT curvature-patched — it
// is the far backdrop. It rides with the camera and is scaled to just inside the
// camera's far plane every frame, so it is always visible no matter how the far
// plane is tuned or how far the camera roams (a fixed huge radius would clip the
// moment the far plane is brought in for the close view). The horizon colour is
// the SAME `skyHorizon` the radial fog fades terrain to, so the fogged terrain
// edge blends seamlessly into the sky with no band/seam.
export default function Skydome() {
  const ref = useRef<THREE.Mesh>(null);
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
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vPos;
          uniform vec3 top;
          uniform vec3 horizon;
          void main() {
            float h = normalize(vPos).y * 0.5 + 0.5;
            vec3 c = mix(horizon, top, smoothstep(0.45, 0.95, h));
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    [],
  );

  // Center on the camera and size to just inside its far plane each frame. The
  // gradient uses the unit-sphere local position, so scaling never distorts it.
  useFrame(({ camera }) => {
    const m = ref.current;
    if (!m) return;
    m.position.copy(camera.position);
    const far = (camera as THREE.PerspectiveCamera).far ?? 400;
    m.scale.setScalar(far * 0.9);
  });

  return (
    <mesh ref={ref} material={material} frustumCulled={false}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  );
}
