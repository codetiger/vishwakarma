"""Build a global Web-Mercator height-tile pyramid from the ETOPO DEM.

The web viewer streams these tiles and voxelizes them in a pool of JS workers
(no Rust/wasm).

    cd tools && python -m gen_pyramid              # build per config.toml
    cd tools && python -m gen_pyramid --self-test  # offline correctness check
"""
