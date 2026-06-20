"""Load config.toml (region / DEM / pyramid) and resolve repo-relative paths."""

from __future__ import annotations

import tomllib
from pathlib import Path
from types import SimpleNamespace

PKG_DIR = Path(__file__).resolve().parent
REPO_ROOT = PKG_DIR.parents[1]
CACHE_DIR = PKG_DIR / "_cache"
PYRAMID_OUT = REPO_ROOT / "web" / "public" / "pyramid"


def _ns(d):
    """Recursively wrap dicts in attribute-accessible namespaces."""
    if isinstance(d, dict):
        return SimpleNamespace(**{k: _ns(v) for k, v in d.items()})
    return d


def load(path: Path | None = None) -> SimpleNamespace:
    path = path or (PKG_DIR / "config.toml")
    with open(path, "rb") as f:
        cfg = _ns(tomllib.load(f))
    cfg.paths = SimpleNamespace(cache=CACHE_DIR, pyramid_out=PYRAMID_OUT)
    return cfg
