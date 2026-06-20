# Phase 1 — Raster-base terrain, streamed from a global tile pyramid

Status: **draft for refinement** (pre-POC). Owner: codetiger.

## 0. Goal

Roam the real India DEM as a varying-density voxel terrain in the existing
viewer, with height sourced **directly from a streamed heightmap tile pyramid** —
no contour vectorization, no analytic overlays. This is the thinnest vertical
slice that de-risks the raster-base architecture.

**Decision (locked for Phase 1):** the offline tool emits the **base minimum**
(height tiles only); the **frontend computes the renderable mesh in plain JS** (a
Web Worker). **No wasm, no Rust anywhere.** The later analytic-overlay phases
(rivers/water) will also be computed in JS.

It directly serves two of the three end goals (roam; varying density on camera
focus). The third (true terrain colour) is stubbed with a hypsometric ramp and
delivered for real in Phase 3.

### In scope
- Offline **Python** pyramid builder → global `(z,x,y)` **height** tiles + `manifest.json`.
- A **JS Web Worker** that fetches a height tile and builds the instance buffers
  (cull, AO, colour) the existing renderer already consumes.
- Placeholder **hypsometric colour** derived in JS from height.
- Reuse the instanced-cube renderer and quadtree LOD clipmap **unchanged**.

### Out of scope (later phases)
| Phase | Deferred |
|---|---|
| 2 | rivers carve / water fill / lakes (analytic overlays, in JS) |
| 3 | real colour from a satellite/landcover raster ("colour from the terrain") |
| 4 | procedural `detail` noise for finer-than-DEM zoom; material rules |
| later | LOD-transition skirt (frontend); COG/range serving; antimeridian/pole handling |

---

## 1. Architecture & data flow

```
ETOPO India GeoTIFF (cached by tools/gen_pyramid/fetch.py)
   │  [offline, Python]  warp→WebMercator · overviews(mip) · cut (z,x,y) tiles w/ border · i16
   ▼
web/public/pyramid/manifest.json
web/public/pyramid/tiles/{z}/{x}/{y}.bin     (static, lazy-fetched, CDN-cacheable; heights only)
   │  [JS Web Worker]  fetch tile (LRU cache) → decode i16 → window (cellCols+2B)² heights
   ▼  buildMesh(heights …) — all in TS:
   │     hcol (surface heights) → cull (exposed walls) → AO byte → hypsometric colour
   ▼
{ positions: Float32Array, colors: Uint32Array (0xAARRGGBB+AO), yScales: Float32Array }
   ▼
TileField quadtree LOD clipmap + instanced cubes + PostFx   ← UNCHANGED renderer
```

**No Rust/wasm in this path.** Python produces height tiles; JS turns them into
instances. The output triple (`positions` / `colors` / `yScales`) is exactly the
`VoxelMesh` shape the renderer eats today, so the renderer and the worker message
protocol are unchanged.

---

## 2. Coordinate space & projection

**Locked default: Web Mercator (EPSG:3857), global `(z,x,y)` quadtree, `z=0`
coarsest.** Chosen so future colour/imagery tiles drop in at the *same* `(z,x,y)`
(the imagery-tile ecosystem is Web Mercator XYZ). The manifest declares
`projection`, so plate carrée stays a swap under a fixed integer-index contract.

This replaces the current field-unit world space with a metric one:

- **World X/Z** = Web Mercator metres **minus a region origin** `originMerc`
  (manifest), so coordinates stay small (India ≈ a few hundred km, not
  ±20 037 508 m) and well within `f32`/`f64` precision in the viewer.
- **World Y** = elevation metres × `verticalExaggeration` (manifest; `1.0` for Phase 1).
- **Sea level** = `y = 0`.

Web Mercator constant: `E = 20037508.342789244` m (half-equator). Valid latitude
±85.05° — irrelevant for India or terrain generally.

---

## 3. Tile addressing

Standard slippy-map quadtree, integer keys, **sparse global population** (host
only tiles where data exists; a 404 / manifest range = empty). India occupies a
sub-range; world-scale later = emit more `(z,x,y)` under the same index, zero
re-indexing. Parent of `(z,x,y)` is `(z-1, x>>1, y>>1)`.

