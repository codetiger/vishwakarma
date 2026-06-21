"""Build the Web-Mercator height-tile pyramid from a source DEM, bottom-up.

The FINEST zoom is warped from the source: tile (zmax,x,y) is exactly the sample
window [x*N, x*N+N) × [y*N, y*N+N) on the global grid (+ a B-sample border), read
through a WarpedVRT — small per-tile reads near native resolution.

Every COARSER zoom is built by 2×2-averaging the four finer tiles already on disk
(plus the neighbour slivers its border needs), never re-reading the source. This
is ~1.3× a single finest pass instead of re-warping the whole world once per zoom,
and it sidesteps the pathological coarse-warp reads entirely. Adjacent tiles' shared
samples agree because both derive from the same finer grid.

A WarpedVRT is not fork-safe to share, so finest-zoom workers each open their own
source + VRT via the pool initializer; coarse workers just read tile files. The
serial path (jobs<=1, used by --self-test) mirrors both in-process.
"""

from __future__ import annotations

import math
import multiprocessing as mp
import os
from pathlib import Path

import numpy as np
import rasterio
from rasterio import Affine
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window

from . import encode, mercator


def _open_safety():
    """Warping the VRT mosaic opens many underlying cell TIFFs on demand. Bound
    GDAL's open-dataset pool and lift this process's soft file-handle limit so a
    fanned-out tiler over hundreds of cells can't hit EMFILE."""
    os.environ.setdefault("GDAL_MAX_DATASET_POOL_SIZE", "100")
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = 4096 if hard in (resource.RLIM_INFINITY, -1) else min(4096, hard)
        if soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except Exception:  # noqa: BLE001 - best effort; not all platforms expose it
        pass


def _write_tile(out_root, z, x, y, ext, blob):
    tdir = out_root / "tiles" / str(z) / str(x)
    tdir.mkdir(parents=True, exist_ok=True)  # race-safe across processes (exist_ok)
    (tdir / f"{y}{ext}").write_bytes(blob)


# --- finest zoom: warp from the source DEM ---------------------------------------

_W: dict = {}


def _read_padded(vrt, col_off: int, row_off: int, side: int, dim: int):
    """Read a `side`×`side` window, clipping to [0, dim) and zero-padding the rest.

    WarpedVRT forbids boundless reads; interior tiles never pad, but true
    global-edge tiles (the poles/date-line apron at world scale) do.
    """
    out = np.zeros((side, side), dtype="float32")
    c0, r0 = max(col_off, 0), max(row_off, 0)
    c1, r1 = min(col_off + side, dim), min(row_off + side, dim)
    if c1 > c0 and r1 > r0:
        block = vrt.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
        out[r0 - row_off:r1 - row_off, c0 - col_off:c1 - col_off] = block
    return out


def _init_source(src_path, z, transform_coeffs, dim, resampling, n, b, scale, offset, gzip, out_root, ext):
    os.environ["GDAL_NUM_THREADS"] = "1"  # don't oversubscribe threads × processes
    _open_safety()
    src = rasterio.open(src_path)
    vrt = WarpedVRT(src, crs="EPSG:3857", transform=Affine(*transform_coeffs),
                    width=dim, height=dim, resampling=resampling)
    _W.update(src=src, vrt=vrt, z=z, dim=dim, n=n, b=b, scale=scale,
              offset=offset, gzip=gzip, out_root=out_root, ext=ext)


def _source_emit(xy):
    x, y = xy
    n, b, dim = _W["n"], _W["b"], _W["dim"]
    data = _read_padded(_W["vrt"], x * n - b, y * n - b, n + 2 * b, dim)
    blob = encode.encode_tile(data, n, b, _W["scale"], _W["offset"], gzip=_W["gzip"])
    _write_tile(_W["out_root"], _W["z"], x, y, _W["ext"], blob)
    return float(data.min()), float(data.max()), len(blob)


# --- coarser zooms: 2×2-average the four finer tiles already on disk --------------

_C: dict = {}


def _init_coarse(z, n, b, scale, offset, gzip, out_root, ext):
    _open_safety()
    _C.update(z=z, n=n, b=b, scale=scale, offset=offset, gzip=gzip, out_root=out_root, ext=ext)


