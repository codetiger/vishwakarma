import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';
import { applyWorldCurvature } from './curvature';
import { terrainHeight } from '../terrain';
import type { FromWorker, ToWorker, TileResult } from '../voxelTypes';

// Quadtree LOD. The view is a quadtree of square cells centred on the camera:
// the coarsest level tiles the whole area (the always-present fallback), and a
// cell SPLITS into four finer children as the camera nears it. A parent stays
// visible until ALL of its children (recursively) are loaded, then they swap in
// atomically. So exactly ONE resolution ever renders for a given patch — no
// double-density overlap — and there is always a coarser fallback underneath, so
// nothing blinks to void while finer detail streams in. Each cell is its own
// InstancedMesh; visibility is toggled (not disposed) so swaps are instant.
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
const BACK_MARGIN = 40; // world units behind the camera kept before culling
// Cover terrain to ~this many round-world horizon distances. The horizon (where the
// curvature bends terrain a camera-height below the eye) is ≈ sqrt(altY / curvature);
// covering a bit past it fills the silhouette without a hard cull edge in the sky.
const HORIZON_K = 2.5;

interface Node {
  level: number;
  ix: number;
  iz: number;
  voxel: number;
  mesh: THREE.InstancedMesh | null;
  requested: boolean;
  visited: boolean;
  culled: boolean; // behind the camera — don't refine/draw, but keep as fallback
  shouldSplit: boolean;
  childrenCover: boolean;
}

