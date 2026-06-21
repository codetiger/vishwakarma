"""Download + cache the ETOPO DEM bbox (15″ tiled mosaic, or a 30″/60″ windowed
read). Only the configured region is fetched over the network, then cached."""

from __future__ import annotations

import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def _download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "vishwakarma"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    return dest


def _gdal_curl_env():
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
    # Retry transient /vsicurl failures so a blip mid-download doesn't punch a hole
    # in the assembled world DEM (288 cells over the network).
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
    os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


def _cell_name(ne: int, we: int) -> str:
    """ETOPO 15° source-tile filename for the cell whose NORTH edge is `ne` and
    WEST edge is `we` (covers lat [ne−15, ne], lon [we, we+15]).

    Tiles are named by their NW (top-left) corner — matching the 30″/60″ single
    files (e.g. `…_N90W180_…`) and verified against the live server: the name's
    latitude is the NORTH edge, its longitude the WEST edge.
    """
    ns, la = ("N", ne) if ne >= 0 else ("S", -ne)
    ew, lo = ("E", we) if we >= 0 else ("W", -we)
    return f"ETOPO_2022_v1_15s_{ns}{la:02d}{ew}{lo:03d}_surface.tif"


def _cells(r):
    """(north_edge, west_edge) of every 15° cell overlapping the region, both
    hemispheres, clamped to ETOPO's grid (north edges −75…90, west edges −180…165).
    Rows run north→south. A cell [ne−15, ne]×[we, we+15] overlaps the bbox.
    """
    lon0 = max(int(math.floor(r.min_lon / 15) * 15), -180)
    lon1 = min(int(math.ceil(r.max_lon / 15) * 15), 165)
    ne_hi = min(int(math.ceil(r.max_lat / 15) * 15), 90)
    ne_lo = max(int(math.floor(r.min_lat / 15) * 15) + 15, -75)
    return [(ne, we) for ne in range(ne_hi, ne_lo - 15, -15)
            for we in range(lon0, lon1 + 15, 15)]


def _tile_urls(cfg):
    """ETOPO 15″ source-tile URLs covering the bbox."""
    return [f"{cfg.dem.tile_base}/{_cell_name(ne, we)}" for ne, we in _cells(cfg.region)]


def _bbox_tag(r) -> str:
    """Compact, filesystem-safe bbox key so a region change invalidates the cache
    (the old fixed name reused one region's download for another)."""
    return "_".join(f"{v:+.0f}".replace("+", "p").replace("-", "m")
                    for v in (r.min_lon, r.min_lat, r.max_lon, r.max_lat))


def _download_cell(url: str, dest: Path, timeout: int = 60, tries: int = 4) -> bool:
    """Download one ETOPO 15° tile to `dest` (skip if already present). Bounded by a
    per-read socket timeout + retries so no single cell can stall the whole fetch."""
    if dest.exists() and dest.stat().st_size > 0:
        return True
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "vishwakarma"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            tmp.replace(dest)
            return True
        except Exception:  # noqa: BLE001 - transient network failure → retry/backoff
            tmp.unlink(missing_ok=True)
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
    return False


def _download_cells(cfg, cells, cdir: Path, workers: int = 8) -> Path:
    """Fetch every covering 15° cell to `cdir` IN PARALLEL (resumable — present
    files are skipped). Sequential /vsicurl over 288 cells gets throttled by NOAA
    and stalls; concurrent short-lived HTTP GETs are far faster and robust."""
    cdir.mkdir(parents=True, exist_ok=True)
    jobs = [(f"{cfg.dem.tile_base}/{_cell_name(ne, we)}", cdir / _cell_name(ne, we))
            for ne, we in cells]
    n, done, failed = len(jobs), 0, []
    print(f"  downloading {n} ETOPO cells → _cache/{cdir.name}/ ({workers} parallel, resumable)")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_download_cell, url, dest): dest for url, dest in jobs}
        for fut in as_completed(futs):
            done += 1
            if not fut.result():
                failed.append(futs[fut].name)
            if done % 24 == 0 or done == n:
                print(f"  [{done:3d}/{n}] downloaded · {len(failed)} failed")
    if failed:
        print(f"  WARN {len(failed)} cells failed (will be sea-level fill): {failed[:4]}")
    return cdir


