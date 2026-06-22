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
//    higher terrain darkens (valley floors, cliff bases), ridges stay bright. Carried
//    in the colour's alpha byte; the vertex shader folds it in (uAoFloor).
//
// Output is GPU-ready per-instance data — no main-thread rebuild. The vertex shader
// (curvature.ts) places each unit box directly from these attributes:
//   transformed = position * vec3(voxel, yScale, voxel) + centre
// so there is no per-voxel matrix/colour loop on the main thread anymore.

import { WORLD_SCALE_Y } from './proj';

export interface MeshBuffers {
  // count * 4: (centreX, centreY, -centreZ, yScale). Z is negated HERE (north-up);
  // the shader un-negates it (`-worldPos.z`) before the mercator math.
  iCenterScale: Float32Array;
  // count * 4: sRGB r, g, b (0..255) + baked-AO byte in alpha (255 = open). Emitted
  // as explicit bytes (not a packed u32) so the GPU attribute is endianness-free.
  iColor: Uint8Array;
  count: number;
}

// Elevation (m) → sRGB hypsometric ramps. Each palette is a list of stops
// `[elevationM, r, g, b]` ascending by elevation; `ramp` lerps between them (sea
// below 0 m, land above). To add a palette: add a stop list here AND its id to
// `PaletteId` and the App dropdown. Colour lives in the voxelizer — not in the
// tile, not in mapTheme.
export type PaletteId = 'atlas' | 'terrain' | 'grayscale' | 'viridis' | 'inferno';

type Stops = [number, number, number, number][];

export const PALETTES: Record<PaletteId, Stops> = {
  // Classic atlas tints: blue sea → green lowland → tan → brown → grey → snow.
  atlas: [
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
  ],
  // matplotlib `terrain`: deep blue → cyan ocean → green shore → pale yellow →
  // brown → white peaks.
  terrain: [
    [-6000, 48, 48, 140],
    [-2400, 0, 153, 255],
    [-1, 64, 196, 222],
    [0, 0, 168, 96],
    [1600, 230, 230, 150],
    [3600, 150, 112, 84],
    [5200, 224, 214, 208],
    [6500, 255, 255, 255],
  ],
  // Raw DEM heightmap: dark (low) → light (high), neutral grey.
  grayscale: [
    [-6000, 6, 6, 9],
    [-1, 40, 40, 44],
    [0, 64, 64, 66],
    [3000, 150, 150, 152],
    [6500, 248, 248, 248],
  ],
  // Viridis (perceptually uniform): purple → blue → teal → green → yellow.
  viridis: [
    [-6000, 68, 1, 84],
    [-2000, 59, 82, 139],
    [1000, 33, 145, 140],
    [3800, 94, 201, 98],
    [6500, 253, 231, 37],
  ],
  // Inferno (perceptually uniform, warm): black → purple → red → orange → cream.
  inferno: [
    [-6000, 0, 0, 4],
    [-2000, 87, 16, 110],
    [1000, 188, 55, 84],
    [3800, 249, 142, 8],
    [6500, 252, 255, 164],
  ],
};

export const DEFAULT_PALETTE: PaletteId = 'atlas';

function ramp(m: number, stops: Stops): number {
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  if (m <= lo[0]) hi = lo;
  else if (m >= hi[0]) lo = hi;
  else
    for (let i = 1; i < stops.length; i++)
      if (m <= stops[i][0]) {
        lo = stops[i - 1];
        hi = stops[i];
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
  palette: PaletteId,
): MeshBuffers {
  const count = cellCols * cellCols;
  const iCenterScale = new Float32Array(count * 4);
  const iColor = new Uint8Array(count * 4);
  const invY = 1 / WORLD_SCALE_Y;
  const stops = PALETTES[palette] ?? PALETTES[DEFAULT_PALETTE];

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

      const o = k * 4;
      iCenterScale[o] = minX + (ci + 0.5) * voxelSize;
      iCenterScale[o + 1] = (base + topY) * 0.5;
      iCenterScale[o + 2] = -(minZ + (cj + 0.5) * voxelSize); // negate Z → north up
      iCenterScale[o + 3] = topY - base; // yScale (world-unit box height)
      const rgb = ramp(heightsM[idx], stops);
      iColor[o] = (rgb >> 16) & 0xff;
      iColor[o + 1] = (rgb >> 8) & 0xff;
      iColor[o + 2] = rgb & 0xff;
      iColor[o + 3] = (ao * 255) | 0; // baked AO → alpha
      k++;
    }
  }
  return { iCenterScale, iColor, count };
}
