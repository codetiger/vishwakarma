import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';
import { applyVoxelShader, curveUniforms } from './curvature';
import { GLOBE_R, flatToECEF, visibleCapBounds, type CapBounds } from './globe';
import { cameraControls } from './cameraControls';
import { debug } from './debug';
import type { FromWorker, ToWorker, TileResult } from '../voxelTypes';

// Quadtree LOD. The view is a quadtree of square cells centred on the camera:
// the coarsest level tiles the whole area (the always-present fallback), and a
// cell SPLITS into four finer children as the camera nears it. A parent stays
// visible until ALL of its children (recursively) are loaded, then they swap in
// atomically. So exactly ONE resolution ever renders for a given patch — no
// double-density overlap — and there is always a coarser fallback underneath, so
// nothing blinks to void while finer detail streams in. Each cell is its own
// instanced box mesh fed by a per-cell height texture (the GPU builds + colours the
// voxels — see curvature.ts); visibility is toggled (not disposed) so swaps are instant.
//
// Cell world size scales with the voxel size (cell = cellCols × voxel), keeping
// per-cell cost constant; that ties the grid to the selected size, so changing
// the slider rebuilds the tree (infrequent — only on release).
//
// Voxel positions are world-space; the scene stores z south-up, so each cube's
// z is negated on placement to put north at the top (a translation only — cubes
// are symmetric, so winding/normals are untouched).

type TileMsg = Extract<FromWorker, { type: 'tile' }>;

const UNIT = new THREE.BoxGeometry(1, 1, 1);
// One shared instance-id attribute (0 .. cellCols²-1), reused by every cell — so the
// only per-cell GPU resource is the height texture. It also gives three an instanced
// attribute, so it draws cellCols² instances. cellCols is constant, so this is built
// once and shared by reference (detached, not freed, in disposeCell).
const CELL_COLS = mapTheme.view.cellCols;
const IDS = new Float32Array(CELL_COLS * CELL_COLS);
for (let i = 0; i < IDS.length; i++) IDS[i] = i;
const ID_ATTR = new THREE.InstancedBufferAttribute(IDS, 1);
const WORKER_DEPTH = 2; // outstanding tiles per pool worker (1 running + 1 queued, so none idle)
// Quadtree depth is mapTheme.view.lodLevels — set at load from the manifest's zoom
// span so the clipmap always has exactly enough levels to bridge the finest voxel
// (maxZoom) up to the whole-area coarse base (minZoom).
//
// LOD model (altitude-driven, Google-Earth style): the camera ALTITUDE picks a base
// level L0 = the finest level shown anywhere; descend → L0 drops → the WHOLE visible
// field sharpens uniformly. Around the look-at R a fat disk renders at L0, then the
// field coarsens with distance up to the coarsest level, covering out to the round-
// world horizon so the far terrain curves down to a clean silhouette against the
// starfield (no fog). The disk radius scales with the cell size, so the near tile
// count stays ~constant at every altitude — the cells just get physically finer as
// you descend. This sidesteps the ~55× vertical exaggeration that makes a pure
// screen-space-error metric unable to ever reach the fine levels.
const BACK_MARGIN = 40; // world units behind the focus kept before culling
// Render slightly past the spherical horizon so the silhouette fills without a hard
// cull edge in the sky (used both for the per-cell cull and the root-scan cap).
const HORIZON_MARGIN = 0.06; // radians rendered past the horizon (limb terrain)
// View-frustum cull (so off-screen cells aren't requested/drawn): a cell's bounding
// sphere = cell·FRUSTUM_PAD (lateral half-extent ≥ the ~0.71 half-diagonal, plus a
// little preload slop) + the radial reach of exaggerated terrain. MAX_TERRAIN_WORLD is
// ETOPO's ±~10.7 km / WORLD_SCALE_Y (≈1.45), rounded up — a constant is fine for an
// Earth globe.
const FRUSTUM_PAD = 0.9;
const MAX_TERRAIN_WORLD = 1.6;

