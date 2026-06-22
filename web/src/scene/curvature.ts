import * as THREE from 'three';
import { E, WORLD_SCALE_XZ, WORLD_SCALE_Y } from '../voxel/proj';
import { GLOBE_R } from './globe';
import { mapTheme } from '../mapTheme';
import { AO_R, SKIRT_MIN, SKIRT_RELIEF, SKIRT_MAX, MAX_STOPS } from '../voxel/buildMesh';

// Spherical projection + GPU voxelization — the real "round world". Each LOD cell is
// drawn as cellCols² unit-box instances; this vertex shader builds every box AND
// places it on a globe of radius GLOBE_R:
//   1. From the instance id (aId) it derives the cell column (ci, cj), reads that
//      column's height + 4 neighbours + baked AO from the cell's RG height texture
//      (uHeightTex), seats the box on the terrain, drops the wall to the lowest
//      neighbour (one-voxel floor), and drapes the perimeter LOD skirt — the cube
//      geometry buildMesh.ts used to compute on the CPU, now on the GPU.
//   2. flat (X,Z) → lon/lat (inverse mercator) → unit sphere direction; height →
//      radial axis (r = R + height). This MIRRORS globe.ts's flatToECEF (same
//      constants + lon/lat math) and the column/skirt math mirrors buildMesh.ts's
//      former buildCell — keep them in sync (run globe.ts's selfTest after changes).
//
// Colour is a hypsometric ramp LUT (uRampLUT) sampled by height — so a palette change
// is a single shared-uniform swap, NO re-voxelize. uHeightScale + uAoFloor are shared
// singletons too; one write re-exaggerates / re-floors every cell at once. Per-cell
// data (height texture + minX/minZ/voxel) lives on each cell's own material
// (TileField), read here from `this.userData.cell` so all cells share ONE program.
// NOTE: Z is negated at placement (czNeg) and un-negated (`-worldPos.z`) before the
// mercator math, matching globe.ts (which works in true world Z).

export const curveUniforms = {
  // Vertical exaggeration (UI height-scale). Keep terrain.ts's heightScale in sync
  // (set both together) so the camera follows the exaggerated surface.
  uHeightScale: { value: 1 },
  // Baked-AO floor (= mapTheme.post.aoFloor; 1 ⇒ AO off).
  uAoFloor: { value: 1 },
  // Hypsometric ramp as palette stops (vec4[MAX_STOPS] = elevationM, r, g, b in 0..1
  // sRGB) + the active count. The shader evaluates the ramp EXACTLY per vertex (no LUT
  // quantization), so 0 m land is precisely the sea-level stop colour. App swaps these
  // on palette change → instant recolour, no worker round-trip.
  uStops: { value: new Float32Array(MAX_STOPS * 4) as Float32Array },
  uStopCount: { value: 0 },
};

// --- injected GLSL ---------------------------------------------------------------

