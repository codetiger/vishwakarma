"""Assemble and write pyramid/manifest.json (the JS worker's index)."""

from __future__ import annotations

import json
from pathlib import Path

from . import encode, mercator


def build(cfg, stats: dict) -> dict:
    pyr = cfg.pyramid
    # Origin = SW corner in merc; the client subtracts it to keep coords small.
    ox, oy = mercator.lonlat_to_merc(cfg.region.min_lon, cfg.region.min_lat)
    mx1, my1 = mercator.lonlat_to_merc(cfg.region.max_lon, cfg.region.max_lat)
    return {
        "version": 2,  # 2 = headerless tiles (geometry/version live here, not per tile)
        "projection": "webmercator",
        "tileSamples": pyr.tile_samples,
        "border": pyr.border,
        "blockSize": encode.BLK,
        "heightScale": pyr.height_scale,
        "heightOffset": pyr.height_offset,
        "nodata": -32768,
        "minZoom": pyr.min_zoom,
        "maxZoom": pyr.max_zoom,
        "originMerc": [round(ox, 3), round(oy, 3)],
        # Merc bbox of the exact region [minX, minY, maxX, maxY]; client maps it to
        # world bounds via (merc - origin) / worldScale.
        "regionMerc": [round(ox, 3), round(oy, 3), round(mx1, 3), round(my1, 3)],
        "heightRange": stats["heightRange"],
        "coverage": stats["coverage"],
        "tileUrl": "tiles/{z}/{x}/{y}" + (".bin.gz" if pyr.gzip else ".bin"),
    }


def write(cfg, stats: dict) -> Path:
    out = cfg.paths.pyramid_out / "manifest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build(cfg, stats), indent=2))
    return out
