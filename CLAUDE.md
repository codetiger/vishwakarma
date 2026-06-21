# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`vishwakarma` is a browser **voxel terrain viewer**. An offline Python tool turns
a DEM into a global **Web-Mercator height-tile pyramid**; the web viewer streams
those tiles and voxelizes them in a pool of JS Web Workers, with distance-based
LOD as you roam. The flat-mercator voxels are projected onto a **3D globe** in the
vertex shader and explored with a Google-Earth-style orbit camera — zoom from
surface detail out to the whole earth in a starfield, rendered with screen-space
AO and bloom. There is **no Rust/wasm** — the whole runtime is Python (offline
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
- `src/scene/RoamControls.tsx` — the **geospatial orbit camera** (Google-Earth
  style): the camera orbits a FOCUS point on the globe at a wheel-driven distance +
  heading + an adjustable **tilt** (`userPitch`; π/2 = top-down/nadir, → 0 = horizon).
  Left-drag is a **rigid globe rotation** (sphere-raycast, the grabbed point tracks
  the cursor) that carries `heading` along, so dragging over a pole stays continuous
  (no gimbal); a drag that **starts off the globe does nothing** (pointerdown
  hit-guard). **Middle-drag** changes orientation: horizontal = heading, vertical =
  tilt (drag down → near-horizon "from the ground plane" view). Wheel zooms toward
  the cursor with no region cap; as you zoom out the effective pitch **straightens to
  nadir** (`straightenNearR`/`straightenFarR`) so the eye rises radially over the
  area (top-down, area centred) — it always looks at the focus, no swing to the globe
  centre. Right-drag rotates heading only; WASD pans, Q/E turn; the compass resets
  both heading and tilt. Publishes the flat focus (LOD centre), plus
  `surfaceAltitude` + `heading` to `cameraControls`.
- `src/scene/globe.ts` — the **single source of truth** for the flat-mercator↔
  sphere mapping (`GLOBE_R`, `flatToECEF`, `ecefToFlat`, `enuBasis`,
  `worldToLonLat`, `lonLatToWorld`, `visibleCapBounds`, `selfTest`). The GPU shader
  and the CPU camera both use it, so eye and ground land in the same ECEF space —
  keep the shader's GLSL in sync with it (like the two tile decoders).
  `visibleCapBounds` gives the flat-Mercator bbox of the visible spherical cap (the
  clipmap's root-scan window — Mercator-correct so coverage holds near the poles).
- `src/scene/curvature.ts` — the **sphere-projection** vertex shader (mirrors
  `globe.ts`): maps each flat ground vertex onto the globe (flat X/Z → lon/lat →
  sphere direction; height → radial axis), injected via `onBeforeCompile`. Every
  ground material shares its uniforms (`uHeightScale`). (`applyWorldCurvature` keeps
  its name for the call site.)
- `src/scene/cameraControls.ts` — the shared imperative bridge between the on-screen
  UI and RoamControls (live `heading`/`surfaceAltitude`; `zoomBy`/`resetNorth`
  intents), mirroring the `curveUniforms` shared-singleton idiom.
- `src/scene/PolarCaps.tsx` — two ice-cap meshes (in ECEF, not through the
  projection shader) that fill the polar gaps left by Mercator's ±85° limit.
- `src/scene/PostFx.tsx` — N8AO (screen-space AO sized to the voxel) + Bloom +
  ACES tone-mapping + SMAA + Vignette. `Skydome.tsx` sets the **world-fixed
  equirectangular sky map** (ESO/S. Brunier panorama, CC BY 3.0, in
  `public/textures/`) as `scene.background` — fixed in world space so it stays
  synced with the globe, no mesh/camera-follow. `LightingRig.tsx` is the lights.
  Sky brightness + tilt are `mapTheme.space`; `palette.skyTop` is the load fallback.
- `src/mapTheme.ts` — the **single art-direction surface**: palette, lighting,
  post FX, the `space` block (sky-map brightness + tilt), and the `view` block
  (camera pitch, orbit-distance range, LOD, `baseVoxel`, `cellCols`). Tune the whole
  look + framing here; the scene-graph
  modules read from it.
- On-screen nav UI (zoom +/− + compass) lives in `src/App.tsx` (styled in
  `src/styles.css`), wired to `cameraControls`.

## Conventions

- **Keep the two decoders in sync.** The tile byte layout is defined in
  `tools/gen_pyramid/encode.py` and decoded in `web/src/voxel/heightTile.ts` —
  change both together.
- **Keep the globe mapping in sync.** The flat↔sphere math lives in
  `web/src/scene/globe.ts`; the GLSL in `curvature.ts` mirrors `flatToECEF` and the
  camera in `RoamControls.tsx` uses the TS helpers. Change them together (run
  `globe.ts`'s `selfTest`), or the eye and the rendered ground drift apart.
- **Tiles stay heights-only.** Anything that can be derived per-voxel (colour, AO,
  cull, skirt) lives in `buildMesh.ts`, not in the tile. The flat clipmap, worker,
  and voxelizer all stay FLAT — only the GPU shader + the camera know about the sphere.
- **Longitude wraps, latitude doesn't.** The antimeridian is seamless: the tile
  sampler (`heightTile.ts`), `ensureCover`, and the clipmap (`TileField.tsx` off-map
  test) all wrap X modulo the global grid, and the shader's lon is periodic. Latitude
  is bounded — the polar gap is filled by `PolarCaps.tsx` and the camera focus is
  clamped a few degrees short of the pole (`RoamControls.tsx`) to dodge the singularity.
- **`mapTheme.ts` is the only place to tune the look + framing.** Palette,
  lighting, post FX, camera pitch, orbit-distance range, and LOD all live there —
  don't scatter those constants into the scene modules.
- **Every ground material must run the sphere projection** (`applyWorldCurvature`
  + the shared `curveUniforms`), or it detaches from the globe.
- **No per-voxel colour cross-fade.** `buildCell` colours each voxel from the exact
  hypsometric ramp. If you implement a neighbour blend, thread a `blendRadius`
  through the worker message (`voxelTypes.ts`) and a theme knob in `mapTheme.ts`.
- **Generated artifacts are git-ignored:** `web/public/pyramid/` (rebuild with
  `python -m gen_pyramid`), `tools/**/_cache/` (the DEM download), `node_modules`.
- **Screenshots:** the viewer streams tiles asynchronously, so headless
  `--virtual-time-budget` captures fire before tiles load. Use a real wait (drive
  Chrome via the DevTools Protocol and `setTimeout`) to capture a true frame.
- **Coordinate sanity:** world bounds, voxel sizes, and the slider range are all
  derived from the manifest's zoom range + `WORLD_SCALE_*`; don't hardcode them.
