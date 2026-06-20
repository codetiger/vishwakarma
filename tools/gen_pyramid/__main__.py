"""Build a Web-Mercator height-tile pyramid for the JS voxel viewer.

    cd tools && python -m gen_pyramid                  # build per config.toml
    cd tools && python -m gen_pyramid --max-zoom 7     # override a knob for a light run
    cd tools && python -m gen_pyramid --self-test      # offline correctness check
"""

from __future__ import annotations

import sys

from . import config, fetch, manifest, tiles


def _apply_overrides(cfg, argv) -> None:
    for flag, key in (("--min-zoom", "min_zoom"), ("--max-zoom", "max_zoom")):
        if flag in argv:
            setattr(cfg.pyramid, key, int(argv[argv.index(flag) + 1]))


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if "--self-test" in argv:
        from . import verify
        raise SystemExit(0 if verify.run() else 1)

    cfg = config.load()
    _apply_overrides(cfg, argv)
    pyr = cfg.pyramid
    print("vishwakarma · height-tile pyramid")
    print(f"  bbox {cfg.region.min_lon},{cfg.region.min_lat} → "
          f"{cfg.region.max_lon},{cfg.region.max_lat} · zoom {pyr.min_zoom}..{pyr.max_zoom}")
    src = fetch.dem(cfg)
    print(f"  source DEM: {src}")
    stats = tiles.build(cfg, src)
    out = manifest.write(cfg, stats)
    print(f"  height range {stats['heightRange']} m · total {stats['totalBytes'] / 1e6:.1f} MB")
    print(f"  manifest → {out}")


if __name__ == "__main__":
    main()
