import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import Stage from './scene/Stage';
import { mapTheme } from './mapTheme';
import { initTerrain } from './terrain';
import type { FromWorker, ToWorker, TileResult } from './voxelTypes';

// Voxelize tiles across a pool of workers (one per spare core, capped) so dense
// near-camera tiles stream in parallel instead of one at a time.
const POOL_SIZE = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 4));

// Voxel-size slider = the FINEST (selected) size used in the ring under the
// camera; the LOD clipmap coarsens with distance up to baseVoxel. Max is the
// base size (whole-area coarse); min is computed from the per-cell budget once
// the scene loads, so the slider can never request an unreasonable cell.
const STEP = 0.01;
const DEFAULT_SIZE = 0.5; // placeholder until the manifest sets the real range
const COMMIT_FALLBACK_MS = 500; // safety net if a slider release event is missed

const MANIFEST_URL = `${import.meta.env.BASE_URL}pyramid/manifest.json`;

export default function App() {
  const [voxelSize, setVoxelSize] = useState(DEFAULT_SIZE);
  const [applied, setApplied] = useState(DEFAULT_SIZE); // debounced → streaming
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(null);
  const [minSize, setMinSize] = useState(0.05);
  const [maxSize, setMaxSize] = useState(mapTheme.view.baseVoxel);
  const [stats, setStats] = useState({ tiles: 0, voxels: 0 });

  const workersRef = useRef<Worker[]>([]);
  const inbox = useRef<TileResult[]>([]);
  const focus = useRef(new THREE.Vector3(0, 0, 0));
  const pending = useRef(DEFAULT_SIZE); // latest dragged size, committed on release
  const commitTimer = useRef<number | undefined>(undefined);

  // Spawn the worker pool and load the compiled scene on every thread: each worker
  // voxelizes tiles (in parallel), the main thread answers height/bounds queries
  // for the camera. The view is ready once ALL workers have loaded their copy.
  useEffect(() => {
    let readyCount = 0;
    let world: Awaited<ReturnType<typeof initTerrain>> | null = null;

    const tryReady = () => {
      if (readyCount < POOL_SIZE || !world) return;
      // Spawn on the highest land, but inside the same edge-margin the camera
      // roams within (so the view never opens on the map rim from frame one).
      const [minX, minZ, maxX, maxZ] = world.bounds;
      const m = mapTheme.view.edgeMargin;
      const mx = Math.min(m, (maxX - minX) * 0.4);
      const mz = Math.min(m, (maxZ - minZ) * 0.4);
      // Spawn at the region centre (varied mid-elevation terrain) so the opening
      // view shows the hypsometric range, not just snow on the highest peak.
      const sx = (minX + maxX) / 2;
      const sz = (minZ + maxZ) / 2;
      focus.current.set(
        THREE.MathUtils.clamp(sx, minX + mx, maxX - mx),
        0,
        THREE.MathUtils.clamp(sz, minZ + mz, maxZ - mz),
      );
      // The pyramid's zoom range sets the LOD: coarsest voxel = minZoom tile,
      // finest = maxZoom tile. Drive the slider + clipmap from those.
      const [finest, coarsest] = world.voxelRange;
      mapTheme.view.baseVoxel = coarsest;
      setBounds(world.bounds);
      setMinSize(finest);
      setMaxSize(coarsest);
      setVoxelSize(finest);
      setApplied(finest);
      pending.current = finest;
      setStatus('ready');
    };

    const workers: Worker[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(new URL('./voxelWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          readyCount++;
          tryReady();
        } else if (msg.type === 'tile') {
          inbox.current.push({ ...msg, widx: i }); // tag the producing worker
        } else if (msg.type === 'error') {
          setError(msg.message);
          setStatus('error');
        }
      };
      worker.postMessage({ type: 'load', url: MANIFEST_URL } satisfies ToWorker);
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
        setStatus('error');
      });

    return () => {
      for (const w of workers) w.terminate();
    };
  }, []);

  // While dragging, only the label moves — re-streaming happens once on RELEASE
  // (pointer/key/touch up), so the worker is never flooded with intermediate
  // sizes. A long fallback timer covers a missed release event.
  const onSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const size = Number(e.target.value);
    setVoxelSize(size);
    pending.current = size;
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => setApplied(pending.current), COMMIT_FALLBACK_MS);
  };
  const commit = () => {
    window.clearTimeout(commitTimer.current);
    setApplied(pending.current);
  };

  const onStats = useMemo(
    () => (tiles: number, voxels: number) => setStats({ tiles, voxels }),
    [],
  );

  return (
    <div className="app">
      {status === 'ready' && bounds && workersRef.current.length > 0 && (
        <Stage
          voxelSize={applied}
          focus={focus}
          bounds={bounds}
          workers={workersRef.current}
          inbox={inbox}
          onStats={onStats}
        />
      )}

      <div className="panel">
        <h1>Vishwakarma · India</h1>
        <p className="sub">Real terrain voxelized in the browser from a streamed Web-Mercator height-tile pyramid, with distance LOD as you roam.</p>

        <label className="control">
          <span className="row">
            <span>Voxel size</span>
            <strong>{voxelSize.toFixed(2)}</strong>
          </span>
          <input
            type="range"
            min={minSize}
            max={maxSize}
            step={STEP}
            value={voxelSize}
            onChange={onSlider}
            onPointerUp={commit}
            onKeyUp={commit}
            onTouchEnd={commit}
            disabled={status !== 'ready'}
          />
          <span className="hint">
            <span>fine</span>
            <span>coarse</span>
          </span>
        </label>

        <div className="stats">
          <span>{stats.voxels ? `${stats.voxels.toLocaleString()} voxels` : '—'}</span>
          <span className="badge">{stats.tiles} cells</span>
        </div>

        {status === 'loading' && <p className="status">Loading compiled scene…</p>}
        {status === 'error' && <p className="status err">Error: {error}</p>}

        <p className="tip">Drag or W A S D to roam · shift-drag or Q E to turn</p>
      </div>
    </div>
  );
}
