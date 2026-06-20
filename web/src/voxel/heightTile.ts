// Height-tile decode + fetch/cache + bilinear sampling. Mirrors the byte layout
// written by tools/gen_pyramid/encode.py. Pure TS (runs in the worker and on the
// main thread). Samples are addressed on the GLOBAL Web-Mercator grid and read
// from each sample's home tile, so bilinear interpolation across tile boundaries
// fetches whatever neighbour tiles it needs (the stored border is unused here).
//
// Tiles are HEADERLESS: the file is just the per-block table + payload. Geometry
// (tileSamples, border, blockSize) and the format version live in the manifest;
// z/x/y are the URL path. The decoder is handed n/border/blk by the TileStore.

import { E, type Manifest } from './proj';

export interface Tile {
  data: Int16Array;
}

export const MANIFEST_VERSION = 2; // headerless tiles; checked once per pyramid load
const BLOCK_ENTRY = 3; // per-block table entry: i16 base + u8 bits

// Decode a headerless per-block bit-packed height tile (mirrors encode.py). The
// tile is a grid of blk×blk blocks, each with its own base + `bits` width; samples
// are value = code − base, LSB-first, row-major within the block, byte-aligned per
// block (bits=0 ⇒ constant block, no payload). Decodes into one flat Int16Array.
export function decodeTile(buf: ArrayBuffer, n: number, border: number, blk: number): Tile {
  const dv = new DataView(buf);
  const side = n + 2 * border;
  const nb = Math.ceil(side / blk);
  const data = new Int16Array(side * side);
  const bytes = new Uint8Array(buf);
  let tableOff = 0;
  let payOff = BLOCK_ENTRY * nb * nb;

  for (let r0 = 0; r0 < side; r0 += blk) {
    const r1 = Math.min(r0 + blk, side);
    for (let c0 = 0; c0 < side; c0 += blk) {
      const c1 = Math.min(c0 + blk, side);
      const base = dv.getInt16(tableOff, true);
      const bits = dv.getUint8(tableOff + 2);
      tableOff += BLOCK_ENTRY;
      if (bits === 0) {
        for (let r = r0; r < r1; r++) data.fill(base, r * side + c0, r * side + c1);
      } else {
        const mask = (1 << bits) - 1; // bits ≤ 16 → a value spans ≤ 3 bytes
        let bitpos = 0; // bit offset within this block's payload
        for (let r = r0; r < r1; r++) {
          let o = r * side + c0;
          for (let c = c0; c < c1; c++) {
            const bp = payOff + (bitpos >> 3);
            const chunk =
              bytes[bp] | ((bytes[bp + 1] ?? 0) << 8) | ((bytes[bp + 2] ?? 0) << 16);
            data[o++] = base + ((chunk >>> (bitpos & 7)) & mask);
            bitpos += bits;
          }
        }
        payOff += (bitpos + 7) >> 3; // advance past this block (byte-aligned)
      }
    }
  }
  return { data };
}

type Slot = Tile | null | Promise<Tile | null>;

export class TileStore {
  private cache = new Map<string, Slot>();
  private N: number;
  private B: number;
  private BLK: number;
  private scale: number;
  private offset: number;

  constructor(m: Manifest, private urlFor: (z: number, x: number, y: number) => string) {
    if (m.version !== MANIFEST_VERSION) {
      throw new Error(`manifest version ${m.version}, expected ${MANIFEST_VERSION}`);
    }
    this.N = m.tileSamples;
    this.B = m.border;
    this.BLK = m.blockSize;
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
        const t = r.ok ? decodeTile(await r.arrayBuffer(), this.N, this.B, this.BLK) : null;
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
    const side = N + 2 * this.B;
    const lc = col - tx * N + this.B;
    const lr = row - ty * N + this.B;
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
