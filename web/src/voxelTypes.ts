// Message protocol between the main thread and the voxel worker.
//
// The viewer streams the surface as a distance-based LOD clipmap: a coarse base
// covering the whole area, with progressively finer rings toward the camera. The
// tile manager picks each cell's world bounds and voxel size and sends them
// explicitly; the worker just voxelizes that rectangle. `key` routes the result
// back to its cell.

import type { PaletteId } from './voxel/buildMesh';

export type ToWorker =
  | { type: 'load'; url: string }
  | {
      type: 'voxelizeTile';
      id: number;
      key: string;
      minX: number;
      minZ: number;
      maxX: number;
      maxZ: number;
      voxelSize: number;
      palette: PaletteId;
    };

export type FromWorker =
  | { type: 'ready' }
  | {
      type: 'tile';
      id: number;
      key: string;
      voxelSize: number;
      /** Echoed back so the tile manager can drop results built with a superseded
       *  palette (mirrors the `voxelSize` staleness check). */
      palette: PaletteId;
      count: number;
      /** GPU-ready per-instance data (no main-thread rebuild). Wrapped directly in
       *  InstancedBufferAttributes by TileField. count*4: (centreX, centreY,
       *  -centreZ, yScale) — Z negated for north-up; yScale is the box height. */
      iCenterScale: Float32Array;
      /** count*4 bytes: sRGB r,g,b + baked-AO in alpha (normalized in the shader). */
      iColor: Uint8Array;
    }
  | { type: 'error'; id?: number; message: string };

/** A finished tile tagged with which pool worker produced it, so the dispatcher
 *  can free that worker's in-flight slot. */
export type TileResult = Extract<FromWorker, { type: 'tile' }> & { widx: number };
