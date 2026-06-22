// Decode a grid of height samples (metres) for one LOD cell into a GPU-ready data
// texture. Pure TS (runs in the worker). The cube geometry is then built ENTIRELY
// ON THE GPU from this texture (web/src/scene/curvature.ts's vertex shader): each of
// the cellCols² instances reads its column + 4 neighbours from the texture and
// seats a box on the terrain, drops the wall to the lowest neighbour (one-voxel
// floor), and drapes the perimeter LOD skirt — all in GLSL.
//
//  • Texture layout — `side×side` RG float (side = cellCols + 2·AO_R): R = height in
//    metres for the WHOLE padded grid (so the shader can read each interior column's
//    neighbours), G = baked AO for the interior (drawn) columns.
//  • Baked AO — per-voxel openness from the height ring (radius AO_R): surrounding
//    higher terrain darkens (valley floors, cliff bases), ridges stay bright. Baked
//    HERE (the ring is a 24-tap neighbourhood — cheaper once per tile than per
//    vertex) into the G channel; the shader folds in uAoFloor.
//  • Colour — a hypsometric ramp LUT (buildRampLUT) sampled by height in the shader,
//    so a palette change is a free uniform swap (NO re-voxelize). The ramp is the
//    single source of palette truth; voxelization is palette-independent now.
//
// SYNC: the column/skirt geometry lives ONLY in curvature.ts's GLSL now (not here).
// If the AO ring or the height encoding changes, change both together. (Like the
// encode.py↔heightTile.ts and globe.ts↔curvature.ts pairs the project already keeps.)

import { WORLD_SCALE_Y } from './proj';

export interface CellTexture {
  // side*side*2 interleaved RG: R = height (metres), G = baked AO (interior columns).
  texData: Float32Array;
  // cellCols² — the number of box instances the GPU draws for this cell.
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
// Perimeter LOD-skirt params (in voxels / × relief). The skirt is APPLIED in the
// vertex shader now (curvature.ts) — these are exported so the shader can inject
// them as GLSL consts, keeping the single source of truth here.
export const SKIRT_MIN = 2; // perimeter skirt floor, in voxels
export const SKIRT_RELIEF = 4; // skirt grows this × the local relief
export const SKIRT_MAX = 32; // skirt cap, in voxels

// Hypsometric LUT domain (metres). Covers ETOPO's range with margin; buildRampLUT
// samples the ramp across [LUT_MIN_M, LUT_MAX_M] and the shader maps a sampled
// height into [0,1] over the same span. Exported so curvature.ts injects them.
export const LUT_MIN_M = -11000;
export const LUT_MAX_M = 9000;

// Precomputed AO ring offsets with 1/distance weights (distance in columns).
const RING: [number, number, number][] = [];
for (let dj = -AO_R; dj <= AO_R; dj++)
  for (let di = -AO_R; di <= AO_R; di++)
    if (di || dj) RING.push([di, dj, 1 / Math.hypot(di, dj)]);

// Bake a palette's hypsometric ramp into a 256-entry RGBA LUT (sRGB bytes). The
// shader samples this by normalized height; swapping the LUT recolours instantly.
export function buildRampLUT(palette: PaletteId): Uint8Array {
  const stops = PALETTES[palette] ?? PALETTES[DEFAULT_PALETTE];
  const span = LUT_MAX_M - LUT_MIN_M;
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const rgb = ramp(LUT_MIN_M + (i / 255) * span, stops);
    lut[i * 4] = (rgb >> 16) & 0xff;
    lut[i * 4 + 1] = (rgb >> 8) & 0xff;
    lut[i * 4 + 2] = rgb & 0xff;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function buildCellTexture(
  heightsM: Float32Array,
  side: number,
  apron: number,
  cellCols: number,
  voxelSize: number,
): CellTexture {
  const count = cellCols * cellCols;
  const texData = new Float32Array(side * side * 2);
  const invY = 1 / WORLD_SCALE_Y;

  // R channel: height in metres for every texel (incl. the apron ring — the shader
  // reads each interior column's 4 neighbours for the wall + skirt). G defaults 0.
  for (let i = 0; i < side * side; i++) texData[i * 2] = heightsM[i];

  // G channel: baked AO for the interior (drawn) columns — the elevation-angle
  // tangent of higher ring neighbours, in world-Y. (Apron AO is never sampled.)
  for (let cj = 0; cj < cellCols; cj++) {
    for (let ci = 0; ci < cellCols; ci++) {
      const idx = (cj + apron) * side + (ci + apron);
      const topY = heightsM[idx] * invY;
      let occ = 0;
      for (let t = 0; t < RING.length; t++) {
        const [di, dj, w] = RING[t];
        const rise = heightsM[idx + dj * side + di] * invY - topY;
        if (rise > 0) occ += rise * w;
      }
      texData[idx * 2 + 1] = Math.max(0, Math.min(1, 1 - (AO_STRENGTH * occ) / (voxelSize * RING.length)));
    }
  }
  return { texData, count };
}
