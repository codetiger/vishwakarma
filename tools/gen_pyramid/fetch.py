"""Download + cache the ETOPO DEM bbox (15″ tiled mosaic, or a 30″/60″ windowed
read). Only the configured region is fetched over the network, then cached."""

from __future__ import annotations

import math
import os
import urllib.request
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


def _tile_urls(cfg):
    """ETOPO 15″ tiles (15°×15°) covering the bbox.

    Tiles are named by their NW (top-left) corner: `N{lat}{E/W}{lon}` spans
    latitude [lat−15, lat] and longitude [lon, lon+15]. Latitude is clamped ≥ 0.
    """
    r = cfg.region
    lons = range(int(math.floor(r.min_lon / 15) * 15), int(math.ceil(r.max_lon / 15) * 15), 15)
    lat_lo = int(math.floor(max(0.0, r.min_lat) / 15) * 15) + 15
    lat_hi = int(math.ceil(r.max_lat / 15) * 15)
    lats = range(lat_lo, lat_hi + 15, 15)
    urls = []
    for la in lats:
        for lo in lons:
            ew = "E" if lo >= 0 else "W"
            name = f"ETOPO_2022_v1_15s_N{la:02d}{ew}{abs(lo):03d}_surface.tif"
            urls.append(f"{cfg.dem.tile_base}/{name}")
    return urls


def dem(cfg) -> Path:
    """Cache the ETOPO bbox as a local EPSG:4326 GeoTIFF and return its path.

    15″ → mosaic the covering tiles and resample to `target_arcsec`; 30″/60″ →
    a single windowed read. Only the bbox is fetched.
    """
    out = cfg.paths.cache / f"etopo_{cfg.dem.resolution}_bbox.tif"
    if out.exists() and out.stat().st_size > 0:
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    _gdal_curl_env()
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.merge import merge
    from rasterio.windows import from_bounds

    r = cfg.region
    if cfg.dem.resolution == "15s":
        print("  fetching ETOPO 15″ tiles via /vsicurl + mosaic")
        srcs = []
        for u in _tile_urls(cfg):
            try:
                srcs.append(rasterio.open("/vsicurl/" + u))
            except Exception as e:  # noqa: BLE001 - a missing tile is fine
                print(f"  WARN tile {u}: {e}")
        if not srcs:
            raise RuntimeError("no ETOPO 15″ tiles opened")
        res = cfg.dem.target_arcsec / 3600.0
        arr, transform = merge(
            srcs,
            bounds=(r.min_lon, max(0.0, r.min_lat), r.max_lon, r.max_lat),
            res=res,
            resampling=Resampling.average,
        )
        for s in srcs:
            s.close()
        arr = arr[0]
        profile = {
            "driver": "GTiff", "height": arr.shape[0], "width": arr.shape[1],
            "count": 1, "dtype": arr.dtype, "crs": "EPSG:4326",
            "transform": transform, "compress": "deflate",
        }
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(arr, 1)
        return out

    url = cfg.dem.url_30s if cfg.dem.resolution == "30s" else cfg.dem.url_60s
    print(f"  fetching ETOPO {cfg.dem.resolution} bbox via /vsicurl: {url}")
    with rasterio.open("/vsicurl/" + url) as ds:
        win = from_bounds(r.min_lon, r.min_lat, r.max_lon, r.max_lat, ds.transform)
        win = win.round_offsets().round_lengths()
        arr = ds.read(1, window=win)
        profile = ds.profile.copy()
        profile.update(
            height=arr.shape[0], width=arr.shape[1], transform=ds.window_transform(win),
            count=1, compress="deflate", crs="EPSG:4326",
        )
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(arr, 1)
    return out