interface Node {
  level: number;
  ix: number;
  iz: number;
  voxel: number;
  mesh: THREE.Mesh | null;
  requested: boolean;
  visited: boolean;
  culled: boolean; // behind the camera — don't refine/draw, but keep as fallback
  shouldSplit: boolean;
  childrenCover: boolean;
}

// Build a cell as cellCols² unit-box instances driven by a per-cell height texture.
// The vertex shader (curvature.ts) derives each box (position, height, skirt, colour)
// from aId + the texture — no per-instance geometry on the CPU at all. The static box
// attributes + the instance-id attribute are SHARED by reference; the DataTexture and
// the small per-cell material (which carries this cell's minX/minZ/voxel + texture)
// are the only per-cell GPU resources. A plain Mesh + InstancedBufferGeometry still
// draws instanced (three checks isInstancedBufferGeometry at draw time).
function buildMesh(msg: TileMsg, minX: number, minZ: number, level: number): THREE.Mesh {
  const { count, side, texData, voxelSize } = msg;
  // RG float: R = height (metres) for the whole padded grid, G = baked AO. Nearest —
  // the shader reads exact texels (the column + its 4 neighbours).
  const tex = new THREE.DataTexture(texData, side, side, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
    wireframe: debug.wireframe, // debug overlay
  });
  applyVoxelShader(mat, {
    uHeightTex: { value: tex },
    uMinX: { value: minX },
    uMinZ: { value: minZ },
    uVoxel: { value: voxelSize },
    uLevel: { value: level }, // debug LOD-level tint
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(UNIT.index);
  g.setAttribute('position', UNIT.getAttribute('position'));
  g.setAttribute('normal', UNIT.getAttribute('normal'));
  g.setAttribute('uv', UNIT.getAttribute('uv'));
  g.setAttribute('aId', ID_ATTR);
  g.instanceCount = count;
  const mesh = new THREE.Mesh(g, mat);
  // Frustum culling OFF: the sphere projection (curvature.ts) moves vertices from
  // their flat position onto the globe in the vertex shader, but three's CPU cull
  // tests the undisplaced (flat) bounding sphere — so tiles whose flat position is
  // off-frustum but whose projected position is in view (the curved limb) would be
  // wrongly culled and pop. The quadtree already bounds the drawn set.
  mesh.frustumCulled = false;
  mesh.userData.heightTex = tex;
  return mesh;
}

// Tear down a cell mesh: pull it from the scene and free its per-cell GPU resources
// (the DataTexture + this cell's material). The static box attrs + the instance-id
// attr are SHARED, so detach them before dispose() — three's geometry.dispose() frees
// the GPU buffer of every attribute it still holds, and a shared one is in use by
// other cells.
function disposeCell(group: THREE.Group, mesh: THREE.Mesh): void {
  group.remove(mesh);
  const g = mesh.geometry;
  g.deleteAttribute('position');
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g.deleteAttribute('aId');
  g.setIndex(null);
  g.dispose();
  (mesh.material as THREE.Material).dispose();
  (mesh.userData.heightTex as THREE.Texture | undefined)?.dispose();
}

interface Props {
  voxelSize: number; // finest (selected) size
  focus: React.MutableRefObject<THREE.Vector3>; // shared LOD center = the eye (world)
  bounds: [number, number, number, number]; // [minX, minZ, maxX, maxZ]
  workers: Worker[];
  inbox: React.MutableRefObject<TileResult[]>;
}

export default function TileField({ voxelSize, focus, bounds, workers, inbox }: Props) {
  const camera = useThree((s) => s.camera);
  const groupRef = useRef<THREE.Group>(null);
  const nodes = useRef(new Map<string, Node>());
  const inflight = useRef<number[]>([]); // outstanding tiles per pool worker
  const reqId = useRef(0);
  const lastS = useRef(0);
  const cullDir = useRef(new THREE.Vector3()); // scratch: cell sphere direction
  const viewFwd = useRef(new THREE.Vector3()); // scratch: camera forward (ECEF)
  const capB = useRef<CapBounds>({ xC: 0, xHalf: 0, zMin: 0, zMax: 0 }); // scratch: visible cap bbox
  const frustum = useRef(new THREE.Frustum()); // scratch: ECEF view frustum (off-screen cull)
  const projScratch = useRef(new THREE.Matrix4()); // scratch: projection × view matrix
  const cellSphere = useRef(new THREE.Sphere()); // scratch: cell bounding sphere (ECEF)
  const wireRef = useRef(debug.wireframe); // last applied debug wireframe flag
  // Previous-density meshes held on screen during a density change, until the new
  // grid fully covers the view and we swap atomically (no drop to the coarse base).
  const retired = useRef<THREE.Mesh[]>([]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const { baseVoxel, cellCols, lodLevels, lodBandCells, minAltitude, lodBias } = mapTheme.view;
    const [wMinX, wMinZ, wMaxX, wMaxZ] = bounds;
    const spanX = wMaxX - wMinX; // map longitude span (wraps); = MAP_SPAN for a global pyramid
    const s = voxelSize;
    const ex = focus.current.x;
    const ez = focus.current.z;
    const map = nodes.current;
    if (inflight.current.length !== workers.length) {
      inflight.current = new Array(workers.length).fill(0);
    }

    // Voxel size changed ⇒ every cell must be rebuilt: a size change moves the cell
    // grid (cell = cellCols·voxel) so the old nodes don't map onto the new grid.
    // Instead of wiping the screen, RETIRE the currently-visible meshes: keep them
    // rendered as a frozen fallback while the new grid streams in behind them
    // (hidden), then swap atomically once it covers the view (below) — never a coarse
    // flash. (Palette no longer comes through here — colour is a shader-LUT uniform
    // swap now, so the live cells recolour in place with no re-voxelize.)
    if (s !== lastS.current) {
      const midSwap = retired.current.length > 0; // a previous change is still streaming
      for (const n of map.values()) {
        if (!n.mesh) continue;
        // Hold only what's actually on screen; drop hidden LOD layers, and — if a
        // change is already mid-swap — the half-built new grid we're superseding
        // (its meshes are hidden), keeping the original retired set on screen.
        if (!midSwap && n.mesh.visible) {
          retired.current.push(n.mesh); // stays in `group`, keeps rendering
        } else {
          disposeCell(group, n.mesh);
        }
      }
      map.clear();
      inflight.current.fill(0);
      inbox.current.length = 0;
      lastS.current = s;
    }

    const C0 = cellCols * s; // level-0 cell world size
    const Lmax = Math.min(lodLevels - 1, Math.max(0, Math.round(Math.log2(Math.max(baseVoxel / s, 1)))));
    // Periodic horizontal grid: each LOD level divides the globe's longitude span into
    // an integer number of columns (colsAt), so a cell's X index wraps cleanly modulo
    // that count. cellAt is derived as spanX/colsAt (EXACTLY periodic — column 0 and
    // column colsAt land on the identical longitude with no drift) rather than C0·2^L,
    // which need not divide spanX. This is what stops the same geographic column being
    // drawn at two different LOD levels. cellCols is a power of two, so colsAt(L-1) =
    // 2·colsAt(L) and children tile their parent seamlessly. Latitude (Z) is bounded —
    // it does NOT wrap (the polar gap is filled by PolarCaps), so iz stays raw.
    const colsAt = (L: number) => Math.max(1, Math.round(spanX / (C0 * 2 ** L)));
    const cellAt = (L: number) => spanX / colsAt(L);
    const voxelAt = (L: number) => s * 2 ** L;
    const wrapCol = (ix: number, L: number) => { const c = colsAt(L); return ((ix % c) + c) % c; };
    const childKeys = (L: number, ix: number, iz: number) => [
      `${L - 1}_${wrapCol(2 * ix, L - 1)}_${2 * iz}`,
      `${L - 1}_${wrapCol(2 * ix + 1, L - 1)}_${2 * iz}`,
      `${L - 1}_${wrapCol(2 * ix, L - 1)}_${2 * iz + 1}`,
      `${L - 1}_${wrapCol(2 * ix + 1, L - 1)}_${2 * iz + 1}`,
    ];

    for (const n of map.values()) n.visited = false;

    // Drain finished cells (build the mesh, replacing any prior one).
    if (inbox.current.length) {
      for (const msg of inbox.current) {
        inflight.current[msg.widx] = Math.max(0, inflight.current[msg.widx] - 1);
        const n = map.get(msg.key);
        if (!n) continue; // evicted
        n.requested = false;
        if (n.voxel !== msg.voxelSize) continue; // stale density
        if (n.mesh) disposeCell(group, n.mesh);
        const cell = cellAt(n.level);
        n.mesh = buildMesh(msg, n.ix * cell, n.iz * cell, n.level);
        n.mesh.visible = false; // visibility decided below
        group.add(n.mesh);
      }
      inbox.current.length = 0;
    }

    // Visibility on the globe is a SPHERICAL-HORIZON test against the ECEF eye: a
    // cell is visible iff its sphere direction lies inside the camera's visible cap
    // (dot(dirCell, dirEye) ≥ R/|eye|), plus an ECEF behind-camera cull. (The old
    // flat behind-plane / flat-distance culls wrongly removed the near southern
    // hemisphere on the globe.)
    const eye = camera.position;
    const de = eye.length() || 1;
    const dex = eye.x / de;
    const dey = eye.y / de;
    const dez = eye.z / de;
    // Camera's visible spherical cap: points within capAngle of the eye direction
    // are over the horizon. A cell is only culled if it lies ENTIRELY beyond the
    // cap — its own angular half-size is added to the threshold, so a big coarse
    // cell straddling the horizon still recurses to its (smaller) children instead
    // of pruning the visible part of the subtree.
    const capAngle = Math.acos(THREE.MathUtils.clamp(GLOBE_R / de, -1, 1));
    camera.getWorldDirection(viewFwd.current);
    // Build the world-space (ECEF) view frustum for off-screen culling. RoamControls
    // set the camera pose this frame, but matrixWorldInverse is otherwise only rebuilt
    // at render (a frame later), so refresh it now. heightReach = the radial extent of
    // exaggerated terrain, added to each cell's cull sphere below.
    camera.updateMatrixWorld();
    projScratch.current.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.current.setFromProjectionMatrix(projScratch.current);
    const heightReach = MAX_TERRAIN_WORLD * curveUniforms.uHeightScale.value;
    // Altitude above the globe surface beneath the focus (published by RoamControls).
    // This DRIVES the LOD: L0 = the finest level shown anywhere. Descend → L0 drops →
    // the whole visible field sharpens uniformly. minAltitude calibrates L0=0 (finest)
    // at the lowest the camera flies; cap at lodLevels-3 so L0, L0+1, L0+2 all stay ≤
    // Lmax. lodBias shifts the curve finer by N octaves so detail engages EARLIER.
    const altY = Math.max(cameraControls.surfaceAltitude, 0.001);
    const L0 = THREE.MathUtils.clamp(Math.round(Math.log2(altY / minAltitude)) - lodBias, 0, lodLevels - 3);
    // Reference point R = the focus itself (the geographic point at screen centre —
    // the camera looks straight at it), so detail is densest where you look.
    const rx = ex;
    const rz = ez;
    // Fat fine disk: render at L0 within band0 of R, then coarsen with distance. band0
    // scales by a CONTINUOUS altitude-proportional cell size (cellCont ≈ cellAt(L0) but
    // without the discrete round()), so the disk and the coverage glide with zoom/pan
    // instead of doubling each time L0 ticks over a threshold. cellCont MUST track L0's
    // own curve — same `- lodBias` shift and the SAME clamp — else the disk decouples
    // from the rendered cell size: with lodBias it runs 2^lodBias too wide (16× the
    // fine-cell count at lodBias=2), and once L0 pins to the finest level the disk keeps
    // growing linearly with altitude, carpeting the whole view in finest cells the
    // higher you fly. Mirror L0's clamp so the fine-cell count stays ~constant.
    const contLevel = THREE.MathUtils.clamp(Math.log2(altY / minAltitude) - lodBias, 0, lodLevels - 3);
    const cellCont = C0 * 2 ** contLevel;
    const band0 = lodBandCells * cellCont;
    // Cover the actual visible spherical cap, as a flat-Mercator bbox centred on the
    // eye's nadir. A single isotropic flat radius under-covers near the poles (Mercator
    // stretches latitude → holes); visibleCapBounds converts the latitude band through
    // the stretch so coverage is correct at every latitude. capAngle is the horizon
    // half-angle; HORIZON_MARGIN renders a little past the limb.
    visibleCapBounds(eye, Math.min(Math.PI, capAngle + HORIZON_MARGIN), capB.current);

    // Walk the quadtree from the roots covering the view; mark visited + split,
    // and collect any cell that needs voxelizing.
    const req: { key: string; level: number; d: number }[] = [];
    const visit = (L: number, ix: number, iz: number) => {
      ix = wrapCol(ix, L); // canonical column ⇒ one geographic column = one node = one mesh
      const cell = cellAt(L);
      const minZ = iz * cell;
      const maxZ = minZ + cell;
      // Only LATITUDE (Z) bounds the map — longitude (X) wraps at the antimeridian
      // (the sampler + shader wrap), so X-out-of-range cells render the far side
      // instead of leaving a seam. Z-out-of-range is the polar gap (capped meshes).
      const offMap = maxZ <= wMinZ || minZ >= wMaxZ;
      const key = `${L}_${ix}_${iz}`;
      let n = map.get(key);
      if (!n) {
        n = { level: L, ix, iz, voxel: voxelAt(L), mesh: null, requested: false, visited: false, culled: false, shouldSplit: false, childrenCover: false };
        map.set(key, n);
      }
      n.visited = true;
      // Off-map cells (past the region edge) count as covered but draw nothing. A
      // boundary parent whose children are partly off-map must still be able to hand
      // off to its on-map children; if off-map children were skipped entirely they'd
      // read as "not covered", so the parent would stay coarse and the edge never
      // refines. Treat them like culled cells (covered, no mesh).
      if (offMap) {
        n.culled = true;
        n.shouldSplit = false;
        return;
      }
      const cx = (ix + 0.5) * cell;
      const cz = (iz + 0.5) * cell;
      // Wrap-aware horizontal distance (shortest signed longitude delta): a column near
      // the focus gets a small dh regardless of which wrapped representation it is, so
      // every copy resolves to the SAME target level (and, with canonical keying, the
      // SAME node). Also fixes the antimeridian LOD seam.
      let dxh = cx - rx;
      dxh = ((dxh + spanX / 2) % spanX + spanX) % spanX - spanX / 2;
      const dh = Math.hypot(dxh, cz - rz);
      // Cull the far hemisphere (entirely beyond the spherical horizon) and cells
      // wholly behind the camera. Culled cells draw nothing; the starfield shows
      // through. Both tests carry the cell's own size as margin so a big cell that
      // straddles the boundary isn't dropped (its children get the finer test).
      flatToECEF(cx, cz, 0, cullDir.current).normalize();
      const facing = cullDir.current.x * dex + cullDir.current.y * dey + cullDir.current.z * dez;
      const cellHalfAngle = (cell * 0.72) / GLOBE_R; // ~half-diagonal arc of the cell
      const horizonThresh = Math.cos(Math.min(Math.PI, capAngle + HORIZON_MARGIN + cellHalfAngle));
      const px = cullDir.current.x * GLOBE_R - eye.x;
      const py = cullDir.current.y * GLOBE_R - eye.y;
      const pz = cullDir.current.z * GLOBE_R - eye.z;
      const behind =
        px * viewFwd.current.x + py * viewFwd.current.y + pz * viewFwd.current.z <
        -(BACK_MARGIN + cell);
      // Off-screen cull: the cell's projected (globe) bounding sphere vs the view
      // frustum, so cells outside the FOV aren't requested/voxelized/drawn. cullDir is
      // the unit cell-centre direction → ×GLOBE_R is its surface point. A big cell
      // straddling the frustum edge still intersects, so it recurses (children get the
      // tighter test). The coarse fallback covers any momentary edge gap while panning.
      cellSphere.current.center.copy(cullDir.current).multiplyScalar(GLOBE_R);
      cellSphere.current.radius = cell * FRUSTUM_PAD + heightReach;
      const offscreen = !frustum.current.intersectsSphere(cellSphere.current);
      n.culled = facing < horizonThresh || behind || offscreen;
      if (n.culled) {
        n.shouldSplit = false;
        return;
      }
      // Target level: L0 inside the fine disk (dh ≤ band0), coarsening one level per
      // doubling of distance beyond it, up to the coarsest. So the near/mid field is the
      // altitude-appropriate finest level (a fat disk, not a dot) and the far field
      // coarsens with distance to the horizon.
      const targetLevel = Math.min(lodLevels - 1, L0 + Math.max(0, Math.round(Math.log2(dh / band0))));
      n.shouldSplit = L > targetLevel;
      if (!n.mesh && !n.requested) req.push({ key, level: L, d: dh });
      if (n.shouldSplit) {
        visit(L - 1, 2 * ix, 2 * iz);
        visit(L - 1, 2 * ix + 1, 2 * iz);
        visit(L - 1, 2 * ix, 2 * iz + 1);
        visit(L - 1, 2 * ix + 1, 2 * iz + 1);
      }
    };

    // Scan the coarse roots over the visible cap. X iterates the periodic column grid so
    // each geographic column is visited exactly once (no double-draw across the wrap);
    // wrap-aware dh (above) gives every column correct focus-relative LOD regardless of
    // representation, so the scan can centre on the cap, not the focus. Z uses the cap's
    // absolute Mercator-correct latitude band, which extends far enough north/south near
    // the poles to avoid holes. The per-cell ECEF horizon cull prunes the far side. Root
    // cells are large by design (colsAt(Lmax) is tiny — a couple of cells wrap the globe).
    const rootCell = cellAt(Lmax);
    const nRootCols = colsAt(Lmax);
    const k0 = Math.floor((capB.current.zMin - rootCell) / rootCell);
    const k1 = Math.floor((capB.current.zMax + rootCell) / rootCell);
    // Distinct wrapped root columns covering the visible cap, each scanned ONCE — so a
    // geographic column is never drawn twice (the old flat-x window over-scanned past a
    // full longitude period and double-drew). When the cap reaches a pole its longitude
    // span is the whole globe (xHalf = spanX/2) → scan every column; otherwise scan the
    // contiguous band around the cap centre (±1 column margin) and dedupe via the wrap.
    // The per-cell horizon + frustum culls below prune the far side.
    let xCols: number[];
    if (capB.current.xHalf >= spanX / 2 - 1e-6 || nRootCols <= 4) {
      xCols = Array.from({ length: nRootCols }, (_, i) => i);
    } else {
      const lo = Math.floor((capB.current.xC - capB.current.xHalf) / rootCell) - 1;
      const hi = Math.floor((capB.current.xC + capB.current.xHalf) / rootCell) + 1;
      const seen = new Set<number>();
      xCols = [];
      for (let i = lo; i <= hi; i++) {
        const w = wrapCol(i, Lmax);
        if (!seen.has(w)) { seen.add(w); xCols.push(w); }
      }
    }
    const roots: string[] = [];
    for (const ix of xCols) {
      for (let iz = k0; iz <= k1; iz++) {
        visit(Lmax, ix, iz);
        if (map.get(`${Lmax}_${ix}_${iz}`)?.visited) roots.push(`${Lmax}_${ix}_${iz}`);
      }
    }

    // Request: coarsest (fallback) first, then nearest. Spread across the pool —
    // each tile goes to the least-loaded worker with a free slot, so every core
    // voxelizes in parallel and none idles; stop once all workers are full.
    req.sort((a, b) => b.level - a.level || a.d - b.d);
    for (const r of req) {
      let w = -1;
      let best = WORKER_DEPTH;
      for (let i = 0; i < workers.length; i++) {
        if (inflight.current[i] < best) {
          best = inflight.current[i];
          w = i;
        }
      }
      if (w === -1) break; // every worker at capacity this frame
      const n = map.get(r.key)!;
      const cell = cellAt(n.level);
      n.requested = true;
      inflight.current[w]++;
      workers[w].postMessage({
        type: 'voxelizeTile',
        id: ++reqId.current,
        key: r.key,
        minX: n.ix * cell,
        minZ: n.iz * cell,
        maxX: (n.ix + 1) * cell,
        maxZ: (n.iz + 1) * cell,
        voxelSize: n.voxel,
      } satisfies ToWorker);
    }

    // Pass A — coverage: a subtree "covers" its area if its children all cover,
    // else this node covers iff it has a mesh.
    const covers = (key: string): boolean => {
      const n = map.get(key);
      if (!n || !n.visited) return false;
      if (n.culled) return true; // off-screen — counts as covered, draws nothing
      let cc = false;
      if (n.shouldSplit) {
        cc = childKeys(n.level, n.ix, n.iz).every(covers);
      }
      n.childrenCover = cc;
      return cc || n.mesh != null;
    };

    // Pass B — visibility: show the finest fully-loaded layer; the parent stays
    // visible (fallback) until all children cover, then the children take over.
    const setVis = (key: string, ancestorShown: boolean) => {
      const n = map.get(key);
      if (!n || !n.visited) return;
      if (n.culled) { if (n.mesh) n.mesh.visible = false; return; } // behind camera
      const kids = n.shouldSplit ? childKeys(n.level, n.ix, n.iz) : null;
      if (ancestorShown) {
        if (n.mesh) n.mesh.visible = false;
        kids?.forEach((k) => setVis(k, true));
        return;
      }
      if (n.shouldSplit && n.childrenCover) {
        if (n.mesh) n.mesh.visible = false;
        kids!.forEach((k) => setVis(k, false));
      } else {
        if (n.mesh) n.mesh.visible = true;
        kids?.forEach((k) => setVis(k, true)); // hide descendants under this layer
      }
    };

    // Coverage for every root; the new grid is "ready" once it covers the view.
    let ready = true;
    for (const rk of roots) {
      if (!covers(rk)) ready = false;
    }

    if (retired.current.length > 0) {
      // Mid density change: keep the retired (previous-density) meshes on screen
      // and the new grid hidden until it fully covers the view, then swap in one
      // frame. (If the camera roams far before that, the new grid simply finishes
      // covering the new view before the swap — the old detail holds until then.)
      if (ready) {
        for (const m of retired.current) disposeCell(group, m);
        retired.current = [];
        for (const rk of roots) setVis(rk, false);
      } else {
        for (const n of map.values()) if (n.mesh) n.mesh.visible = false;
      }
    } else {
      for (const rk of roots) setVis(rk, false);
    }

    // Evict anything out of view this frame.
    for (const [key, n] of map) {
      if (!n.visited) {
        if (n.mesh) disposeCell(group, n.mesh);
        map.delete(key);
      }
    }

    // Debug overlay: publish LOD metrics + apply the live debug render flags.
    debug.L0 = L0;
    let vcells = 0;
    for (const c of group.children) if (c.visible) vcells++;
    debug.cells = vcells;
    curveUniforms.uDebugTint.value = debug.levelTint ? 1 : 0;
    if (wireRef.current !== debug.wireframe) {
      wireRef.current = debug.wireframe;
      for (const c of group.children) {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m) m.wireframe = debug.wireframe;
      }
    }
  });

  return <group ref={groupRef} />;
}
