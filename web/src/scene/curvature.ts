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
// updates the whole scene at once.
//
// Fog fades with RADIAL distance from the curvature centre (the focus), NOT
// linear camera depth — so the focus is always clear and the haze appears
// exactly where the curvature bends terrain toward the horizon, dissolving the
// model edge into the Skydome.

export const curveUniforms = {
  uCurvature: { value: mapTheme.curvature },
  uCenter: { value: new THREE.Vector2(0, 0) },
  // Fog to the SKY's horizon colour (not palette.fog) so fogged-out terrain
  // dissolves into the Skydome with no seam.
  uFogColor: { value: new THREE.Color(mapTheme.palette.skyHorizon) },
  uFogNearR: { value: mapTheme.view.fogNear },
  uFogFarR: { value: mapTheme.view.fogFar },
};

const CURVE_VERTEX = /* glsl */ `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  vec4 worldPos = modelMatrix * mvPosition;
  vec2 dCurve = worldPos.xz - uCenter;
  vFogDist = length( dCurve );
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
    shader.uniforms.uFogColor = curveUniforms.uFogColor;
    shader.uniforms.uFogNearR = curveUniforms.uFogNearR;
    shader.uniforms.uFogFarR = curveUniforms.uFogFarR;
    shader.vertexShader =
      `uniform float uCurvature;\nuniform vec2 uCenter;\nvarying float vFogDist;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        CURVE_VERTEX,
      );
    // Radial fog: mix toward the horizon colour by distance from the centre.
    shader.fragmentShader =
      `uniform vec3 uFogColor;\nuniform float uFogNearR;\nuniform float uFogFarR;\nvarying float vFogDist;\n${shader.fragmentShader}`.replace(
        '#include <fog_fragment>',
        'gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor, smoothstep( uFogNearR, uFogFarR, vFogDist ) );',
      );
  };
  material.needsUpdate = true;
}
