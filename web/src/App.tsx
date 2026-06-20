import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import Stage from "./scene/Stage";
import { mapTheme } from "./mapTheme";
import { initTerrain, setHeightScale } from "./terrain";
import { curveUniforms } from "./scene/curvature";
import type { FromWorker, ToWorker, TileResult } from "./voxelTypes";

// Voxelize tiles across a pool of workers (one per spare core, capped) so dense
// near-camera tiles stream in parallel instead of one at a time.
const POOL_SIZE = Math.max(
  1,
  Math.min((navigator.hardwareConcurrency || 4) - 1, 4),
);

const DEFAULT_SIZE = 0.5; // placeholder until the manifest sets the real finest size

// Resolve to an ABSOLUTE url against the document. The voxel worker's own base is
// /assets/, so a relative `./pyramid/...` would fetch from there (404) — the main
// thread and worker must agree on the same absolute manifest + tile urls.
const MANIFEST_URL = new URL(
  `${import.meta.env.BASE_URL}pyramid/manifest.json`,
  document.baseURI,
).href;

export default function App() {
  // The streamed (finest) voxel size, pinned to the finest pyramid level once the
  // manifest loads. There's no user control: the LOD clipmap coarsens from this
  // size with distance/altitude, so high-res voxels simply appear as you zoom in.
  const [voxelSize, setVoxelSize] = useState(DEFAULT_SIZE);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(
    null,
  );
  const [heightExag, setHeightExag] = useState(1);

  // Vertical exaggeration: drive the shared shader uniform AND the camera's
  // terrain-follow scale together, so the terrain re-exaggerates instantly (no
  // re-voxelize) and the eye stays glued to the new surface.
  const applyHeightExag = (v: number) => {
    setHeightExag(v);
    curveUniforms.uHeightScale.value = v;
    setHeightScale(v);
  };

  const workersRef = useRef<Worker[]>([]);
  const inbox = useRef<TileResult[]>([]);
  const focus = useRef(new THREE.Vector3(0, 0, 0));

  // Spawn the worker pool and load the compiled scene on every thread: each worker
  // voxelizes tiles (in parallel), the main thread answers height/bounds queries
  // for the camera. The view is ready once ALL workers have loaded their copy.
  useEffect(() => {
    let readyCount = 0;
    let world: Awaited<ReturnType<typeof initTerrain>> | null = null;

    const tryReady = () => {
      if (readyCount < POOL_SIZE || !world) return;
      // Spawn at the region centre (varied mid-elevation terrain), but inside the
      // same edge-margin the camera roams within (so the view never opens on the
      // map rim from frame one).
      const [minX, minZ, maxX, maxZ] = world.bounds;
      const m = mapTheme.view.edgeMargin;
      const mx = Math.min(m, (maxX - minX) * 0.4);
      const mz = Math.min(m, (maxZ - minZ) * 0.4);
      const sx = (minX + maxX) / 2;
      const sz = (minZ + maxZ) / 2;
      focus.current.set(
        THREE.MathUtils.clamp(sx, minX + mx, maxX - mx),
        0,
        THREE.MathUtils.clamp(sz, minZ + mz, maxZ - mz),
      );
      // Drive the LOD from the pyramid's zoom range: finest voxel = maxZoom tile,
      // coarse base = minZoom tile, and the quadtree needs exactly one level per
      // zoom step to bridge them (= maxZoom − minZoom + 1) — otherwise the coarse
      // root cell collapses at high maxZoom and the root-cell count explodes.
      const [finest, coarsest] = world.voxelRange;
      mapTheme.view.baseVoxel = coarsest;
      mapTheme.view.lodLevels = Math.round(Math.log2(coarsest / finest)) + 1;
      setBounds(world.bounds);
      setVoxelSize(finest); // stream the finest level; LOD coarsens outward from it
      setStatus("ready");
    };

    const workers: Worker[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(new URL("./voxelWorker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          readyCount++;
          tryReady();
        } else if (msg.type === "tile") {
          inbox.current.push({ ...msg, widx: i }); // tag the producing worker
        } else if (msg.type === "error") {
          setError(msg.message);
          setStatus("error");
        }
      };
      worker.postMessage({
        type: "load",
        url: MANIFEST_URL,
      } satisfies ToWorker);
      workers.push(worker);
    }
    workersRef.current = workers;

    initTerrain(MANIFEST_URL)
      .then((w) => {
        world = w;
        tryReady();
      })
      .catch((err) => {
        setError(String(err));
        setStatus("error");
      });

    return () => {
      for (const w of workers) w.terminate();
    };
  }, []);

  return (
    <div className="app">
      {status === "ready" && bounds && workersRef.current.length > 0 && (
        <Stage
          voxelSize={voxelSize}
          focus={focus}
          bounds={bounds}
          workers={workersRef.current}
          inbox={inbox}
        />
      )}

      <div className="panel">
        <a
          className="repo"
          href="https://github.com/codetiger/vishwakarma"
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
          title="View on GitHub"
        >
          <svg
            viewBox="0 0 16 16"
            width="20"
            height="20"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
        <h1>Voxel Terrain Viewer</h1>
        <p className="sub">
          Explore real-world terrain as voxels. Elevation data streams in and
          rebuilds into a 3D landscape as you move, and more detail loads the
          closer you look.
        </p>
        {status === "ready" && (
          <div className="control">
            <label>Height exaggeration · {heightExag}×</label>
            <input
              type="range"
              min={1}
              max={16}
              step={1}
              value={heightExag}
              onChange={(e) => applyHeightExag(Number(e.target.value))}
            />
          </div>
        )}
        {status === "error" && <p className="status err">Error: {error}</p>}
      </div>
    </div>
  );
}