```
S_z        = 2E / 2^z                      # tile world span (m) at zoom z
merc_x0    = -E + x * S_z                   # tile west edge
merc_y1    =  E - y * S_z                   # tile north edge (y increases south)
spacing(z) = S_z / N                        # metres per height sample at zoom z
```

**Level selection (viewer).** The clipmap picks a render LOD from camera
distance; map it to an absolute zoom so one height sample ≈ one voxel column:

```
z            = round( log2( 2E / (N * voxelSize) ) )   # clamp to [minZoom, maxZoom]
voxelSize(z) = spacing(z) = 2E / (2^z * N)
```

`maxZoom` is bounded by the source DEM resolution (ETOPO 15″ ≈ 460 m). Finer cells
than `maxZoom` sample the deepest tile and bilinear-upsample (smooth; Phase 4 adds
noise).

**Fetch vs render granularity are decoupled** (deliberately):
- **Pyramid tile** = `N=256` samples/edge → big, few HTTP requests, CDN-friendly.
- **Render cell** = `cellCols=8` columns/edge (existing `mapTheme.view.cellCols`)
  → small, streams to the GPU fast.

One pyramid tile feeds up to `(N/cellCols)² = 32² = 1024` render cells. The worker
caches tiles and windows out each render cell's `(cellCols + 2B)²` height
sub-block. A render cell at zoom `z`, indices `(cx, cz)`, lives in pyramid tile
`(z, cx / (N/cellCols), cz / (N/cellCols))`.

---

## 4. Tile & manifest formats

### Tile file `tiles/{z}/{x}/{y}.bin` — **heights only**
Fixed `(N + 2B)²` `i16` height samples (row-major, north-to-south), with a `B`-
sample overlap border so each tile is self-sufficient for the cull + AO
neighbourhood. **Nothing else is stored** — colour is derived and AO/culling are
computed in JS.

```
offset  bytes  field
0       4      magic   "VKH1"
4       1      version (=1)
5       1      reserved (0)
6       1      z
7       1      reserved
8       4      x        (u32 LE)
12      4      y        (u32 LE)
16      2      n        (u16 LE, interior samples/edge = 256)
18      2      border   (u16 LE, = 2)
20      …      (N+2B)² × i16 LE height codes
```
Decode (metres): `elev = code * heightScale + heightOffset` (manifest globals).
`nodata` code → ocean floor / sentinel. `i16 @ scale=1 m` spans ±32 767 m (Everest
8 849, Mariana −10 935). Optional `gzip` transfer.

### `manifest.json`
```jsonc
{
  "version": 1,
  "projection": "webmercator",      // | "platecarree"
  "tileSamples": 256,               // N
  "border": 2,                      // B  (>= AO radius; covers cull's 1-neighbour need)
  "heightScale": 1.0,               // metres per i16 code
  "heightOffset": 0.0,
  "nodata": -32768,
  "minZoom": 5,
  "maxZoom": 11,                    // bounded by ETOPO ~460 m
  "originMerc": [7200000.0, 800000.0],   // subtract from merc X/Z → small world coords
  "verticalExaggeration": 1.0,
  "heightRange": [-200.0, 8900.0], // for camera bounds + the hypsometric ramp
  "coverage": { "11": { "xRange": [1490, 1620], "yRange": [880, 1010] } /* …per zoom */ },
  "tileUrl": "tiles/{z}/{x}/{y}.bin"
}
```

---

## 5. Offline pyramid builder (pure Python)

`tools/gen_pyramid/` (`fetch.py` + `rasterio`/GDAL). With the heavy work moved to
the frontend, this tool only produces **height tiles** — no Rust, no baking:

1. **Fetch + cache** the ETOPO bbox (`fetch.py`), then read it.
2. **Warp** to EPSG:3857 (`rasterio.warp.reproject`, `Resampling.bilinear`).
3. **Build overviews** = the mip pyramid (`average`) for `minZoom..maxZoom`.
4. Per zoom `z`, per covered `(x,y)`: windowed-read the `(N+2B)²` block (interior
   + border overlap), encode `i16`, write `tiles/{z}/{x}/{y}.bin`.
5. Emit `manifest.json` (`coverage` = populated `(x,y)` ranges per zoom).
6. Write under `web/public/pyramid/` (served statically by Vite / a CDN).

