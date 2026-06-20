// Web-Mercator projection + world-scale mapping. Mirrors
// tools/gen_pyramid/mercator.py. Pure (no DOM/THREE) so it runs in the worker
// and on the main thread alike.
//
// World units: mercator metres are huge, so we divide by a scale. Horizontally
// 1 unit = 0.1° of mercator-x (≈ 11.1 km), which puts the India region at
// ~380×420 units — the numeric range mapTheme + RoamControls are already tuned
// for. Vertically we exaggerate (÷300 m) so mountains actually read as relief.

export const E = 20037508.342789244; // web-mercator half-extent (m)
export const WORLD_SCALE_XZ = 11131.949079327358; // m per world unit (= 0.1° merc-x)
export const WORLD_SCALE_Y = 200; // m per world height unit (vertical exaggeration)

export interface Manifest {
  version: number;
  projection: string;
  tileSamples: number;
  border: number;
  heightScale: number;
  heightOffset: number;
  nodata: number;
  minZoom: number;
  maxZoom: number;
  originMerc: [number, number];
  regionMerc: [number, number, number, number]; // [mx0,my0,mx1,my1]
  verticalExaggeration: number;
  heightRange: [number, number];
  coverage: Record<string, { xRange: [number, number]; yRange: [number, number] }>;
  tileUrl: string;
}

export interface Proj {
  m: Manifest;
  N: number;
  /** [minX, minZ, maxX, maxZ] world footprint (SW corner at origin). */
  worldBounds: [number, number, number, number];
  /** [hMin, hMax] in world Y units. */
  heightRangeWorld: [number, number];
  /** world (x,z) → mercator (x,y); z increases north. */
  worldToMerc(x: number, z: number): [number, number];
  /** metres → world Y. */
  toWorldY(metres: number): number;
  /** merc metres per height sample at zoom z. */
  res(z: number): number;
  /** world voxel size at zoom z. */
  voxelSize(z: number): number;
  /** world voxel size → nearest pyramid zoom (clamped to [minZoom,maxZoom]). */
  voxelToZoom(v: number): number;
}

export function makeProj(m: Manifest): Proj {
  const N = m.tileSamples;
  const [ox, oy] = m.originMerc;
  const [mx0, my0, mx1, my1] = m.regionMerc;
  const worldBounds: [number, number, number, number] = [
    (mx0 - ox) / WORLD_SCALE_XZ,
    (my0 - oy) / WORLD_SCALE_XZ,
    (mx1 - ox) / WORLD_SCALE_XZ,
    (my1 - oy) / WORLD_SCALE_XZ,
  ];
  const res = (z: number) => (2 * E) / (2 ** z * N);
  return {
    m,
    N,
    worldBounds,
    heightRangeWorld: [m.heightRange[0] / WORLD_SCALE_Y, m.heightRange[1] / WORLD_SCALE_Y],
    worldToMerc: (x, z) => [ox + x * WORLD_SCALE_XZ, oy + z * WORLD_SCALE_XZ],
    toWorldY: (metres) => metres / WORLD_SCALE_Y,
    res,
    voxelSize: (z) => res(z) / WORLD_SCALE_XZ,
    voxelToZoom: (v) => {
      const mercVoxel = v * WORLD_SCALE_XZ; // = res(z)
      const z = Math.round(Math.log2((2 * E) / (mercVoxel * N)));
      return Math.max(m.minZoom, Math.min(m.maxZoom, z));
    },
  };
}
