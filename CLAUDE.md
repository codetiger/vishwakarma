# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`vishwakarma` is a browser **voxel terrain viewer**. An offline Python tool turns
a DEM into a global **Web-Mercator height-tile pyramid**; the web viewer streams
those tiles and voxelizes them in a JS Web Worker, with distance-based LOD as you
roam. There is **no Rust/wasm** — the whole runtime is Python (offline tiling) +
TypeScript (browser). Design rationale: `docs/phase1-raster-base.md`.

## Commands

```bash
# Build the height-tile pyramid (fetches the ETOPO bbox once, then cached):
cd tools && python -m gen_pyramid                 # → web/public/pyramid/
cd tools && python -m gen_pyramid --max-zoom 7    # override a knob
cd tools && python -m gen_pyramid --self-test     # offline correctness check (no network)

# Run the viewer:
cd web && npm install && npm run dev              # http://localhost:5173
```

## Architecture — two parts

**1. `tools/gen_pyramid/` (Python, offline).** DEM → tiles.
- `fetch.py` downloads/caches the ETOPO bbox; `config.py`/`config.toml` hold the
  region, DEM source, and pyramid knobs.
- `mercator.py` is the EPSG:3857 tile math; `tiles.py` builds each zoom as a
  `WarpedVRT` aligned to the global tile grid and window-reads each tile;
  `encode.py` packs the `i16` tile bytes; `manifest.py` writes `manifest.json`.
- **Tiles are heights only** — `(N+2B)²` `i16` samples + a 20-byte header. Colour,
  AO, culling, and the LOD skirt are all derived in the browser, so the format
  stays tiny and resolution-independent. `verify.py` (`--self-test`) checks the
  pipeline on a synthetic DEM with no network.

**2. `web/` (Vite + React-Three-Fiber).** Tiles → voxels → screen.
- `src/voxel/proj.ts` — projection + **world-scale**. Mercator metres are mapped
  to world units: `WORLD_SCALE_XZ` (≈ 0.1°/unit horizontally, so the theme's
  camera/LOD distances are reused as-is) and `WORLD_SCALE_Y` (vertical
  exaggeration). `voxelToZoom` maps a cell's voxel size to a pyramid zoom.
- `src/voxel/heightTile.ts` — decode (mirrors `encode.py`), fetch/cache, and a
  bilinear sampler addressed on the global Mercator grid (reads each sample from
  its home tile, so it crosses tile boundaries transparently).
- `src/voxel/buildMesh.ts` — the per-cell voxelizer: one box per column seated on
  the exact height with a wall to the lowest neighbour, a hypsometric colour ramp,
  a baked AO byte (openness from the height ring), and a perimeter LOD skirt.
- `src/voxelWorker.ts` — loads the manifest, then per request fetches the covering
  tiles and calls `buildMesh`. `src/terrain.ts` is the main-thread coarse sampler
  (camera follow). `src/scene/TileField.tsx` is the quadtree LOD clipmap (mostly
  source-agnostic — driven by `bounds` + `voxelSize`).

## Conventions

- **Keep the two decoders in sync.** The tile byte layout is defined in
  `tools/gen_pyramid/encode.py` and decoded in `web/src/voxel/heightTile.ts` —
  change both together.
- **Tiles stay heights-only.** Anything that can be derived per-voxel (colour, AO,
  cull, skirt) lives in `buildMesh.ts`, not in the tile.
- **Generated artifacts are git-ignored:** `web/public/pyramid/` (rebuild with
  `python -m gen_pyramid`), `tools/**/_cache/` (the DEM download), `node_modules`.
- **Screenshots:** the viewer streams tiles asynchronously, so headless
  `--virtual-time-budget` captures fire before tiles load. Use a real wait (drive
  Chrome via the DevTools Protocol and `setTimeout`) to capture a true frame.
- **Coordinate sanity:** world bounds, voxel sizes, and the slider range are all
  derived from the manifest's zoom range + `WORLD_SCALE_*`; don't hardcode them.
