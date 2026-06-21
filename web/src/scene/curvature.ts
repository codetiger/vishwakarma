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
};

// Constants injected so the GLSL matches globe.ts exactly. WS_OVER_E folds the
// big mercator subtraction into a small multiply for float precision:
//   lon = (X·WORLD_SCALE_XZ − E)/E·π = (X·WS_OVER_E − 1)·π
const WS_OVER_E = WORLD_SCALE_XZ / E;

const SPHERE_VERTEX = /* glsl */ `
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
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
#define PI 3.141592653589793
#define HALF_PI 1.5707963267948966
const float WS_OVER_E = ${WS_OVER_E};
const float GLOBE_R = ${GLOBE_R};
`;

// Name kept for the existing call site in TileField; it now installs the sphere
// projection (no curvature arg).
export function applyWorldCurvature(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    // Assign the SHARED uniform object (not a copy): one per-frame write to
    // uHeightScale updates this material along with every other projected one.
    shader.uniforms.uHeightScale = curveUniforms.uHeightScale;
    shader.vertexShader = `${SPHERE_HEADER}\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      SPHERE_VERTEX,
    );
  };
  material.needsUpdate = true;
}
