# gen_pyramid — Web-Mercator height-tile pyramid

Offline tool that turns the ETOPO 2022 DEM into a streamable **height-tile
pyramid** for the voxel web viewer. The viewer's JS workers fetch tiles and
build voxels themselves — there is **no Rust/wasm on the web path**.

## Run

```bash
cd tools
pip install -r gen_pyramid/requirements.txt
python -m gen_pyramid                 # full build per config.toml → web/public/pyramid/
python -m gen_pyramid --max-zoom 7    # override a knob for a lighter run
python -m gen_pyramid --self-test     # offline correctness check (no network)
```

First run fetches the configured ETOPO bbox (15″ tiles via `/vsicurl`, mosaicked +
resampled) into `gen_pyramid/_cache/` (git-ignored); later runs are offline.
Output: `web/public/pyramid/manifest.json` + `tiles/{z}/{x}/{y}.bin`, served by
Vite at `./pyramid/...`.

## What it builds

A global slippy-map quadtree (`z=0` coarsest, **sparse** — only tiles overlapping
the region are written). Each zoom is a `WarpedVRT` aligned to the global tile
grid, so tile `(z,x,y)` is exactly the sample window `[x·N, x·N+N)` and the
`B`-sample border overlaps neighbours by construction.

| Knob (`config.toml`) | Meaning |
|---|---|
| `[region]` | DEM bounding box (lon/lat) |
| `[dem]` | ETOPO source (`resolution`, urls, `target_arcsec`) |
| `min_zoom` / `max_zoom` | zoom range; `res(z) = 156543.03 / 2^z` m/sample |
| `tile_samples` (N) | interior height samples per tile edge (256) |
| `border` (B) | overlap ring, ≥ AO radius (2) |
| `height_scale` / `height_offset` | `elev_m = code·scale + offset` (i16) |
| `gzip` | pre-gzip tiles, else raw `.bin` (+ serve-layer gzip) |

## Tile format (`tiles/{z}/{x}/{y}.bin`)

20-byte header (`"VKH1"`, version, z, x, y, n, border) + `(N+2B)²` little-endian
`i16` height codes, row-major north→south. See `encode.py`. Heights only —
colour and AO/culling are derived in the JS worker.

## Layout

```
config.py     load config.toml + resolve paths
fetch.py      download/cache the ETOPO bbox (15″ mosaic or 30″/60″ window)
mercator.py   EPSG:3857 tile math (lon/lat ↔ merc, zoom ↔ resolution, coverage)
encode.py     i16 tile header + pack/unpack
tiles.py      per-zoom WarpedVRT → grid-aligned window reads → write tiles
manifest.py   assemble + write manifest.json
verify.py     offline self-test on a synthetic linear DEM
__main__.py   orchestrate
```
