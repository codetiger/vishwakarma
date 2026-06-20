"""Build a global Web-Mercator height-tile pyramid from the ETOPO DEM.

The web viewer streams these tiles and voxelizes them in a JS worker (no Rust/
wasm). See docs/phase1-raster-base.md for the design.

    cd tools && python -m gen_pyramid              # build per config.toml
    cd tools && python -m gen_pyramid --self-test  # offline correctness check
"""
