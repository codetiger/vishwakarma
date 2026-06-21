"""Web-Mercator (EPSG:3857) global tile-pyramid math. All functions are pure.

Standard slippy scheme: zoom z divides the world into 2^z × 2^z tiles of N
samples each; z=0 is coarsest. The projected extent is [-E, E] on both axes.
"""

from __future__ import annotations

import math

E = 20037508.342789244  # half-circumference (m); web-mercator extent = [-E, E]^2
LAT_LIMIT = 85.05112877980659  # where mercator y reaches ±E


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = lon * E / 180.0
    lat = max(min(lat, LAT_LIMIT), -LAT_LIMIT)
    y = math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0)) * E / math.pi
    return x, y


def merc_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = x / E * 180.0
    lat = math.degrees(2.0 * math.atan(math.exp(y / E * math.pi)) - math.pi / 2.0)
    return lon, lat


def resolution(z: int, n: int) -> float:
    """Metres per height sample at zoom z for N-sample tiles."""
    return 2.0 * E / (2 ** z * n)


def tile_span(z: int) -> float:
    """Tile world span (m) at zoom z."""
    return 2.0 * E / 2 ** z


def covered_tiles(region, z: int) -> tuple[int, int, int, int]:
    """(x0, x1, y0, y1) inclusive tile-index range overlapping the lon/lat bbox.

    y grows southward, so the north edge (max_lat) maps to the smaller index.
    Indices are clamped to [0, 2^z-1] so a whole-world bbox (lon ±180 → merc ±E,
    lat ±85.06 → merc ≈ ±E) doesn't spill one tile past the grid (x1 would floor
    to 2^z, y0 to -1).
    """
    sz = tile_span(z)
    nmax = 2 ** z - 1
    clamp = lambda i: min(max(i, 0), nmax)
    mx0, my0 = lonlat_to_merc(region.min_lon, region.min_lat)  # SW
    mx1, my1 = lonlat_to_merc(region.max_lon, region.max_lat)  # NE
    x0 = clamp(int(math.floor((mx0 + E) / sz)))
    x1 = clamp(int(math.floor((mx1 + E) / sz)))
    y0 = clamp(int(math.floor((E - my1) / sz)))  # north
    y1 = clamp(int(math.floor((E - my0) / sz)))  # south
    return x0, x1, y0, y1


def sample_merc(z: int, n: int, tx: int, ty: int, i: int, j: int) -> tuple[float, float]:
    """Merc (x, y) at the CENTRE of interior sample (i, j) of tile (z, tx, ty)."""
    p = resolution(z, n)
    col = tx * n + i
    row = ty * n + j
    return -E + (col + 0.5) * p, E - (row + 0.5) * p