def _coarse_emit(xy):
    x, y = xy
    z, n, b = _C["z"], _C["n"], _C["b"]
    scale, offset, gzip, out_root, ext = _C["scale"], _C["offset"], _C["gzip"], _C["out_root"], _C["ext"]
    fz = z + 1
    side = n + 2 * b          # tile sample side (interior + border)
    fsize = 2 * side          # finer-grid region this coarse tile draws from
    fc0, fr0 = 2 * x * n - 2 * b, 2 * y * n - 2 * b  # finer global col/row of fine[0,0]
    ftiles = 2 ** fz          # finer tiles per side (for clamping)

    cache: dict = {}

    def child(ftx, fty):
        if (ftx, fty) not in cache:
            arr = None
            if 0 <= ftx < ftiles and 0 <= fty < ftiles:
                p = out_root / "tiles" / str(fz) / str(ftx) / f"{fty}{ext}"
                if p.exists():
                    _, arr = encode.decode_tile(p.read_bytes(), n, b, encode.BLK, gzip=gzip)
            cache[(ftx, fty)] = arr  # decoded codes (side×side), or None if absent
        return cache[(ftx, fty)]

    fine = np.zeros((fsize, fsize), dtype="float64")  # finer height-codes
    # Children whose bordered extent [ft*n-b, ft*n+n+b) overlaps [fc0, fc0+fsize):
    for fty in range(math.floor((fr0 - b) / n) - 1, math.floor((fr0 + fsize + b) / n) + 2):
        gr_t0 = fty * n - b
        gr_lo, gr_hi = max(gr_t0, fr0), min(gr_t0 + side, fr0 + fsize)
        if gr_hi <= gr_lo:
            continue
        for ftx in range(math.floor((fc0 - b) / n) - 1, math.floor((fc0 + fsize + b) / n) + 2):
            gc_t0 = ftx * n - b
            gc_lo, gc_hi = max(gc_t0, fc0), min(gc_t0 + side, fc0 + fsize)
            if gc_hi <= gc_lo:
                continue
            arr = child(ftx, fty)
            if arr is None:
                continue
            fine[gr_lo - fr0:gr_hi - fr0, gc_lo - fc0:gc_hi - fc0] = \
                arr[gr_lo - gr_t0:gr_hi - gr_t0, gc_lo - gc_t0:gc_hi - gc_t0]

    # 2×2 box average → coarse codes; re-encode as heights (h = code*scale + offset).
    codes = 0.25 * (fine[0::2, 0::2] + fine[1::2, 0::2] + fine[0::2, 1::2] + fine[1::2, 1::2])
    heights = codes * scale + offset
    blob = encode.encode_tile(heights, n, b, scale, offset, gzip=gzip)
    _write_tile(out_root, z, x, y, ext, blob)
    return float(heights.min()), float(heights.max()), len(blob)


def _run_zoom(jobs, jobs_xy, init_fn, init_args, emit_fn):
    """Fan a zoom's tiles across the pool (or run in-process when jobs<=1). Returns
    (min, max, bytes). Chunk so every worker gets work — a fixed chunksize starves
    the few-tile coarse zooms (all in one chunk = one core busy)."""
    zmin, zmax, zbytes = math.inf, -math.inf, 0
    if jobs > 1 and len(jobs_xy) > 1:
        chunk = max(1, len(jobs_xy) // (jobs * 4))
        with mp.Pool(jobs, initializer=init_fn, initargs=init_args) as pool:
            for lmin, lmax, nbytes in pool.imap_unordered(emit_fn, jobs_xy, chunksize=chunk):
                zmin, zmax, zbytes = min(zmin, lmin), max(zmax, lmax), zbytes + nbytes
    else:
        init_fn(*init_args)
        for xy in jobs_xy:
            lmin, lmax, nbytes = emit_fn(xy)
            zmin, zmax, zbytes = min(zmin, lmin), max(zmax, lmax), zbytes + nbytes
    return zmin, zmax, zbytes


def build(cfg, src_path: Path, jobs: int = 1) -> dict:
    _open_safety()
    pyr = cfg.pyramid
    n, b = pyr.tile_samples, pyr.border
    out_root = cfg.paths.pyramid_out
    ext = ".bin.gz" if pyr.gzip else ".bin"
    scale, offset, gzip = pyr.height_scale, pyr.height_offset, pyr.gzip
    z_max = pyr.max_zoom

    coverage: dict[str, dict] = {}
    gmin, gmax = math.inf, -math.inf
    total_bytes = 0

    # Finest zoom from source, then each coarser zoom from the finer tiles on disk.
    for z in range(z_max, pyr.min_zoom - 1, -1):
        p = mercator.resolution(z, n)
        x0, x1, y0, y1 = mercator.covered_tiles(cfg.region, z)
        jobs_xy = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]

        if z == z_max:
            dim = (2 ** z) * n
            coeffs = (p, 0.0, -mercator.E, 0.0, -p, mercator.E)
            init_args = (src_path, z, coeffs, dim, Resampling.bilinear,
                         n, b, scale, offset, gzip, out_root, ext)
            zmin, zmax_h, zbytes = _run_zoom(jobs, jobs_xy, _init_source, init_args, _source_emit)
            how = "source"
        else:
            init_args = (z, n, b, scale, offset, gzip, out_root, ext)
            zmin, zmax_h, zbytes = _run_zoom(jobs, jobs_xy, _init_coarse, init_args, _coarse_emit)
            how = "children"

        gmin, gmax = min(gmin, zmin), max(gmax, zmax_h)
        coverage[str(z)] = {"xRange": [x0, x1], "yRange": [y0, y1]}
        total_bytes += zbytes
        print(f"  z{z}: {len(jobs_xy)} tiles · res {p:7.1f} m/sample · {zbytes / 1e6:6.1f} MB · {how}")

    return {
        "coverage": coverage,
        "heightRange": [round(gmin, 2), round(gmax, 2)],
        "totalBytes": total_bytes,
    }
