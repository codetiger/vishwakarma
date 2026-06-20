"""Tile byte encoding: headerless per-block bit-packed height codes (v2 format).

A tile file is *pure data* — no per-tile header. It is the per-block table followed
by the packed payload. All geometry (tile samples `n`, `border`, block edge `blk`)
and the format version live once in `manifest.json`; the tile's `z/x/y` are its URL
path. This avoids duplicating manifest constants in every tile.

The tile is a grid of BLK×BLK blocks; each block stores its own `base` (min code) +
minimal `bits` width, then packs its samples (value = code − base, LSB-first,
row-major) byte-aligned. Local per-block ranges pack far tighter than one per-tile
width (a 156 km z8 tile mixes flat and steep ground); constant blocks → bits=0, no
payload. The step is global (`heightScale`), so reconstruction is exact codes and
adjacent tiles' shared samples agree (no seams). Heights-only.

Layout (little-endian):
    0  …  block table: nb² entries of (i16 base, u8 bits), row-major over the
          ceil(side/blk)² block grid  (side = n + 2*border)
    …  …  payload: each block's ceil(h*w*bits/8) packed bytes, same block order
Decode: elev_m = (base + value) * heightScale + heightOffset.
"""

from __future__ import annotations

import gzip as _gzip
import struct

import numpy as np

BLK = 16  # block edge (samples); published in the manifest as `blockSize`
BLOCK = struct.Struct("<hB")  # per-block (base, bits) = 3 bytes

I16_MIN, I16_MAX = -32768, 32767


def _pack_bits(values: np.ndarray, bits: int) -> bytes:
    """Pack uint values into an LSB-first bit stream of `bits` bits each."""
    if bits == 0:
        return b""
    v = np.ascontiguousarray(values, dtype=np.uint32)
    shifts = np.arange(bits, dtype=np.uint32)
    bitmat = ((v[:, None] >> shifts) & np.uint32(1)).astype(np.uint8)  # bit j of each value
    return np.packbits(bitmat.reshape(-1), bitorder="little").tobytes()


def _unpack_bits(packed: bytes, bits: int, count: int) -> np.ndarray:
    """Inverse of _pack_bits → uint32 array of `count` values."""
    if bits == 0:
        return np.zeros(count, dtype=np.uint32)
    flat = np.unpackbits(np.frombuffer(packed, dtype=np.uint8), bitorder="little")
    flat = flat[: count * bits].reshape(count, bits).astype(np.uint32)
    shifts = np.arange(bits, dtype=np.uint32)
    return (flat << shifts).sum(axis=1).astype(np.uint32)


def encode_tile(data, n, border, height_scale, height_offset, gzip=False) -> bytes:
    """`data`: float ndarray, shape (n+2*border, n+2*border). Returns the tile blob."""
    codes = np.round((np.asarray(data, dtype="float64") - height_offset) / height_scale)
    codes = np.clip(codes, I16_MIN, I16_MAX).astype(np.int32)
    side = n + 2 * border
    table = bytearray()
    payload = bytearray()
    for r0 in range(0, side, BLK):
        for c0 in range(0, side, BLK):
            blk = codes[r0:r0 + BLK, c0:c0 + BLK]
            base = int(blk.min())
            bits = int((int(blk.max()) - base).bit_length())  # 0 for a constant block
            table += BLOCK.pack(base, bits)
            if bits:
                payload += _pack_bits((blk - base).astype(np.uint32).ravel(order="C"), bits)
    blob = bytes(table) + bytes(payload)
    return _gzip.compress(blob) if gzip else blob


def decode_tile(blob: bytes, n, border, blk=BLK, gzip=False):
    """Inverse of encode_tile → (meta dict, float ndarray of height codes).

    `n`, `border`, `blk` come from the manifest (the tile carries no header).
    """
    if gzip:
        blob = _gzip.decompress(blob)
    side = n + 2 * border
    nb = (side + blk - 1) // blk
    codes = np.empty((side, side), dtype=np.int32)
    toff = 0
    poff = BLOCK.size * nb * nb
    for r0 in range(0, side, blk):
        r1 = min(r0 + blk, side)
        for c0 in range(0, side, blk):
            c1 = min(c0 + blk, side)
            base, bits = BLOCK.unpack_from(blob, toff)
            toff += BLOCK.size
            cnt = (r1 - r0) * (c1 - c0)
            if bits == 0:
                codes[r0:r1, c0:c1] = base
            else:
                nbytes = (cnt * bits + 7) // 8
                vals = _unpack_bits(blob[poff:poff + nbytes], bits, cnt)
                codes[r0:r1, c0:c1] = base + vals.reshape(r1 - r0, c1 - c0).astype(np.int32)
                poff += nbytes
    meta = {"n": n, "border": border, "blk": blk}
    return meta, codes.astype("float64")
