"""Tile byte encoding: 20-byte header + row-major i16 height codes (+gzip).

Layout (little-endian):
    0  4s  magic   "VKH1"
    4  B   version (=1)
    5  B   z
    6  H   reserved (0)
    8  I   x
    12 I   y
    16 H   n        (interior samples/edge)
    18 H   border   (overlap ring)
    20 …   (n+2*border)^2 × i16 height codes  (row-major, north→south)
Decode: elev_m = code * heightScale + heightOffset.
"""

from __future__ import annotations

import gzip as _gzip
import struct

import numpy as np

MAGIC = b"VKH1"
VERSION = 1
HEADER = struct.Struct("<4sBBHIIHH")  # 20 bytes
assert HEADER.size == 20

I16_MIN, I16_MAX = -32768, 32767


def encode_tile(z, x, y, data, n, border, height_scale, height_offset, gzip=False) -> bytes:
    """`data`: float ndarray, shape (n+2*border, n+2*border). Returns the tile blob."""
    codes = np.round((np.asarray(data, dtype="float64") - height_offset) / height_scale)
    codes = np.clip(codes, I16_MIN, I16_MAX).astype("<i2")
    blob = HEADER.pack(MAGIC, VERSION, z & 0xFF, 0, x, y, n, border) + codes.tobytes(order="C")
    return _gzip.compress(blob) if gzip else blob


def decode_tile(blob: bytes, gzip=False):
    """Inverse of encode_tile → (meta dict, float ndarray of heights in metres)."""
    if gzip:
        blob = _gzip.decompress(blob)
    magic, version, z, _, x, y, n, border = HEADER.unpack(blob[:HEADER.size])
    assert magic == MAGIC and version == VERSION, "bad tile header"
    side = n + 2 * border
    codes = np.frombuffer(blob, dtype="<i2", count=side * side, offset=HEADER.size)
    meta = {"z": z, "x": x, "y": y, "n": n, "border": border}
    return meta, codes.reshape(side, side).astype("float64")