// Format a JS number as a GLSL float literal (integers need a trailing `.0`).
const glf = (x: number): string => {
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

const CELL_COLS = mapTheme.view.cellCols; // voxels per cell edge (= instances per cell edge)
const APRON = AO_R; // texture border ring (so edge columns can read neighbours)
const TEX_SIDE = CELL_COLS + 2 * APRON; // height-texture edge in texels
// WS_OVER_E folds the big mercator subtraction into a small multiply for precision:
//   lon = (X·WORLD_SCALE_XZ − E)/E·π = (X·WS_OVER_E − 1)·π
const WS_OVER_E = WORLD_SCALE_XZ / E;
const INV_WORLD_Y = 1 / WORLD_SCALE_Y; // metres (texture) → world-Y

const VOXEL_HEADER = /* glsl */ `
uniform float uHeightScale;
uniform float uAoFloor;
uniform float uMinX;
uniform float uMinZ;
uniform float uVoxel;
uniform sampler2D uHeightTex;
#define MAX_STOPS ${MAX_STOPS}
uniform int uStopCount;
uniform vec4 uStops[MAX_STOPS];   // (elevationM, r, g, b) ascending; rgb 0..1 sRGB
attribute float aId;          // instance index 0 .. cellCols²-1
varying vec3 vBaseColor;
#define PI 3.141592653589793
#define HALF_PI 1.5707963267948966
const int CELL_COLS = ${CELL_COLS};
const int APRON = ${APRON};
const int TEX_SIDE = ${TEX_SIDE};
const float WS_OVER_E = ${glf(WS_OVER_E)};
const float GLOBE_R = ${glf(GLOBE_R)};
const float INV_WORLD_Y = ${glf(INV_WORLD_Y)};
const float SKIRT_MIN = ${glf(SKIRT_MIN)};
const float SKIRT_RELIEF = ${glf(SKIRT_RELIEF)};
const float SKIRT_MAX = ${glf(SKIRT_MAX)};
vec3 srgbToLinear( vec3 c ) {
  return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, step( c, vec3( 0.04045 ) ) );
}
// Exact hypsometric ramp (mirrors buildMesh.ts ramp()): clamp below the first stop,
// lerp between the bracketing stops, clamp above the last. No texture quantization.
vec3 rampColor( float m ) {
  if ( m <= uStops[0].x ) return uStops[0].yzw;
  for ( int i = 1; i < MAX_STOPS; i++ ) {
    if ( i >= uStopCount ) break;
    if ( m <= uStops[i].x ) {
      float lo = uStops[i - 1].x;
      float t = uStops[i].x > lo ? ( m - lo ) / ( uStops[i].x - lo ) : 0.0;
      return mix( uStops[i - 1].yzw, uStops[i].yzw, t );
    }
  }
  return uStops[uStopCount - 1].yzw;
}
`;

// Replaces #include <project_vertex>: build the box from the height texture, then
// project it onto the globe. `transformed` is reassigned (begin_vertex declared it);
// `mvPosition` ends as the view-space position so the later `vViewPosition =
// -mvPosition.xyz` (flat-shading normals) stays correct.
const VOXEL_VERTEX = /* glsl */ `
  int id = int( aId + 0.5 );
  int ci = id - ( id / CELL_COLS ) * CELL_COLS;   // id % CELL_COLS
  int cj = id / CELL_COLS;
  float texel = 1.0 / float( TEX_SIDE );
  vec2 uv = ( vec2( float( ci + APRON ), float( cj + APRON ) ) + 0.5 ) * texel;
  float hM = textureLod( uHeightTex, uv, 0.0 ).r;
  float hL = textureLod( uHeightTex, uv + vec2( -texel, 0.0 ), 0.0 ).r;
  float hR = textureLod( uHeightTex, uv + vec2(  texel, 0.0 ), 0.0 ).r;
  float hD = textureLod( uHeightTex, uv + vec2( 0.0, -texel ), 0.0 ).r;
  float hU = textureLod( uHeightTex, uv + vec2( 0.0,  texel ), 0.0 ).r;
  float ao = textureLod( uHeightTex, uv, 0.0 ).g;
  float topY = hM * INV_WORLD_Y;
  float minN = min( min( hL, hR ), min( hD, hU ) ) * INV_WORLD_Y;
  float maxN = max( max( hL, hR ), max( hD, hU ) ) * INV_WORLD_Y;
  float base = min( minN, topY - uVoxel );          // ≥ one voxel tall
  if ( ci == 0 || ci == CELL_COLS - 1 || cj == 0 || cj == CELL_COLS - 1 ) {
    float relief = max( topY - minN, maxN - topY ); // perimeter LOD skirt
    base = min( base, topY - clamp( SKIRT_RELIEF * relief, SKIRT_MIN * uVoxel, SKIRT_MAX * uVoxel ) );
  }
  float yScale = topY - base;
  float cx = uMinX + ( float( ci ) + 0.5 ) * uVoxel;
  float cy = ( base + topY ) * 0.5;
  float czNeg = -( uMinZ + ( float( cj ) + 0.5 ) * uVoxel );   // negate Z → north up
  transformed = position * vec3( uVoxel, yScale, uVoxel ) + vec3( cx, cy, czNeg );
  // Colour from the exact hypsometric ramp (by height in metres); fold AO in sRGB then
  // linearize. Matches the former per-voxel ramp — no LUT quantization, crisp coastline.
  vec3 rgb = rampColor( hM );
  vBaseColor = srgbToLinear( rgb * ( uAoFloor + ( 1.0 - uAoFloor ) * ao ) );

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

// Carries the LUT colour (× AO) to the fragment stage; multiplied into the diffuse.
const FRAG_HEADER = /* glsl */ `
varying vec3 vBaseColor;
`;

// Per-cell uniforms: the cell's height texture + its world placement. Held on the
// material's userData and read by the shared onBeforeCompile below.
export interface CellUniforms {
  uHeightTex: { value: THREE.Texture | null };
  uMinX: { value: number };
  uMinZ: { value: number };
  uVoxel: { value: number };
}

// Shared across every cell material (same function reference + a constant cache key
// ⇒ ONE compiled program for all cells). It reads this cell's per-cell uniforms from
// `this.userData.cell` and the shared singletons from curveUniforms.
function voxelOnBeforeCompile(
  this: THREE.Material,
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  const cell = (this.userData as { cell: CellUniforms }).cell;
  shader.uniforms.uHeightTex = cell.uHeightTex;
  shader.uniforms.uMinX = cell.uMinX;
  shader.uniforms.uMinZ = cell.uMinZ;
  shader.uniforms.uVoxel = cell.uVoxel;
  shader.uniforms.uHeightScale = curveUniforms.uHeightScale;
  shader.uniforms.uAoFloor = curveUniforms.uAoFloor;
  shader.uniforms.uStops = curveUniforms.uStops;
  shader.uniforms.uStopCount = curveUniforms.uStopCount;
  shader.vertexShader = `${VOXEL_HEADER}\n${shader.vertexShader}`.replace(
    '#include <project_vertex>',
    VOXEL_VERTEX,
  );
  shader.fragmentShader = `${FRAG_HEADER}\n${shader.fragmentShader}`.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n  diffuseColor.rgb *= vBaseColor;',
  );
}

// Install the GPU voxelizer + sphere projection on a cell's material. `cell` carries
// the cell's height texture + world placement. customProgramCacheKey is a constant so
// every cell shares one program despite differing per-cell uniform values.
export function applyVoxelShader(material: THREE.Material, cell: CellUniforms): void {
  material.userData.cell = cell;
  material.onBeforeCompile = voxelOnBeforeCompile;
  material.customProgramCacheKey = () => 'voxel-tex';
  material.needsUpdate = true;
}
