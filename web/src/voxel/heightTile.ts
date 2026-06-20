// Height-tile decode + fetch/cache + bilinear sampling. Mirrors the byte layout
// written by tools/gen_pyramid/encode.py. Pure TS (runs in the worker and on the
// main thread). Samples are addressed on the GLOBAL Web-Mercator grid and read
// from each sample's home tile, so bilinear interpolation across tile boundaries
// fetches whatever neighbour tiles it needs (the stored border is unused here).

import { E, type Manifest } from './proj';

export interface Tile {
  z: number;
  x: number;
  y: number;
  n: number;
  border: number;
  data: Int16Array;
}

const MAGIC = 0x564b4831; // "VKH1" big-endian

export function decodeTile(buf: ArrayBuffer): Tile {
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== MAGIC) throw new Error('bad tile magic');
  const z = dv.getUint8(5);
  const x = dv.getUint32(8, true);
  const y = dv.getUint32(12, true);
  const n = dv.getUint16(16, true);
  const border = dv.getUint16(18, true);
  const side = n + 2 * border;
  return { z, x, y, n, border, data: new Int16Array(buf, 20, side * side) };
}

type Slot = Tile | null | Promise<Tile | null>;

export class TileStore {
  private cache = new Map<string, Slot>();
  private N: number;
  private scale: number;
  private offset: number;

  constructor(m: Manifest, private urlFor: (z: number, x: number, y: number) => string) {
    this.N = m.tileSamples;
    this.scale = m.heightScale;
    this.offset = m.heightOffset;
  }

  private res(z: number) {
    return (2 * E) / (2 ** z * this.N);
  }

  load(z: number, x: number, y: number): Promise<Tile | null> {
    const key = `${z}/${x}/${y}`;
    const e = this.cache.get(key);
    if (e !== undefined) return Promise.resolve(e instanceof Promise ? e : e);
    const p = fetch(this.urlFor(z, x, y))
      .then(async (r) => {
        const t = r.ok ? decodeTile(await r.arrayBuffer()) : null;
        this.cache.set(key, t);
        return t;
      })
      .catch(() => {
        this.cache.set(key, null);
        return null;
      });
    this.cache.set(key, p);
    return p;
  }

  /** Preload every tile a sample inside this merc bbox (±1 sample) could read. */
  async ensureCover(mnX: number, mnY: number, mxX: number, mxY: number, z: number): Promise<void> {
    const p = this.res(z);
    const N = this.N;
    const colMin = Math.floor((mnX + E) / p - 0.5) - 1;
    const colMax = Math.ceil((mxX + E) / p - 0.5) + 1;
    const rowMin = Math.floor((E - mxY) / p - 0.5) - 1; // north edge → smaller row
    const rowMax = Math.ceil((E - mnY) / p - 0.5) + 1;
    const jobs: Promise<unknown>[] = [];
    for (let ty = Math.floor(rowMin / N); ty <= Math.floor(rowMax / N); ty++) {
      for (let tx = Math.floor(colMin / N); tx <= Math.floor(colMax / N); tx++) {
        if (tx < 0 || ty < 0) continue;
        jobs.push(this.load(z, tx, ty));
      }
    }
    await Promise.all(jobs);
  }

  async preloadRange(z: number, x0: number, x1: number, y0: number, y1: number): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push(this.load(z, x, y));
    await Promise.all(jobs);
  }

  /** One sample (col,row) on the global grid, read from its home tile. 0 if absent. */
  private at(col: number, row: number, z: number): number {
    const N = this.N;
    const tx = Math.floor(col / N);
    const ty = Math.floor(row / N);
    const t = this.cache.get(`${z}/${tx}/${ty}`);
    if (!t || t instanceof Promise) return 0;
    const side = N + 2 * t.border;
    const lc = col - tx * N + t.border;
    const lr = row - ty * N + t.border;
    return t.data[lr * side + lc] * this.scale + this.offset;
  }

  /** Bilinear height (metres) at a merc coordinate; tiles must be preloaded. */
  sampleSync(mercX: number, mercY: number, z: number): number {
    const p = this.res(z);
    const colf = (mercX + E) / p - 0.5;
    const rowf = (E - mercY) / p - 0.5;
    const c0 = Math.floor(colf);
    const r0 = Math.floor(rowf);
    const fx = colf - c0;
    const fy = rowf - r0;
    const h00 = this.at(c0, r0, z);
    const h10 = this.at(c0 + 1, r0, z);
    const h01 = this.at(c0, r0 + 1, z);
    const h11 = this.at(c0 + 1, r0 + 1, z);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }
}
