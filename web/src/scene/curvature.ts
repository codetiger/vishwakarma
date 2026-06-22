import * as THREE from 'three';
import { E, WORLD_SCALE_XZ } from '../voxel/proj';
import { GLOBE_R } from './globe';

// Spherical projection — the real "round world". A vertex shader maps every
// ground vertex from the FLAT Web-Mercator world onto a globe of radius GLOBE_R:
// flat (X,Z) → lon/lat (inverse mercator) → unit sphere direction, and the
// height axis Y maps to the RADIAL axis (r = R + height), so a vertical voxel
// column becomes a correct radial voxel. This MIRRORS globe.ts's `flatToECEF`
// (same constants, same lon/lat math); keep the two in sync. The camera
// (RoamControls) places itself with globe.ts so eye and ground share one space.
//
// Every scene material that touches the ground must run this projection, or it
// detaches from the globe. All projected materials SHARE the uniform objects
// below, so a single per-frame write of uHeightScale re-exaggerates the whole
// scene at once. The flat clipmap (TileField) and voxelizer stay flat — the GPU
// does the bend. NOTE: the instance Z is negated at placement (TileField), so the
// shader un-negates it (`-worldPos.z`) before the mercator math; globe.ts works
// in true world Z directly. Keep that pairing.

export const curveUniforms = {
  // Vertical exaggeration: each ground vertex's height (world Y) is scaled before
  // it becomes the radial offset, so the UI height-scale control re-exaggerates
  // all terrain instantly with no re-voxelization. Keep terrain.ts's heightScale
  // in sync (set both together) so the camera follows the exaggerated surface.
  uHeightScale: { value: 1 },
  // Baked-AO floor (= mapTheme.post.aoFloor; 1 ⇒ AO off). The per-voxel AO byte is
  // folded into the instance colour in the vertex shader, so this is a live uniform
  // (no re-voxelize). TileField sets it from the theme. Shared singleton like
  // uHeightScale — one write re-floors every projected material at once.
  uAoFloor: { value: 1 },
};

// Constants injected so the GLSL matches globe.ts exactly. WS_OVER_E folds the
// big mercator subtraction into a small multiply for float precision:
//   lon = (X·WORLD_SCALE_XZ − E)/E·π = (X·WS_OVER_E − 1)·π
const WS_OVER_E = WORLD_SCALE_XZ / E;

// Replaces #include <project_vertex>. When VOXEL_INSTANCING is defined (the voxel
// clipmap material), the unit box is placed from the per-instance attributes FIRST
// — this is what the old per-voxel instanceMatrix did, now built on the GPU — then
// the unchanged sphere projection runs on the placed flat position. `transformed`
// is reassigned (begin_vertex already declared it); `mvPosition` ends as the
// view-space position, so the later `vViewPosition = -mvPosition.xyz` (flat-shading
// normals) stays correct. Non-instanced ground materials skip the box step and
// project `position` directly.
const SPHERE_VERTEX = /* glsl */ `
  #ifdef VOXEL_INSTANCING
    transformed = transformed * vec3( aVoxel, aCenterScale.w, aVoxel ) + aCenterScale.xyz;
    // Fold baked AO in sRGB space (matches the old setColorAt path), then linearize.
    float aoF = uAoFloor + ( 1.0 - uAoFloor ) * aColor.a;
    vBaseColor = srgbToLinear( aColor.rgb * aoF );
  #endif
  vec4 mvPosition = vec4( transformed, 1.0 );
  vec4 worldPos = modelMatrix * mvPosition;        // flat world (X, Y, -Z)
  float lon = ( worldPos.x * WS_OVER_E - 1.0 ) * PI;
  float mny = ( (-worldPos.z) * WS_OVER_E - 1.0 ) * PI;   // un-negate Z
  float lat = 2.0 * atan( exp( mny ) ) - HALF_PI;
  float cosLat = cos( lat );
  vec3 dir = vec3( cosLat * sin( lon ), sin( lat ), cosLat * cos( lon ) );
  float r = GLOBE_R + worldPos.y * uHeightScale;   // height → radial axis
  mvPosition = viewMatrix * vec4( dir * r, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
`;

const SPHERE_HEADER = /* glsl */ `
uniform float uHeightScale;
uniform float uAoFloor;
#define PI 3.141592653589793
#define HALF_PI 1.5707963267948966
const float WS_OVER_E = ${WS_OVER_E};
const float GLOBE_R = ${GLOBE_R};
#ifdef VOXEL_INSTANCING
  attribute vec4 aCenterScale;   // (centreX, centreY, -centreZ, yScale)
  attribute float aVoxel;        // box X/Z extent (cell voxel size)
  attribute vec4 aColor;         // sRGB rgb + baked AO (alpha), normalized 0..1
  varying vec3 vBaseColor;       // constant per instance → no interpolation needed
  vec3 srgbToLinear( vec3 c ) {
    return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, step( c, vec3( 0.04045 ) ) );
  }
#endif
`;

// Carries the folded instance colour to the fragment stage; multiplied into the
// diffuse there (replaces the old instanceColor path).
const FRAG_HEADER = /* glsl */ `
#ifdef VOXEL_INSTANCING
  varying vec3 vBaseColor;
#endif
`;

// Name kept for the existing call site in TileField; it now installs the sphere
// projection (no curvature arg). The voxel material additionally sets
// material.defines.VOXEL_INSTANCING to enable the per-instance box transform +
// colour fold above.
export function applyWorldCurvature(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    // Assign the SHARED uniform objects (not copies): one per-frame write to
    // uHeightScale / uAoFloor updates this material along with every projected one.
    shader.uniforms.uHeightScale = curveUniforms.uHeightScale;
    shader.uniforms.uAoFloor = curveUniforms.uAoFloor;
    shader.vertexShader = `${SPHERE_HEADER}\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      SPHERE_VERTEX,
    );
    shader.fragmentShader = `${FRAG_HEADER}\n${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  #ifdef VOXEL_INSTANCING\n  diffuseColor.rgb *= vBaseColor;\n  #endif',
    );
  };
  material.needsUpdate = true;
}
