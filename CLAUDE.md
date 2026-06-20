# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`vishwakarma` is a browser **voxel terrain viewer**. An offline Python tool turns
a DEM into a global **Web-Mercator height-tile pyramid**; the web viewer streams
those tiles and voxelizes them in a pool of JS Web Workers, with distance-based
LOD as you roam — rendered with a round-world horizon, radial fog, screen-space
AO, and bloom. There is **no Rust/wasm** — the whole runtime is Python (offline
tiling) + TypeScript (browser). Each module carries a header comment documenting
its piece of the pipeline.

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
  `encode.py` bit-packs the tile bytes; `manifest.py` writes `manifest.json`.
- **Tiles are heights only** and **headerless** — a tile file is just a `BLK×BLK`
  (16×16) per-block table + packed payload: `(N+2B)²` height codes where each block
  carries its own `base` + minimal `bits` width (constant blocks → `bits=0`, no
  payload). Local per-block ranges pack far tighter than a single per-tile width.
  All geometry (`tileSamples`, `border`, `blockSize`) + format `version` live in
  `manifest.json`, not per tile; `z/x/y` are the URL path. Colour,
  AO, culling, and the LOD skirt are all derived in the browser, so the format
  stays tiny and resolution-independent. `verify.py` (`--self-test`) checks the
  pipeline on a synthetic DEM with no network.

**2. `web/` (Vite + React-Three-Fiber).** Tiles → voxels → screen.

*Voxel core (pure TS, no DOM/THREE — runs in the worker and main thread alike):*
- `src/voxel/proj.ts` — projection + **world-scale**. Mercator metres are mapped
  to world units: `WORLD_SCALE_XZ` (≈ 0.1°/unit horizontally, so the theme's
  camera/LOD distances are reused as-is) and `WORLD_SCALE_Y` (vertical
  exaggeration). `voxelToZoom` maps a cell's voxel size to a pyramid zoom.
- `src/voxel/heightTile.ts` — decode (mirrors `encode.py`), fetch/cache, and a
  bilinear sampler addressed on the global Mercator grid (reads each sample from
  its home tile, so it crosses tile boundaries transparently).
- `src/voxel/buildMesh.ts` — `buildCell`, the per-cell voxelizer: one box per
  column seated on the exact height with a wall to the lowest neighbour, a
  hypsometric colour ramp, a baked AO byte (openness from the height ring), and a
  perimeter LOD skirt.

*Workers + main-thread sampler:*
- `src/voxelWorker.ts` — loads the manifest, then per request fetches the covering
  tiles (+ an apron ring) and calls `buildCell`. `src/App.tsx` spawns a **pool** of
  these (one per spare core, capped at 4) so dense near-camera cells voxelize in
  parallel; it also owns the manifest load, the voxel-size slider (debounced,
  re-streams on release), and the spawn point. `src/voxelTypes.ts` is the
  request/result message protocol.
- `src/terrain.ts` — main-thread coarse sampler: preloads the `minZoom` tiles and
  answers `terrainHeight(x,z)` cheaply every frame to lock the camera to the
  surface beneath it.

*Scene + rendering (React-Three-Fiber):*
- `src/scene/Stage.tsx` — owns the `<Canvas>`; composes Skydome, LightingRig,
  RoamControls, TileField, PostFx.
- `src/scene/TileField.tsx` — the quadtree LOD clipmap (source-agnostic — driven
  by `bounds` + `voxelSize`): a coarse base covers the whole area; cells split into
  four finer children toward the camera, and a parent stays visible until all its
  children load, then they swap in atomically (never a coarse flash). One
  `InstancedMesh` per cell.
- `src/scene/RoamControls.tsx` — Google-Earth-style oblique roam: the eye flies at
  a fixed altitude above the terrain (drag/WASD pan, shift-drag/Q-E turn, wheel
  zoom), publishing the eye as the shared LOD/fog centre.
- `src/scene/curvature.ts` — the **round-world** shader: bends every ground vertex
  down by squared distance from a moving centre, plus radial fog, injected into the
  terrain material via `onBeforeCompile`. All ground materials share its uniforms.
- `src/scene/PostFx.tsx` — N8AO (screen-space AO sized to the voxel) + Bloom +
  ACES tone-mapping + SMAA + Vignette. `Skydome.tsx` / `LightingRig.tsx` are the
  gradient backdrop + lights.
- `src/mapTheme.ts` — the **single art-direction surface**: palette, lighting,
  post FX, curvature, and the `view` block (camera height/pitch, fog, LOD radius,
  `baseVoxel`, `cellCols`). Tune the whole look + framing here; the scene-graph
  modules read from it.

## Conventions

- **Keep the two decoders in sync.** The tile byte layout is defined in
  `tools/gen_pyramid/encode.py` and decoded in `web/src/voxel/heightTile.ts` —
  change both together.
- **Tiles stay heights-only.** Anything that can be derived per-voxel (colour, AO,
  cull, skirt) lives in `buildMesh.ts`, not in the tile.
- **`mapTheme.ts` is the only place to tune the look + framing.** Palette,
  lighting, post FX, curvature, camera, fog, and LOD radius all live there — don't
  scatter those constants into the scene modules.
- **Every ground material must share the curvature shader** (`applyWorldCurvature`
  + the shared `curveUniforms`), or it detaches from the curved terrain.
- **`colorBlendRadius` / the message's `blendRadius` are plumbed but unused** —
  `buildCell` currently colours each voxel from the exact hypsometric ramp with no
  neighbour cross-fade. Wire it through `buildMesh.ts` if you implement the blend.
- **Generated artifacts are git-ignored:** `web/public/pyramid/` (rebuild with
  `python -m gen_pyramid`), `tools/**/_cache/` (the DEM download), `node_modules`.
- **Screenshots:** the viewer streams tiles asynchronously, so headless
  `--virtual-time-budget` captures fire before tiles load. Use a real wait (drive
  Chrome via the DevTools Protocol and `setTimeout`) to capture a true frame.
- **Coordinate sanity:** world bounds, voxel sizes, and the slider range are all
  derived from the manifest's zoom range + `WORLD_SCALE_*`; don't hardcode them.
