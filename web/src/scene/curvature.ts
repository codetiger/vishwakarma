import * as THREE from 'three';
import { mapTheme } from '../mapTheme';

// The signature "round world", ported from the mahabharata map: bend every
// vertex down by its squared distance from a moving CENTRE (the camera's focus),
// so the patch under the camera stays level and the rim falls away in every
// direction — a curved tabletop / small-planet horizon that "rolls" as you roam.
//
// Every scene material that touches the ground must use the same curvature, or
// objects detach from the terrain. All curved materials SHARE the uniform
// objects below, so a single per-frame write of uCenter (from the controller)
// updates the whole scene at once. (No fog — the far terrain curves down to a
// clean silhouette against the starfield instead of dissolving into haze.)

export const curveUniforms = {
  uCurvature: { value: mapTheme.curvature },
  uCenter: { value: new THREE.Vector2(0, 0) },
};

const CURVE_VERTEX = /* glsl */ `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  vec4 worldPos = modelMatrix * mvPosition;
  vec2 dCurve = worldPos.xz - uCenter;
  worldPos.y -= uCurvature * dot( dCurve, dCurve );
  mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
`;

export function applyWorldCurvature(material: THREE.Material, curvature: number): void {
  curveUniforms.uCurvature.value = curvature;
  material.onBeforeCompile = (shader) => {
    // Assign the SHARED uniform objects (not copies): one per-frame write to
    // uCenter updates this material along with every other curved material.
    shader.uniforms.uCurvature = curveUniforms.uCurvature;
    shader.uniforms.uCenter = curveUniforms.uCenter;
    shader.vertexShader =
      `uniform float uCurvature;\nuniform vec2 uCenter;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        CURVE_VERTEX,
      );
  };
  material.needsUpdate = true;
}
