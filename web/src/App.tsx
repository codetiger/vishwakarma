import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import Stage from "./scene/Stage";
import { mapTheme } from "./mapTheme";
import { initTerrain, setHeightScale } from "./terrain";
import { curveUniforms } from "./scene/curvature";
import { cameraControls } from "./scene/cameraControls";
import { DEFAULT_PALETTE, PALETTES, paletteStops, type PaletteId } from "./voxel/buildMesh";
import type { FromWorker, ToWorker, TileResult } from "./voxelTypes";

// Terrain colour palettes offered in the panel dropdown. The ids must match the
// keys in PALETTES (src/voxel/buildMesh.ts) where the actual ramps are defined.
const PALETTE_OPTIONS: { id: PaletteId; label: string }[] = [
  { id: "atlas", label: "Atlas" },
  { id: "terrain", label: "Terrain" },
  { id: "grayscale", label: "Grayscale" },
  { id: "viridis", label: "Viridis" },
  { id: "inferno", label: "Inferno" },
];

// A horizontal CSS gradient (low → high elevation) straight from a palette's
// stops, so the dropdown swatches are the exact ramp the voxels are coloured with.
const paletteGradient = (stops: PaletteStops): string => {
  const lo = stops[0][0];
  const span = stops[stops.length - 1][0] - lo || 1;
  const parts = stops.map(
    ([m, r, g, b]) =>
      `rgb(${r}, ${g}, ${b}) ${(((m - lo) / span) * 100).toFixed(1)}%`,
  );
  return `linear-gradient(to right, ${parts.join(", ")})`;
};
type PaletteStops = (typeof PALETTES)[PaletteId];
const PALETTE_GRADIENTS = Object.fromEntries(
  PALETTE_OPTIONS.map((p) => [p.id, paletteGradient(PALETTES[p.id])]),
) as Record<PaletteId, string>;

// Extra LOD octaves ABOVE the pyramid's coarsest level. The clipmap's pyramid-
// coarse cell (~56 world units) would need thousands of cells to tile the whole
// 3600-unit globe; these extra levels make big root cells that sparsely sample the
// coarsest tile, so the zoomed-out globe is a handful of cells, not thousands.
const GLOBE_EXTRA_LEVELS = 4;

// Voxelize tiles across a pool of workers (one per spare core, capped) so dense
// near-camera tiles stream in parallel instead of one at a time.
const POOL_SIZE = Math.max(
  1,
  Math.min((navigator.hardwareConcurrency || 4) - 1, 4),
);

const DEFAULT_SIZE = 0.5; // placeholder until the manifest sets the real finest size

// Tile/manifest base, resolved to an ABSOLUTE url. The voxel worker's own base is
// /assets/, so a relative `./pyramid/...` would fetch from there (404) — the main
// thread and worker must agree on the same absolute manifest + tile urls.
// Defaults to the app-bundled `public/pyramid/`; set VITE_TILE_BASE to a CDN /
// object-store url for the world-scale pyramid (~1 GB, too big to bundle). A
// trailing slash is required so `manifest.json` + the tile paths resolve against it.
const RAW_TILE_BASE =
  import.meta.env.VITE_TILE_BASE ||
  new URL(`${import.meta.env.BASE_URL}pyramid/`, document.baseURI).href;
const TILE_BASE = RAW_TILE_BASE.endsWith("/")
  ? RAW_TILE_BASE
  : `${RAW_TILE_BASE}/`;
const MANIFEST_URL = new URL("manifest.json", TILE_BASE).href;

// Compass dial: a two-tone needle whose amber tip points to true north (rotates
// with the live heading from the control bridge); click to ease back to north.
function Compass() {
  const [heading, setHeading] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setHeading(cameraControls.heading);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <button
      className="compass"
      aria-label="Reset north"
      title="Reset north"
      onClick={() => cameraControls.resetNorth()}
    >
      <svg viewBox="-22 -22 44 44" width="44" height="44" aria-hidden="true">
        <circle className="compass-ring" cx="0" cy="0" r="19" />
        <g transform={`rotate(${(-heading * 180) / Math.PI})`}>
          <polygon className="needle-n" points="0,-15 4.5,1 0,-2 -4.5,1" />
          <polygon className="needle-s" points="0,15 4.5,-1 0,2 -4.5,-1" />
        </g>
      </svg>
    </button>
  );
}

