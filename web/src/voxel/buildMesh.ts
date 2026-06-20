// Turn a grid of height samples (metres) into instance buffers for one LOD cell.
// Pure TS (runs in the worker). Per column: one box whose top face is seated on
// the exact terrain height and whose bottom drops to the lowest 4-neighbour, so
// the wall between a column and a lower neighbour is filled (no see-through gaps),
// with a one-voxel floor so flat ground still shows cubes.
//
//  • LOD skirt — cell-perimeter columns drape further down (by the local relief,
//    min two voxels) so the gap to a coarser-LOD neighbour is covered. The droop
//    is hidden behind terrain everywhere except at a level transition, where it
//    seals the crack. Skirt depth can't be baked into the tile (it depends on the
//    neighbour's runtime LOD), so it lives here.
//  • Baked AO — per-voxel openness from the height ring (radius AO_R): surrounding
//    higher terrain darkens (valley floors, cliff bases), ridges stay bright. Goes
//    in the colour's top byte, where the renderer folds it in (aoFloor).

import { WORLD_SCALE_Y } from './proj';

export interface MeshBuffers {
  positions: Float32Array; // count * 3 (voxel centres, world space)
  colors: Uint32Array; // count, packed 0xAARRGGBB (AO in top byte)
  yScales: Float32Array; // count, world-unit Y extent of each box
  count: number;
}

// Elevation (m) → sRGB. Sea is blue; land greens→tan→brown→grey→snow.
const STOPS: [number, number, number, number][] = [
  [-6000, 10, 24, 58],
  [-200, 26, 64, 110],
  [-1, 44, 96, 150],
  [0, 66, 106, 84],
  [200, 96, 130, 74],
  [700, 150, 150, 92],
  [1800, 148, 120, 84],
  [3200, 122, 112, 106],
  [4600, 182, 184, 190],
  [6500, 255, 255, 255],
];

function ramp(m: number): number {
  let lo = STOPS[0];
  let hi = STOPS[STOPS.length - 1];
  if (m <= lo[0]) hi = lo;
  else if (m >= hi[0]) lo = hi;
  else
    for (let i = 1; i < STOPS.length; i++)
      if (m <= STOPS[i][0]) {
        lo = STOPS[i - 1];
        hi = STOPS[i];
        break;
      }
  const t = hi[0] === lo[0] ? 0 : (m - lo[0]) / (hi[0] - lo[0]);
  const r = (lo[1] + (hi[1] - lo[1]) * t) | 0;
  const g = (lo[2] + (hi[2] - lo[2]) * t) | 0;
  const b = (lo[3] + (hi[3] - lo[3]) * t) | 0;
  return (r << 16) | (g << 8) | b;
}

export const AO_R = 2; // openness ring radius, in columns (needs apron ≥ AO_R)
const AO_STRENGTH = 1.7;
const SKIRT_MIN = 2; // perimeter skirt floor, in voxels
const SKIRT_RELIEF = 4; // skirt grows this × the local relief
const SKIRT_MAX = 32; // skirt cap, in voxels

// Precomputed AO ring offsets with 1/distance weights (distance in columns).
const RING: [number, number, number][] = [];
for (let dj = -AO_R; dj <= AO_R; dj++)
  for (let di = -AO_R; di <= AO_R; di++)
    if (di || dj) RING.push([di, dj, 1 / Math.hypot(di, dj)]);

export function buildCell(
  heightsM: Float32Array,
  side: number,
  apron: number,
  cellCols: number,
  voxelSize: number,
  minX: number,
  minZ: number,
): MeshBuffers {
  const count = cellCols * cellCols;
  const positions = new Float32Array(count * 3);
  const colors = new Uint32Array(count);
  const yScales = new Float32Array(count);
  const invY = 1 / WORLD_SCALE_Y;

  // World-Y height for the whole padded grid (reused by walls, skirt, and AO).
  const H = new Float32Array(side * side);
  for (let i = 0; i < H.length; i++) H[i] = heightsM[i] * invY;

  let k = 0;
  for (let cj = 0; cj < cellCols; cj++) {
    for (let ci = 0; ci < cellCols; ci++) {
      const r = cj + apron;
      const c = ci + apron;
      const idx = r * side + c;
      const topY = H[idx];

      const nL = H[idx - 1];
      const nR = H[idx + 1];
      const nD = H[idx - side];
      const nU = H[idx + side];
      const minN = Math.min(nL, nR, nD, nU);
      const maxN = Math.max(nL, nR, nD, nU);
      let base = Math.min(minN, topY - voxelSize); // ≥ one voxel tall

      // LOD skirt on the cell perimeter (sized by local relief, clamped).
      if (ci === 0 || ci === cellCols - 1 || cj === 0 || cj === cellCols - 1) {
        const relief = Math.max(topY - minN, maxN - topY);
        const skirt = Math.min(
          Math.max(SKIRT_MIN * voxelSize, SKIRT_RELIEF * relief),
          SKIRT_MAX * voxelSize,
        );
        base = Math.min(base, topY - skirt);
      }

      // Baked AO: sum the elevation-angle tangent of higher ring neighbours.
      let occ = 0;
      for (let t = 0; t < RING.length; t++) {
        const [di, dj, w] = RING[t];
        const rise = H[idx + dj * side + di] - topY;
        if (rise > 0) occ += rise * w;
      }
      const ao = Math.max(0, Math.min(1, 1 - (AO_STRENGTH * occ) / (voxelSize * RING.length)));

      positions[k * 3] = minX + (ci + 0.5) * voxelSize;
      positions[k * 3 + 1] = (base + topY) * 0.5;
      positions[k * 3 + 2] = minZ + (cj + 0.5) * voxelSize;
      yScales[k] = topY - base;
      colors[k] = (((ao * 255) | 0) * 0x1000000 + ramp(heightsM[idx])) >>> 0;
      k++;
    }
  }
  return { positions, colors, yScales, count };
}
