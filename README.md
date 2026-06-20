# vishwakarma

Explore real-world terrain as voxels, right in your browser. Elevation data
streams in and rebuilds into a 3D landscape as you move, and more detail loads
the closer you look.

It works in two stages. An offline Python tool turns global elevation data into
a pyramid of small height tiles. A web viewer streams those tiles and builds them
into coloured cubes as you roam, with a round-world horizon that curves down to a
starlit edge. The tiles are plain static files and all the 3D work happens in the
browser. No backend, no WebAssembly.

## Quickstart

```bash
# 1. Build the height-tile pyramid.
#    The first run downloads the elevation data for the region, then caches it.
cd tools
pip install -r gen_pyramid/requirements.txt
python -m gen_pyramid                 # writes web/public/pyramid/

# 2. Run the viewer.
cd ../web
npm install
npm run dev                           # http://localhost:5173
```

## Controls

- Move: drag, or the WASD keys
- Turn: shift-drag, or the Q and E keys
- Zoom: mouse wheel
- Height exaggeration: the slider in the panel (1× to 16×)

## How it works

Each tile stores only heights, packed small. Colour, shading, culling, and the
seams between detail levels are all worked out in the browser, so the files stay
tiny and the same tiles work at any zoom.

1. **Build the pyramid.** `gen_pyramid` reprojects the elevation data to Web
   Mercator and cuts it into a quadtree of tiles, from a coarse overview of the
   whole region down to fine detail. Only tiles that cover the region are written.
   Each tile carries a small border so neighbours line up without seams.
2. **Pick the detail.** As you roam, the viewer's clipmap
   (`web/src/scene/TileField.tsx`) lays a grid of cells around the camera. Cells
   near you are fine, cells far away are coarse. It hands each cell a world
   rectangle and a voxel size.
3. **Build the cubes.** A pool of Web Workers (`web/src/voxelWorker.ts`) takes each
   cell, fetches the height tiles it needs, and samples one column per voxel.
   `buildMesh.ts` turns the columns into cubes, coloured by elevation, with baked
   ambient occlusion and a skirt along the edges that hides the seam where detail
   levels meet.

The far terrain curves down to a clean silhouette against a starfield.
Screen-space ambient occlusion, bloom, and a vignette finish the look. Every
module has a header comment explaining its part, and [`CLAUDE.md`](CLAUDE.md) maps
the whole thing file by file.

## Configuration

The region, elevation source, and pyramid settings live in
[`tools/gen_pyramid/config.toml`](tools/gen_pyramid/config.toml). It ships covering
South Asia, using ETOPO 2022 (public domain, from NOAA). Change the bounding box to
build a different area, then rerun `python -m gen_pyramid`.

To check the build pipeline without any network access:

```bash
cd tools && python -m gen_pyramid --self-test
```

## Layout

```
tools/gen_pyramid/   elevation data to Web-Mercator height tiles (Python)
web/                 voxel viewer (Vite, React, three.js)
```

## License

See [`LICENSE`](LICENSE).
