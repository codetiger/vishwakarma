// Message protocol between the main thread and the voxel worker.
//
// The viewer streams the surface as a distance-based LOD clipmap: a coarse base
// covering the whole area, with progressively finer rings toward the camera. The
// tile manager picks each cell's world bounds and voxel size and sends them
// explicitly; the worker just voxelizes that rectangle. `key` routes the result
// back to its cell.

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
      /** Neighbour radius (in voxels) for the per-voxel colour cross-fade. */
      blendRadius: number;
    };

export type FromWorker =
  | { type: 'ready' }
  | {
      type: 'tile';
      id: number;
      key: string;
      voxelSize: number;
      count: number;
      positions: Float32Array;
      /** One packed sRGB `0x00RRGGBB` colour per voxel. */
      colors: Uint32Array;
      /** Per-voxel Y (height) scale, world units. Surface voxels are stretched so
       *  their top face lands on the exact terrain height; the rest are voxelSize. */
      yScales: Float32Array;
    }
  | { type: 'error'; id?: number; message: string };

/** A finished tile tagged with which pool worker produced it, so the dispatcher
 *  can free that worker's in-flight slot. */
export type TileResult = Extract<FromWorker, { type: 'tile' }> & { widx: number };
