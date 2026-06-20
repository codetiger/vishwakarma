# vishwakarma

A browser **voxel terrain viewer**. It streams real-world elevation as a global
**Web-Mercator height-tile pyramid** and voxelizes it on the fly in a pool of Web
Workers — roam a 2.5D voxel landscape with distance-based LOD, hypsometric-coloured
cubes, a round-world horizon, radial fog, and screen-space AO + bloom, entirely
client-side (no Rust/wasm).

Two parts:

- **`tools/gen_pyramid/`** — an offline Python tool: ETOPO DEM → reproject to Web
  Mercator → mip pyramid → `i16` height tiles + a manifest.
- **`web/`** — a Vite + React-Three-Fiber viewer: a quadtree LOD clipmap fetches
  the tiles, and a pool of JS workers turns each cell into instanced cubes (cull +
  hypsometric colour + baked AO + LOD skirt) as you roam.

## Quickstart

```bash
# 1. Build the height-tile pyramid (fetches the ETOPO bbox on first run, then cached)
cd tools
pip install -r gen_pyramid/requirements.txt
python -m gen_pyramid                 # → web/public/pyramid/

# 2. Run the viewer
cd ../web
npm install
npm run dev                           # http://localhost:5173
```

Roam with **drag / WASD**, turn with **shift-drag / Q E**, **wheel** to zoom.

## How it works

The tile is just heights — colour, ambient occlusion, culling, and the LOD skirt
are all derived in the browser, so the wire format stays tiny and the same tiles
work at any voxel size:

1. `gen_pyramid` cuts the DEM into a slippy-map quadtree (`z=0` coarsest, sparse —
   only tiles overlapping the region). Each zoom is a `WarpedVRT` aligned to the
   global tile grid, so tile `(z,x,y)` is an exact sample window with a 2-sample
   border for seam-free apron sampling.
2. The viewer's clipmap (`web/src/scene/TileField.tsx`) picks an LOD cell's world
   rect + voxel size and asks the worker pool to build it.
3. The worker (`web/src/voxelWorker.ts`) maps the cell to the matching pyramid
   zoom, fetches the covering tiles (cached), bilinear-samples one column per
   voxel, and `buildMesh.ts` emits seated cubes with a hypsometric ramp, a baked
   AO byte, and a slope-based skirt to seal LOD transitions.

Each module carries a header comment documenting its piece of the pipeline;
[`CLAUDE.md`](CLAUDE.md) maps the whole architecture file-by-file.

## Layout

```
tools/gen_pyramid/   DEM → Web-Mercator height-tile pyramid (Python)
web/                 voxel viewer (Vite + React + three.js)
```

## License

See [`LICENSE`](LICENSE).
