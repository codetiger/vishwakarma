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
const MAX_LEVELS = 6;
// Split a cell when the 3D distance from the camera reference to its center is
// under this × the cell's world size — so detail sharpens toward the camera and
// coarsens with distance. It also sets the finest size reached at full zoom-in:
// the look-at foreground sits ~`altitude` from the reference, reaching level 0
// (voxel = the slider size `s`) once `altitude < SPLIT_FACTOR × 32 × s`.
// RoamControls' min altitude is ≈ cameraHeight × ZOOM_MIN ≈ 12, so at 2.2 the
// 0.3 default resolves fully; finer sizes resolve at lower altitude. Raising it
// reaches finer sizes sooner but multiplies the tiles the worker must stream —
// keep it modest so streaming stays smooth.
const SPLIT_FACTOR = 2.2;
// Extra, altitude-INDEPENDENT refinement around the look-at: a cell also splits
// while its HORIZONTAL distance from the look-at is under this × its size. This
// guarantees the ground right where you look always reaches level 0 (= the
// selected voxel size) at any zoom, so the slider always has a visible effect —
// without it, camera altitude caps the foreground at a coarse level and fine
// sizes do nothing. Tied to the cell size, so the fine patch is a bounded cell
// count (≈ π·FINE_FACTOR² level-0 cells) however fine the voxel size gets, and
// it gives a smooth voxel ∝ horizontal-distance falloff out from the look-at.
// 5.0 = 2× the foreground fine radius of the original 2.5 (≈4× the fine cells).
const FINE_FACTOR = 5.0;
const BACK_MARGIN = 40; // world units behind the camera kept before culling

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
  onStats?: (cells: number, voxels: number) => void;
}

export default function TileField({ voxelSize, focus, bounds, workers, inbox, onStats }: Props) {
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
    const { baseVoxel, cellCols, maxRadius } = mapTheme.view;
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
    const Lmax = Math.min(MAX_LEVELS - 1, Math.max(0, Math.round(Math.log2(Math.max(baseVoxel / s, 1)))));
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
    // LOD reference point R: over the ground point the camera LOOKS at (ahead of
    // the eye by the oblique look distance, clamped so it never runs off to the
    // horizon). Anchoring R over the look-at — not the eye — keeps the finest
    // detail in the visible foreground rather than under the camera (which falls
    // off the bottom of the screen at this tilt). `altitude` is the vertical leg
    // of the camera→tile distance below, folding zoom into the LOD with one cheap
    // term — no per-cell terrain sampling. World forward is the display forward
    // with z un-negated.
    const altitude = Math.max(camera.position.y - terrainHeight(ex, ez), 1);
    const lookDist = Math.min(altitude / Math.tan(mapTheme.view.pitch), maxRadius);
    const rx = ex + fwx * lookDist;
    const rz = ez - fwz * lookDist;

    // Walk the quadtree from the roots covering the view; mark visited + split,
    // and collect any cell that needs voxelizing.
    const req: { key: string; level: number; d: number }[] = [];
    const visit = (L: number, ix: number, iz: number) => {
      const cell = cellAt(L);
      const minX = ix * cell;
      const minZ = iz * cell;
      const maxX = minX + cell;
      const maxZ = minZ + cell;
      if (maxX <= wMinX || minX >= wMaxX || maxZ <= wMinZ || minZ >= wMaxZ) return; // off-map
      const key = `${L}_${ix}_${iz}`;
      let n = map.get(key);
      if (!n) {
        n = { level: L, ix, iz, voxel: voxelAt(L), mesh: null, requested: false, visited: false, culled: false, shouldSplit: false, childrenCover: false };
        map.set(key, n);
      }
      n.visited = true;
      const cx = (ix + 0.5) * cell;
      const cz = (iz + 0.5) * cell;
      // Cull only when the WHOLE cell is behind the camera (center minus its own
      // size), so a large cell straddling the camera isn't dropped — that left a
      // flickering void strip in front. Culled cells keep their mesh as a fallback
      // for turning back, but aren't refined/requested/drawn.
      n.culled = (cx - ex) * fwx + (ez - cz) * fwz < -(BACK_MARGIN + cell);
      if (n.culled) {
        n.shouldSplit = false;
        return;
      }
      // A cell refines for either of two reasons:
      //  • 3D camera distance (horizontal-from-look-at + altitude) under
      //    SPLIT_FACTOR × cell — the zoom-coupled term that coarsens the whole
      //    field as the camera rises; and
      //  • HORIZONTAL distance from the look-at under FINE_FACTOR × cell — an
      //    altitude-independent term that guarantees the ground you're looking at
      //    always reaches level 0 = the selected voxel size, so the slider always
      //    bites (otherwise altitude caps the foreground at a coarse level).
      const dh = Math.hypot(cx - rx, cz - rz);
      const d = Math.hypot(dh, altitude);
      n.shouldSplit = L > 0 && (d < SPLIT_FACTOR * cell || dh < FINE_FACTOR * cell);
      if (!n.mesh && !n.requested) req.push({ key, level: L, d: dh });
      if (n.shouldSplit) {
        visit(L - 1, 2 * ix, 2 * iz);
        visit(L - 1, 2 * ix + 1, 2 * iz);
        visit(L - 1, 2 * ix, 2 * iz + 1);
        visit(L - 1, 2 * ix + 1, 2 * iz + 1);
      }
    };

    const rootCell = cellAt(Lmax);
    const i0 = Math.floor((ex - maxRadius) / rootCell);
    const i1 = Math.floor((ex + maxRadius) / rootCell);
    const k0 = Math.floor((ez - maxRadius) / rootCell);
    const k1 = Math.floor((ez + maxRadius) / rootCell);
    const roots: string[] = [];
    for (let ix = i0; ix <= i1; ix++) {
      for (let iz = k0; iz <= k1; iz++) {
        const d = Math.max(Math.abs((ix + 0.5) * rootCell - ex), Math.abs((iz + 0.5) * rootCell - ez));
        if (d > maxRadius + rootCell) continue;
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
        blendRadius: mapTheme.view.colorBlendRadius,
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

    let cells = 0;
    let voxels = 0;
    for (const n of map.values()) {
      if (n.mesh && n.mesh.visible) { cells++; voxels += n.mesh.count; }
    }
    // While swapping density, the retired meshes are what's on screen.
    for (const m of retired.current) { cells++; voxels += m.count; }
    onStats?.(cells, voxels);
  });

  return <group ref={groupRef} />;
}
