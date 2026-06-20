"""Offline correctness check (`python -m gen_pyramid --self-test`).

Synthesises a small EPSG:4326 DEM holding a known *linear* height field — which
bilinear/average warping reproduces exactly — builds a tiny two-zoom pyramid (no
network), and asserts: tile counts vs coverage, decoded height == the field,
adjacent-tile border agreement, and coarse ≈ average-of-children.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import rasterio
from rasterio.transform import from_bounds

from . import encode, mercator, tiles

# The known field: h(lon, lat) = H0 + A*lon + B*lat  (linear ⇒ warp-exact).
H0, A, B = 1000.0, 50.0, 30.0
TOL = 1.5  # metres (warp ≈ exact for a plane; ±0.5 m i16 quantisation + slack)


def _plane(lon, lat):
    return H0 + A * lon + B * lat


def _synth_dem(path: Path, bbox, size=512):
    min_lon, min_lat, max_lon, max_lat = bbox
    lons = np.linspace(min_lon, max_lon, size)
    lats = np.linspace(max_lat, min_lat, size)  # rows go north→south
    lon_g, lat_g = np.meshgrid(lons, lats)
    h = _plane(lon_g, lat_g).astype("float32")
    transform = from_bounds(min_lon, min_lat, max_lon, max_lat, size, size)
    profile = dict(driver="GTiff", height=size, width=size, count=1,
                   dtype="float32", crs="EPSG:4326", transform=transform)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(h, 1)


def _load(cfg, z, x, y):
    f = cfg.paths.pyramid_out / "tiles" / str(z) / str(x) / f"{y}.bin"
    pyr = cfg.pyramid
    _, arr = encode.decode_tile(f.read_bytes(), pyr.tile_samples, pyr.border, encode.BLK)
    return arr  # codes == metres (scale=1, offset=0)


def run() -> bool:
    region = SimpleNamespace(min_lon=70.0, min_lat=18.0, max_lon=78.0, max_lat=26.0)
    pyr = SimpleNamespace(min_zoom=7, max_zoom=8, tile_samples=64, border=2,
                          height_scale=1.0, height_offset=0.0, gzip=False)
    tmp = Path(tempfile.mkdtemp(prefix="genpyr_"))
    n, b = pyr.tile_samples, pyr.border
    ok = True
    try:
        # Source padded 1° beyond the region so every covered tile (incl. border)
        # samples real data, never the boundless fill.
        _synth_dem(tmp / "src.tif",
                   (region.min_lon - 1, region.min_lat - 1,
                    region.max_lon + 1, region.max_lat + 1))
        cfg = SimpleNamespace(region=region, pyramid=pyr,
                              paths=SimpleNamespace(pyramid_out=tmp / "pyramid"))
        stats = tiles.build(cfg, tmp / "src.tif")

        # 1) counts == sum of coverage ranges
        want = sum((c["xRange"][1] - c["xRange"][0] + 1) *
                   (c["yRange"][1] - c["yRange"][0] + 1)
                   for c in stats["coverage"].values())
        got = sum(1 for _ in (tmp / "pyramid" / "tiles").rglob("*.bin"))
        ok &= _say("counts", got == want, f"{got} files vs {want} expected")

        z = pyr.max_zoom
        x0, x1, y0, y1 = mercator.covered_tiles(region, z)
        xc, yc = (x0 + x1) // 2, (y0 + y1) // 2

        # 2) decoded height == the plane at a few interior samples
        arr = _load(cfg, z, xc, yc)
        err = 0.0
        for (i, j) in ((n // 4, n // 4), (n // 2, n // 2), (3 * n // 4, n // 3)):
            mx, my = mercator.sample_merc(z, n, xc, yc, i, j)
            lon, lat = mercator.merc_to_lonlat(mx, my)
            err = max(err, abs(arr[j + b, i + b] - _plane(lon, lat)))
        ok &= _say("height probe", err < TOL, f"max |Δ| = {err:.3f} m")

        # 3) border agreement: A's right border == B's left overlap
        a_arr, b_arr = _load(cfg, z, xc, yc), _load(cfg, z, xc + 1, yc)
        match = np.array_equal(a_arr[:, n + b:n + 2 * b], b_arr[:, b:2 * b])
        ok &= _say("border agreement", match, "shared columns identical")

        # 4) coarse ≈ average of its 4 children
        zc = pyr.min_zoom
        cx0, cx1, cy0, cy1 = mercator.covered_tiles(region, zc)
        cx, cy, ci, cj = (cx0 + cx1) // 2, (cy0 + cy1) // 2, n // 2, n // 2
        coarse = _load(cfg, zc, cx, cy)[cj + b, ci + b]
        cg_col, cg_row = cx * n + ci, cy * n + cj
        kids = []
        for dr in (0, 1):
            for dc in (0, 1):
                fc, fr = 2 * cg_col + dc, 2 * cg_row + dr
                fa = _load(cfg, zc + 1, fc // n, fr // n)
                kids.append(fa[fr % n + b, fc % n + b])
        davg = abs(coarse - float(np.mean(kids)))
        ok &= _say("pyramid consistency", davg < TOL, f"|coarse − mean(kids)| = {davg:.3f} m")

        print("SELF-TEST:", "PASS" if ok else "FAIL")
        return ok
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _say(name, passed, detail) -> bool:
    print(f"  [{'ok' if passed else 'XX'}] {name}: {detail}")
    return passed