function buildMesh(msg: TileMsg, material: THREE.Material): THREE.InstancedMesh {
  const { count, positions, colors, yScales, voxelSize } = msg;
  const mesh = new THREE.InstancedMesh(UNIT, material, Math.max(count, 1));
  // Frustum culling OFF: the round-world curvature (mapTheme.curvature) bends
  // far tiles DOWN in the vertex shader, but three's CPU cull tests the
  // undisplaced bounding sphere — so the very tiles that form the curved horizon
  // (flat position above the frustum top, curved position dipping into view)
  // would be wrongly culled and pop. The quadtree already bounds the drawn set.
  mesh.frustumCulled = false;
  const m = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < count; i++) {
    const o = 16 * i;
    const p = 3 * i;
    // X/Z extent is the voxel size; Y is per-voxel — surface voxels are stretched
    // so their top face meets the exact terrain height (their centre, in
    // positions[], is already placed for that height), the rest are voxelSize.
    m[o] = voxelSize; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = yScales[i]; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = voxelSize; m[o + 11] = 0;
    // negate z → north up (translation only; the cube itself is not mirrored)
    m[o + 12] = positions[p]; m[o + 13] = positions[p + 1]; m[o + 14] = -positions[p + 2]; m[o + 15] = 1;
  }
  mesh.instanceMatrix.needsUpdate = true;
  const c = new THREE.Color();
  const aoFloor = mapTheme.post.aoFloor;
  for (let i = 0; i < count; i++) {
    // Packed 0xAARRGGBB: sRGB in the low 24 bits (blended at voxelize time), the
    // baked ambient-occlusion byte (255 = open) in the top 8. Fold the AO straight
    // into the instance colour — the UNIT geometry is shared across every tile
    // mesh, so a per-instance attribute would force a geometry clone per tile;
    // folding into the colour is the instancing-friendly fit and stacks with the
    // screen-space AO in PostFx. (It dims albedo, so it also dims what Bloom sees
    // — intended for the stylised look.)
    const packed = colors[i];
    const ao = ((packed >>> 24) & 0xff) / 255;
    const f = aoFloor + (1 - aoFloor) * ao; // aoFloor = 1 → baked AO off
    c.setRGB(
      (((packed >> 16) & 0xff) / 255) * f,
      (((packed >> 8) & 0xff) / 255) * f,
      ((packed & 0xff) / 255) * f,
      THREE.SRGBColorSpace,
    );
    mesh.setColorAt(i, c);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.count = count;
  return mesh;
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
  const fwd = useRef(new THREE.Vector3());
  // Previous-density meshes held on screen during a density change, until the new
  // grid fully covers the view and we swap atomically (no drop to the coarse base).
  const retired = useRef<THREE.InstancedMesh[]>([]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0, flatShading: true });
    applyWorldCurvature(mat, mapTheme.curvature);
    return mat;
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const { baseVoxel, cellCols, maxRadius, lodLevels, lodBandCells, minAltitude, pitch, lodBias } = mapTheme.view;
    const [wMinX, wMinZ, wMaxX, wMaxZ] = bounds;
    const s = voxelSize;
    const ex = focus.current.x;
    const ez = focus.current.z;
    const map = nodes.current;
    if (inflight.current.length !== workers.length) {
      inflight.current = new Array(workers.length).fill(0);
    }

    // Slider changed ⇒ the cell grid (cell = cellCols·voxel) moved, so the old
    // nodes don't map onto the new grid and must be rebuilt. Instead of wiping the
    // screen, RETIRE the currently-visible meshes: keep them rendered as a frozen
    // fallback while the new-density grid streams in behind them (hidden), then
    // swap atomically once it covers the view (below). So changing density keeps
    // the current detail up and improves from there — never a coarse flash.
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
          group.remove(n.mesh);
          n.mesh.dispose();
        }
      }
      map.clear();
      inflight.current.fill(0);
      inbox.current.length = 0;
      lastS.current = s;
    }

    const C0 = cellCols * s; // level-0 cell world size
    const Lmax = Math.min(lodLevels - 1, Math.max(0, Math.round(Math.log2(Math.max(baseVoxel / s, 1)))));
    const cellAt = (L: number) => C0 * 2 ** L;
    const voxelAt = (L: number) => s * 2 ** L;
    const childKeys = (L: number, ix: number, iz: number) => [
      `${L - 1}_${2 * ix}_${2 * iz}`,
      `${L - 1}_${2 * ix + 1}_${2 * iz}`,
      `${L - 1}_${2 * ix}_${2 * iz + 1}`,
      `${L - 1}_${2 * ix + 1}_${2 * iz + 1}`,
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
        if (n.mesh) { group.remove(n.mesh); n.mesh.dispose(); }
        n.mesh = buildMesh(msg, material);
        n.mesh.visible = false; // visibility decided below
        group.add(n.mesh);
      }
      inbox.current.length = 0;
    }

    // Camera forward in the (z-negated) display plane, for the behind-camera cull.
    camera.getWorldDirection(fwd.current);
    const flen = Math.hypot(fwd.current.x, fwd.current.z) || 1;
    const fwx = fwd.current.x / flen;
    const fwz = fwd.current.z / flen;
    // Altitude above the ground beneath the eye (scene Y units). This DRIVES the LOD:
    // L0 = the finest level shown anywhere. Descend → L0 drops → the whole visible
    // field sharpens uniformly. minAltitude calibrates L0=0 (finest) at the lowest the
    // camera flies; cap at lodLevels-3 so L0, L0+1, L0+2 all stay ≤ Lmax.
    // lodBias shifts the curve finer by N octaves so detail engages EARLIER (at higher
    // altitude) — finest is then reached ~lodBias octaves of zoom sooner.
    const altY = Math.max(camera.position.y - terrainHeight(ex, ez), 0.001);
    const L0 = THREE.MathUtils.clamp(Math.round(Math.log2(altY / minAltitude)) - lodBias, 0, lodLevels - 3);
    // Reference point R = the ground point at SCREEN-CENTRE. In the (vertically
    // exaggerated) scene the centre ray hits the ground altY/tan(pitch) ahead — raw
    // scene units — so the detail lands out in front where you look, not under the eye.
    const lookDist = Math.min(altY / Math.tan(pitch), maxRadius);
    const rx = ex + fwx * lookDist;
    const rz = ez - fwz * lookDist;
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
    // Render out to (just past) the round-world horizon so the far terrain curves down
    // to a clean edge against the starfield; bounded by maxRadius. Falls back to the
    // full region radius if curvature is disabled.
    const coverRadius = Math.min(maxRadius, HORIZON_K * Math.sqrt(altY / Math.max(mapTheme.curvature, 1e-6)));

    // Walk the quadtree from the roots covering the view; mark visited + split,
    // and collect any cell that needs voxelizing.
    const req: { key: string; level: number; d: number }[] = [];
    const visit = (L: number, ix: number, iz: number) => {
      const cell = cellAt(L);
      const minX = ix * cell;
      const minZ = iz * cell;
      const maxX = minX + cell;
      const maxZ = minZ + cell;
      const offMap = maxX <= wMinX || minX >= wMaxX || maxZ <= wMinZ || minZ >= wMaxZ;
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
      // Cull when the whole cell is behind the camera, OR beyond the 3-band reach
      // (distance from R, using the cell's own size as margin so a big root straddling
      // the bands isn't dropped). Culled cells draw nothing — the haze covers them.
      const dh = Math.hypot(cx - rx, cz - rz);
      const behind = (cx - ex) * fwx + (ez - cz) * fwz < -(BACK_MARGIN + cell);
      n.culled = behind || dh - cell >= coverRadius;
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

    // Scan the coarse roots covering the visible region around R (out to the horizon):
    // zoomed in coverRadius is small so this is a handful of roots; zoomed out it grows
    // to the region. The per-cell cull above prunes anything beyond coverRadius.
    const rootCell = cellAt(Lmax);
    const scanR = coverRadius + rootCell;
    const i0 = Math.floor((rx - scanR) / rootCell);
    const i1 = Math.floor((rx + scanR) / rootCell);
    const k0 = Math.floor((rz - scanR) / rootCell);
    const k1 = Math.floor((rz + scanR) / rootCell);
    const roots: string[] = [];
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = k0; iz <= k1; iz++) {
        const d = Math.hypot((ix + 0.5) * rootCell - rx, (iz + 0.5) * rootCell - rz);
        if (d - rootCell > coverRadius) continue;
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
        for (const m of retired.current) {
          group.remove(m);
          m.dispose();
        }
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
        if (n.mesh) { group.remove(n.mesh); n.mesh.dispose(); }
        map.delete(key);
      }
    }
  });

  return <group ref={groupRef} />;
}
