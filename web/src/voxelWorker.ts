/// <reference lib="webworker" />
import { AO_R, buildCell } from './voxel/buildMesh';
import { TileStore } from './voxel/heightTile';
import { makeProj, type Manifest, type Proj } from './voxel/proj';
import type { FromWorker, ToWorker } from './voxelTypes';

// Reads the pyramid manifest once, then turns each LOD-cell request (a world rect
// + voxel size) into instance buffers: pick the matching pyramid zoom, fetch the
// covering height tiles (cached), bilinear-sample one column per voxel (+ an apron
// ring so cell-edge walls/AO see their neighbours), and build the cubes. No wasm.

let proj: Proj | null = null;
let store: TileStore | null = null;
const APRON = AO_R; // apron ring must cover the AO neighbourhood (and the wall ±1)

const post = (msg: FromWorker, transfer?: Transferable[]) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

const tileUrl = (base: string, m: Manifest) => (z: number, x: number, y: number) =>
  base + m.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;

  if (msg.type === 'load') {
    try {
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error(`fetch ${msg.url}: ${res.status}`);
      const m: Manifest = await res.json();
      proj = makeProj(m);
      const base = msg.url.replace(/manifest\.json(\?.*)?$/, '');
      store = new TileStore(m, tileUrl(base, m));
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', message: String(err) });
    }
    return;
  }

  if (msg.type === 'voxelizeTile') {
    if (!proj || !store) return;
    try {
      const { minX, minZ, maxX, maxZ, voxelSize } = msg;
      const z = proj.voxelToZoom(voxelSize);
      const cellCols = Math.max(1, Math.round((maxX - minX) / voxelSize));
      const side = cellCols + 2 * APRON;

      // Preload every pyramid tile the cell + apron can sample.
      const [mnX, mnY] = proj.worldToMerc(minX - APRON * voxelSize, minZ - APRON * voxelSize);
      const [mxX, mxY] = proj.worldToMerc(maxX + APRON * voxelSize, maxZ + APRON * voxelSize);
      await store.ensureCover(mnX, mnY, mxX, mxY, z);

      // Sample one height (metres) per column, including the apron ring.
      const heights = new Float32Array(side * side);
      for (let cj = 0; cj < side; cj++) {
        const wz = minZ + (cj - APRON + 0.5) * voxelSize;
        for (let ci = 0; ci < side; ci++) {
          const wx = minX + (ci - APRON + 0.5) * voxelSize;
          const [mx, my] = proj.worldToMerc(wx, wz);
          heights[cj * side + ci] = store.sampleSync(mx, my, z);
        }
      }

      const mesh = buildCell(heights, side, APRON, cellCols, voxelSize, minX, minZ);
      post(
        {
          type: 'tile',
          id: msg.id,
          key: msg.key,
          voxelSize,
          count: mesh.count,
          positions: mesh.positions,
          colors: mesh.colors,
          yScales: mesh.yScales,
        },
        [mesh.positions.buffer, mesh.colors.buffer, mesh.yScales.buffer],
      );
    } catch (err) {
      post({ type: 'error', id: msg.id, message: String(err) });
    }
  }
};