// Close a popover/menu on outside-click or Escape while it's open, so it never
// traps the pointer over the scene. Shared by the attribution popover and the
// palette dropdown (setters are stable, so the listeners attach only while open).
function useDismiss(
  open: boolean,
  setOpen: (v: boolean) => void,
  ref: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, ref]);
}

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
  // Selected hypsometric colour ramp. Changing it is a FREE shader stop-uniform swap
  // (below) — no re-voxelize, no worker round-trip — because the shader evaluates the
  // ramp per vertex from the stops, not baked into the tiles.
  const [palette, setPalette] = useState<PaletteId>(DEFAULT_PALETTE);

  // Palette feeds the renderer only through shared shader stop-uniforms (voxelization is
  // palette-independent), so the shader's rampColor evaluates the ramp exactly per vertex.
  // Set the default synchronously (before the scene first renders, so uStopCount is never
  // 0 under a cell), then swap on palette change — an instant recolour, no re-voxelize.
  useMemo(() => {
    curveUniforms.uAoFloor.value = mapTheme.post.aoFloor;
    const { data, count } = paletteStops(DEFAULT_PALETTE);
    curveUniforms.uStops.value = data;
    curveUniforms.uStopCount.value = count;
  }, []);
  useEffect(() => {
    const { data, count } = paletteStops(palette);
    curveUniforms.uStops.value = data; // fresh array → three re-uploads
    curveUniforms.uStopCount.value = count;
  }, [palette]);

  // Attribution popover (next to the GitHub icon) and the palette dropdown — both
  // anchored menus that dismiss on outside-click / Escape.
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  useDismiss(showInfo, setShowInfo, infoRef);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  useDismiss(paletteOpen, setPaletteOpen, paletteRef);

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
      // Open at the globe centre (lon 0, lat 0); the camera starts pulled back to
      // frame the whole globe (RoamControls' initialDistR).
      const [minX, minZ, maxX, maxZ] = world.bounds;
      focus.current.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
      // Bridge the pyramid's zoom span (finest = maxZoom, coarse base = minZoom) with
      // one quadtree level per zoom step, PLUS extra coarse octaves so the globe
      // overview stays a handful of big root cells. baseVoxel = the coarsest cell's
      // voxel so Lmax reaches the top level.
      const [finest, coarsest] = world.voxelRange;
      const span = Math.round(Math.log2(coarsest / finest)) + 1;
      mapTheme.view.lodLevels = span + GLOBE_EXTRA_LEVELS;
      mapTheme.view.baseVoxel = finest * 2 ** (mapTheme.view.lodLevels - 1);
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
        <div className="panel-actions">
          <div className="info-wrap" ref={infoRef}>
            <button
              className="info-btn"
              aria-label="Attributions"
              title="Attributions"
              aria-expanded={showInfo}
              onClick={() => setShowInfo((v) => !v)}
            >
              <svg
                viewBox="0 0 20 20"
                width="20"
                height="20"
                aria-hidden="true"
                focusable="false"
              >
                <circle
                  cx="10"
                  cy="10"
                  r="8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle cx="10" cy="6.2" r="1.05" fill="currentColor" />
                <rect
                  x="9"
                  y="8.6"
                  width="2"
                  height="5.4"
                  rx="1"
                  fill="currentColor"
                />
              </svg>
            </button>
            {showInfo && (
              <div className="info-popover" role="dialog" aria-label="Attributions">
                <p className="info-title">Data &amp; imagery</p>
                <p className="credit">
                  Elevation:{" "}
                  <a
                    href="https://www.ncei.noaa.gov/products/etopo-global-relief-model"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ETOPO 2022
                  </a>{" "}
                  (NOAA, public domain)
                </p>
                <p className="credit">
                  Sky:{" "}
                  <a
                    href="https://www.eso.org/public/images/eso0932a/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ESO/S. Brunier
                  </a>{" "}
                  (CC BY 3.0)
                </p>
              </div>
            )}
          </div>
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
        </div>
        <h1>Earth in Voxels</h1>
        <p className="sub">
          Explore real-world terrain as voxels. Elevation data streams in and
          rebuilds into a 3D landscape as you move, and more detail loads the
          closer you look.
        </p>
        {status === "ready" && (
          <>
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
            <div className="control">
              <label>Color palette</label>
              <div className="palette-select" ref={paletteRef}>
                <button
                  className="palette-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={paletteOpen}
                  onClick={() => setPaletteOpen((v) => !v)}
                >
                  <span
                    className="swatch"
                    style={{ background: PALETTE_GRADIENTS[palette] }}
                  />
                  <span className="palette-name">
                    {PALETTE_OPTIONS.find((p) => p.id === palette)?.label}
                  </span>
                  <span className="chev" aria-hidden="true" />
                </button>
                {paletteOpen && (
                  <ul className="palette-list" role="listbox">
                    {PALETTE_OPTIONS.map((p) => (
                      <li key={p.id}>
                        <button
                          role="option"
                          aria-selected={p.id === palette}
                          className={
                            "palette-opt" +
                            (p.id === palette ? " is-active" : "")
                          }
                          onClick={() => {
                            setPalette(p.id);
                            setPaletteOpen(false);
                          }}
                        >
                          <span
                            className="swatch"
                            style={{ background: PALETTE_GRADIENTS[p.id] }}
                          />
                          <span className="palette-name">{p.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
        {status === "error" && <p className="status err">Error: {error}</p>}
      </div>

      {status === "ready" && (
        <div className="view-controls">
          <Compass />
          <div className="zoom-stack">
            <button
              className="ctl-btn"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => cameraControls.zoomBy(0.8)}
            >
              +
            </button>
            <button
              className="ctl-btn"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => cameraControls.zoomBy(1.25)}
            >
              −
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