CLI: `python -m gen_pyramid` (config: bbox, `N`, `B`, `minZoom`, `maxZoom`,
`heightScale`).

**Acceptance:** tile counts match `coverage`; 20 random `(lon,lat)` probes decode
to ETOPO elevation within bilinear+quantization tolerance; neighbour border rows
agree.

---

## 6. Frontend voxelization (the JS port)

The substantial new work: a TS port of `voxel.rs`'s emit/cull/AO/colour, operating
on a height array instead of the analytic surface. Lives in `web/src/voxel/` and
runs **inside the Web Worker** (off the render thread).

### 6.1 `heightTile.ts`
Decode + sample.
```ts
class HeightTile {
  samples: Float32Array;  // (n+2B)^2, metres
  n: number; border: number;
  minX: number; minZ: number;  // interior AABB (origin-offset merc)
  spacing: number;             // metres per sample
  sample(x: number, z: number): number;   // bilinear; reads into the border
}
```

### 6.2 `buildMesh.ts` — the per-cell builder
Input: the cell's `(cellCols+2B)²` height sub-block + `voxelSize`. Output: the
three transferable typed arrays. All integer/float loops over preallocated typed
arrays — **no per-voxel objects** (the one perf footgun; the math itself is light,
~low thousands of ops per 8×8 cell).

Steps (faithful to the current engine):
1. **`hcol`** — surface height per column (direct copy at matching zoom; bilinear
   when upsampling below `maxZoom`).
2. **Cull (exposed set)** — per interior column emit only what's visible: the
   **surface voxel Y-scaled so its top face sits on the exact height** (LOD-stable,
   crack-free), plus the **wall voxels covering the drop to its lowest 4-neighbour**.
   Hidden interior voxels are never emitted. (Walls may be one Y-stretched instance
   per exposed side to keep instance counts low.)
3. **AO (per-voxel byte — default)** — openness from the local height
   neighbourhood; the `B`-sample border makes it continuous across same-LOD tile
   seams. Packed into the colour's **top byte** (`0xAARRGGBB`), exactly where the
   renderer reads it today → **no shader change**. *(Crisp per-face contact AO
   remains a later option; it needs a small custom shader and is not in Phase 1.)*
4. **Colour** — `hypsometric(height)` via a ramp LUT → sRGB in the low 24 bits.
   Derived, not stored (Phase 3 adds a stored colour byte for imagery).
5. **Emit** — write `positions` (`count*3` f32), `colors` (`count` u32), `yScales`
   (`count` f32).

### 6.3 Correctness strategy
Port from scratch, so test it directly:
- A **brute-force reference** in TS (emit *all* solid voxels, then cull by checking
  each of 6 neighbours empty; naïve AO) — the optimized `buildMesh` must match it
  voxel-for-voxel on random height fields.
- **Golden fixtures**: a flat plane, a single step, a pyramid, a pit — exposed set,
  `yScales`, and AO hand-derivable.
- **Seam test**: two adjacent cells share identical edge geometry/AO via the border.

**Acceptance:** `buildMesh` matches the brute-force reference on 100 random tiles;
fixtures pass; seam test passes.

---

## 7. Frontend wiring (`web/src/`)

### 7.1 Manifest + addressing (`scene/TileField.tsx`, `terrain.ts`)
- Load `manifest.json` at startup; derive `worldBounds`, `heightRange`,
  `minZoom/maxZoom`, `originMerc` from it (replace the old wasm `worldBounds()` /
  `heightRange()` calls).
- Map each render cell → absolute zoom `z` (§3) and `(z,x,y)` tile + sub-window.
  Keep the existing split/merge and atomic parent→children swap **unchanged**.

### 7.2 Worker (`voxelWorker.ts` rewrite)
- `load` payload = the manifest (not a `.vkc` URL); drop the wasm import.
- Per tile request: resolve `(z,x,y)`; **fetch** (LRU cache keyed by `z/x/y`,
  decode `i16→f32` once); window the `(cellCols+2B)²` sub-block; `buildMesh(...)`;
  transfer the typed arrays back (unchanged `tile` message shape).
- LRU cap sized so resident decoded tiles stay within a few MB.

