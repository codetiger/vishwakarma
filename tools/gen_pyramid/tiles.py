"""Build the Web-Mercator height-tile pyramid from a source DEM.

Each zoom is a WarpedVRT aligned to the *global* tile grid, so tile (z,x,y) is
exactly the sample window [x*N, x*N+N) × [y*N, y*N+N); the B-sample border is a
larger window into the same grid, so neighbour borders agree by construction.
The VRT is virtual — GDAL warps only the window each tile reads.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio import Affine
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window

from . import encode, mercator


def _read_padded(vrt, col_off: int, row_off: int, side: int, dim: int):
    """Read a `side`×`side` window, clipping to [0, dim) and zero-padding the rest.

    WarpedVRT forbids boundless reads; India tiles are always interior so this
    only pads the apron of true global-edge tiles (deferred world-scale case).
    """
    out = np.zeros((side, side), dtype="float32")
    c0, r0 = max(col_off, 0), max(row_off, 0)
    c1, r1 = min(col_off + side, dim), min(row_off + side, dim)
    if c1 > c0 and r1 > r0:
        block = vrt.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
        out[r0 - row_off:r1 - row_off, c0 - col_off:c1 - col_off] = block
    return out


def build(cfg, src_path: Path) -> dict:
    pyr = cfg.pyramid
    n, b = pyr.tile_samples, pyr.border
    out_root = cfg.paths.pyramid_out
    ext = ".bin.gz" if pyr.gzip else ".bin"

    coverage: dict[str, dict] = {}
    gmin, gmax = math.inf, -math.inf
    total_bytes = 0

    with rasterio.open(src_path) as src:
        for z in range(pyr.min_zoom, pyr.max_zoom + 1):
            p = mercator.resolution(z, n)
            dim = (2 ** z) * n  # virtual global raster side at this zoom
            transform = Affine(p, 0.0, -mercator.E, 0.0, -p, mercator.E)
            resampling = Resampling.bilinear if z == pyr.max_zoom else Resampling.average
            x0, x1, y0, y1 = mercator.covered_tiles(cfg.region, z)

            count, zbytes = 0, 0
            with WarpedVRT(src, crs="EPSG:3857", transform=transform,
                           width=dim, height=dim, resampling=resampling) as vrt:
                for y in range(y0, y1 + 1):
                    for x in range(x0, x1 + 1):
                        data = _read_padded(vrt, x * n - b, y * n - b, n + 2 * b, dim)
                        gmin = min(gmin, float(data.min()))
                        gmax = max(gmax, float(data.max()))
                        blob = encode.encode_tile(
                            data, n, b,
                            pyr.height_scale, pyr.height_offset, gzip=pyr.gzip,
                        )
                        tdir = out_root / "tiles" / str(z) / str(x)
                        tdir.mkdir(parents=True, exist_ok=True)
                        (tdir / f"{y}{ext}").write_bytes(blob)
                        count += 1
                        zbytes += len(blob)

            coverage[str(z)] = {"xRange": [x0, x1], "yRange": [y0, y1]}
            total_bytes += zbytes
            print(f"  z{z}: {count} tiles · res {p:7.1f} m/sample · {zbytes / 1e6:6.1f} MB")

    return {
        "coverage": coverage,
        "heightRange": [round(gmin, 2), round(gmax, 2)],
        "totalBytes": total_bytes,
    }