def _write_vrt(cells, cdir: Path, res: float, vrt_path: Path) -> Path:
    """Write a GDAL VRT that mosaics the per-cell TIFFs into one virtual EPSG:4326
    raster — NO pixels copied. Each <SimpleSource> records a cell's rectangle in the
    shared grid (DstRect); on every read GDAL intersects the request with those
    rectangles and pulls from the covering cell(s), stitching across boundaries
    automatically. The tiler opens this `.vrt` exactly like a GeoTIFF.
    """
    import rasterio

    we_min = min(we for _, we in cells)
    we_max = max(we for _, we in cells) + 15
    ne_max = max(ne for ne, _ in cells)
    ne_min = min(ne for ne, _ in cells) - 15
    W = round((we_max - we_min) / res)
    H = round((ne_max - ne_min) / res)
    sources = []
    for ne, we in cells:
        name = _cell_name(ne, we)
        cpath = cdir / name
        if not (cpath.exists() and cpath.stat().st_size > 0):
            continue  # missing cell → no source → that region reads as 0 (sea level)
        with rasterio.open(cpath) as src:
            cw, ch, t = src.width, src.height, src.transform
        xoff = round((t.c - we_min) / res)       # cell's left lon → column in the grid
        yoff = round((ne_max - t.f) / res)        # cell's top lat → row (north-up)
        sources.append(
            '    <SimpleSource>\n'
            f'      <SourceFilename relativeToVRT="1">{cdir.name}/{name}</SourceFilename>\n'
            '      <SourceBand>1</SourceBand>\n'
            f'      <SrcRect xOff="0" yOff="0" xSize="{cw}" ySize="{ch}"/>\n'
            f'      <DstRect xOff="{xoff}" yOff="{yoff}" xSize="{cw}" ySize="{ch}"/>\n'
            '    </SimpleSource>'
        )
    xml = (
        f'<VRTDataset rasterXSize="{W}" rasterYSize="{H}">\n'
        '  <SRS>EPSG:4326</SRS>\n'
        f'  <GeoTransform>{we_min}, {res!r}, 0.0, {ne_max}, 0.0, {-res!r}</GeoTransform>\n'
        '  <VRTRasterBand dataType="Float32" band="1">\n'
        + '\n'.join(sources) + '\n'
        '  </VRTRasterBand>\n'
        '</VRTDataset>\n'
    )
    vrt_path.write_text(xml)
    return vrt_path


def _mosaic_15s(cfg, vrt_out: Path) -> Path:
    """Download the covering 15° cells (parallel, resumable, kept on disk) and write
    a VRT mosaic over them. Returns the VRT path — the tiler reads tiles straight
    from the cells through it, so there's no materialised whole-world GeoTIFF and a
    tile spanning several cells is stitched on the fly by GDAL.
    """
    cells = _cells(cfg.region)
    if not cells:
        raise RuntimeError("region covers no ETOPO 15″ cells")
    cdir = _download_cells(cfg, cells, vrt_out.parent / "cells_15s")
    res = cfg.dem.target_arcsec / 3600.0
    _write_vrt(cells, cdir, res, vrt_out)
    print(f"  VRT mosaic → {vrt_out.name} ({len(cells)} cells kept in _cache/{cdir.name}/)")
    return vrt_out


def _window_global(cfg, out: Path) -> Path:
    """30″/60″ path: a single windowed read of the global ETOPO file."""
    import rasterio
    from rasterio.windows import from_bounds

    r = cfg.region
    url = cfg.dem.url_30s if cfg.dem.resolution == "30s" else cfg.dem.url_60s
    print(f"  fetching ETOPO {cfg.dem.resolution} bbox via /vsicurl: {url}")
    _gdal_curl_env()
    with rasterio.open("/vsicurl/" + url) as ds:
        win = from_bounds(r.min_lon, r.min_lat, r.max_lon, r.max_lat, ds.transform)
        win = win.round_offsets().round_lengths()
        arr = ds.read(1, window=win)
        profile = ds.profile.copy()
        profile.update(
            height=arr.shape[0], width=arr.shape[1], transform=ds.window_transform(win),
            count=1, compress="deflate", crs="EPSG:4326", bigtiff="IF_SAFER",
        )
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(arr, 1)
    return out


def dem(cfg) -> Path:
    """Cache the ETOPO bbox locally and return a path the tiler can open.

    15″ → download the covering 15° cells (kept as separate TIFFs) + a `.vrt` that
    mosaics them virtually; 30″/60″ → a single windowed GeoTIFF read. Only the bbox
    is fetched. The cache name includes the bbox so a region change re-fetches
    instead of serving stale data.
    """
    tag = _bbox_tag(cfg.region)
    cfg.paths.cache.mkdir(parents=True, exist_ok=True)
    if cfg.dem.resolution == "15s":
        out = cfg.paths.cache / f"etopo_15s_{tag}.vrt"
        return out if out.exists() and out.stat().st_size > 0 else _mosaic_15s(cfg, out)
    out = cfg.paths.cache / f"etopo_{cfg.dem.resolution}_{tag}.tif"
    return out if out.exists() and out.stat().st_size > 0 else _window_global(cfg, out)