### 7.3 Camera follow
Decode the coarse `minZoom` tile(s) once on the main thread (always resident);
bilinear-sample for ground height under the camera each frame (replaces the wasm
`heightAt`).

**Unchanged / reused:** `Stage`, `PostFx`, `LightingRig`, `Skydome`,
`RoamControls`, `curvature`, the instanced-cube mesh, the `VoxelMesh` triple and
the worker message protocol.

### 7.4 LOD-transition skirt — deferred (frontend, later)
Inherently a *runtime* concern: the drape depth depends on the neighbour tile's
LOD, unknown at bake time, so it can't live in the tile. Within a single LOD level
borders are already seamless (shared apron); cracks appear **only at LOD
transitions** until the skirt lands — acceptable for the POC.

---

## 8. Milestones (each independently testable)

| # | Deliverable | Done when |
|---|---|---|
| 0 | Decisions locked (§12) | this doc approved |
| 1 | `tools/gen_pyramid` → height tiles + manifest for India | counts match coverage; 20 probes within tolerance; borders agree |
| 2 | `web/src/voxel/` — `heightTile.ts` + `buildMesh.ts` (cull/AO/colour) | matches brute-force reference on 100 tiles; fixtures + seam test pass |
| 3 | Wiring: manifest, `(z,x,y)` map, worker fetch/cache, camera height | India loads and roams from tiles end-to-end |
| 4 | Validation pass | success criteria (§9) met |

---

## 9. Success criteria

- Roam the full India extent at interactive FPS; LOD visibly refines toward the
  look-at point (reuses the clipmap — near-free).
- Within-level tiles are seamless; LOD-transition cracks are the only seams (skirt
  deferred, §7.4).
- Sampled heights match the source ETOPO within bilinear tolerance (≈20 probes).
- **Bounded memory:** resident decoded tiles < a few MB regardless of roam distance.
- Coarse-first streaming hides fetch latency (parent visible until children load —
  already in `TileField`).
- **Fidelity check:** a mountain direct-from-DEM is visibly sharper than the old
  247 K-line contour-ring scene, side by side.
- Per-tile `buildMesh` stays comfortably sub-frame in the worker; no render-thread
  hitching while roaming.
- Zero contour vectorization, and zero Rust/wasm, anywhere in the Phase 1 path.

---

## 10. Risks the POC must answer

1. **JS port correctness** — the cull/AO must match the brute-force reference;
   subtle off-by-ones in the exposed set or AO neighbourhood are the main hazard
   (mitigated by §6.3).
2. **Upsample look** below `maxZoom` — is bilinear acceptable before Phase-4 noise?
3. **Fetch/decode + buildMesh throughput** vs roam speed; tune `N`, cache size, and
   worker count. Watch GC (typed arrays only).
4. **Border/alignment off-by-ones** between pyramid tiles, render cells, and the
   `B`-sample neighbourhood (the `B ≥ AO radius` invariant).
5. **LOD-transition seams** visible until the skirt lands — confirm they're
   tolerable for the POC.
6. **`f32` precision** of origin-offset Web Mercator coords at India extent.

---

## 11. Effort sketch (rough)
- `gen_pyramid` (Python: warp + overviews + tiling): ~1 day.
- `heightTile.ts` + `buildMesh.ts` + reference/fixtures (TS): ~2–2.5 days (the
  from-scratch cull/AO port is the bulk).
- Wiring (manifest, mapping, worker cache, camera): ~1.5 days.
- Validation/tuning: ~1 day.

---

## 12. Open / locked decisions
- **Projection:** Web Mercator *(locked default)* vs plate carrée (manifest-swappable).
- **Compute location:** frontend JS Web Worker *(locked)* — no wasm, no Rust on path.
- **Tile payload:** heights only *(locked)*; colour derived, AO/cull computed in JS.
- **AO:** per-voxel byte in the colour alpha, no shader change *(locked default)*;
  per-face contact AO is a later, shader-based option.
- **DEM source:** reuse cached ETOPO 15″ (~460 m) *(lean)* vs pull a finer SRTM patch.
- `N=256`, `B=2`, `i16 @ scale=1 m`, static tiles, `verticalExaggeration=1.0` *(lean)*.
