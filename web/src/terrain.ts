// Main-thread terrain sampler. Loads the pyramid manifest and preloads the
// coarsest (minZoom) tiles, then answers height queries by bilinear-sampling that
// coarse level — cheap enough to call every frame to lock the camera to the
// terrain beneath it. No wasm.

import { TileStore } from './voxel/heightTile';
import { makeProj, type Manifest, type Proj, WORLD_SCALE_Y } from './voxel/proj';

export interface WorldInfo {
  /** [minX, minZ, maxX, maxZ] — lateral footprint, world units. */
  bounds: [number, number, number, number];
  /** [hMin, hMax] — height range, world units. */
  heightRange: [number, number];
  /** [finest, coarsest] world voxel size (maxZoom..minZoom). */
  voxelRange: [number, number];
}

let proj: Proj | null = null;
let store: TileStore | null = null;
let coarseZoom = 0;

/** Load the pyramid for main-thread queries. Returns its world footprint. */
export async function initTerrain(manifestUrl: string): Promise<WorldInfo> {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`fetch ${manifestUrl}: ${res.status}`);
  const m: Manifest = await res.json();
  proj = makeProj(m);
  const base = manifestUrl.replace(/manifest\.json(\?.*)?$/, '');
  store = new TileStore(m, (z, x, y) =>
    base + m.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
  );
  coarseZoom = m.minZoom;
  const cov = m.coverage[String(coarseZoom)];
  if (cov) {
    await store.preloadRange(coarseZoom, cov.xRange[0], cov.xRange[1], cov.yRange[0], cov.yRange[1]);
  }
  return {
    bounds: proj.worldBounds,
    heightRange: proj.heightRangeWorld,
    voxelRange: [proj.voxelSize(m.maxZoom), proj.voxelSize(m.minZoom)],
  };
}

/** Terrain height h(x, z) in world units (coarse). 0 before load. */
export function terrainHeight(x: number, z: number): number {
  if (!proj || !store) return 0;
  const [mx, my] = proj.worldToMerc(x, z);
  return store.sampleSync(mx, my, coarseZoom) / WORLD_SCALE_Y;
}
