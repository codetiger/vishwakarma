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
    };

export type FromWorker =
  | { type: 'ready' }
  | {
      type: 'tile';
      id: number;
      key: string;
      voxelSize: number;
      /** cellCols² — number of box instances the GPU draws for this cell. */
      count: number;
      /** Texture edge in texels (cellCols + 2·AO_R). */
      side: number;
      /** side*side*2 interleaved RG float: R = height (metres) for the whole padded
       *  grid, G = baked AO for the interior columns. The vertex shader builds every
       *  box from this (no per-instance geometry). Voxelization is palette-independent
       *  now — colour is a ramp-LUT swap in the shader. */
      texData: Float32Array;
    }
  | { type: 'error'; id?: number; message: string };

/** A finished tile tagged with which pool worker produced it, so the dispatcher
 *  can free that worker's in-flight slot. */
export type TileResult = Extract<FromWorker, { type: 'tile' }> & { widx: number };
