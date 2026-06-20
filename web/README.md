# Vishwakarma web viewer

A single-page app that runs the `vishwakarma` voxelizer **in the browser via
WASM** and renders the India surface as a 3D voxel map, styled after the
mahabharata renderer. The voxel size is changed live with a slider — only
`voxelize()` re-runs.

The scene is shipped **precompiled**: a `.vkc` binary (the compiled `Surface`
serialized by the `compile` bin) that the worker loads straight into a
voxelizable surface — no JSON parse, validation, or compile in the browser.

## Architecture

```
public/india.vkc    precompiled surface blob — fetched once (ArrayBuffer)
   │
voxelWorker.ts      WASM SurfaceHandle.fromCompiled(bytes): load ONCE (no
   │                parse/validate/compile), then voxelize(size) → packed
   │                {positions,colors,count}
   ▼
App.tsx             debounced slider → worker; drops stale results
   ▼
scene/VoxelField    one InstancedMesh, recentered + scaled to a fixed footprint
scene/*             ported mahabharata theme: curvature, lighting, sky, bloom, roam
```

The heavy library work (voxelization) runs in a Web Worker, so the camera and UI
stay responsive while re-voxelizing.

## Setup

Requires the Rust toolchain, [`wasm-pack`](https://drager.github.io/wasm-pack/),
and Node. From this `web/` directory:

```bash
npm install
npm run setup     # 1) compile the India scene → public/india.vkc
                  # 2) wasm-pack build the crate → src/wasm/pkg/
npm run dev       # Vite dev server
```

`npm run setup` runs two generators (both also runnable on their own):

- `npm run compile` — `cargo run --bin compile`, imports + validates +
  compiles `harness/data/india/` and writes the compiled `Surface` as the
  binary `public/india.vkc` the browser loads directly.
- `npm run wasm` — `wasm-pack build --target web --features wasm`, emits the
  `.wasm` + JS glue into `src/wasm/pkg/`.

Re-run `npm run wasm` after changing `src/wasm.rs` (or any library code);
re-run `npm run compile` after changing the India scene. (`npm run flatten`
still exists to emit the older inline `india.json`, useful for the JSON
`new SurfaceHandle(json)` path.)

## Controls

- **Drag** — pan the map
- **Scroll** — zoom
- **Shift-drag / right-drag** — rotate

## Tuning the look

All art direction (palette, lighting, fog, bloom, curvature, camera framing)
lives in `src/mapTheme.ts`. Finer voxel sizes produce more instances; the slider
floor (`MIN_SIZE` in `src/App.tsx`) guards interactivity — the live voxel count
shows the cost.
