// The single art-direction surface, ported from the mahabharata map. Tune the
// whole look here — palette, lighting, fog, post FX, curved-horizon strength,
// and the camera/scene framing — without touching the scene-graph logic.
//
// Per-voxel terrain colour is the hypsometric ramp baked in by the voxel worker
// (src/voxel/buildMesh.ts), so the data-driven biome/role colour maps from the
// original theme are dropped here; only the environment colours remain.

export interface MapTheme {
  palette: {
    water: string;
    /** Fallback backdrop colour shown until the equirectangular sky map loads (and
     *  if it fails). Near-black — the sky map is the feature. */
    skyTop: string;
  };
  /** Deep-space backdrop: a world-fixed equirectangular sky map set as
   *  `scene.background` (the asset lives in `public/textures/`, loaded by
   *  `Skydome.tsx`). */
  space: {
    /** `scene.backgroundIntensity` — brightness of the sky map (subtle ≈ 0.4). */
    intensity: number;
    /** `scene.backgroundRotation` Euler [x, y, z] in radians — a fixed celestial
     *  tilt to frame the Milky Way band. */
    rotation: [number, number, number];
  };
  lighting: {
    keyColor: string;
    keyIntensity: number;
    /** Cool fill light from behind, balancing the warm key. */
    fillColor: string;
    fillIntensity: number;
    ambient: number;
    hemiSky: string;
    hemiGround: string;
    hemiIntensity: number;
  };
  post: {
    enabled: boolean;
    bloomIntensity: number;
    bloomThreshold: number;
    vignette: number;
    /** ACES-filmic tone-mapping exposure (applied in the post chain). */
    exposure: number;
    /** Screen-space ambient occlusion (N8AO) — contact darkening in the creases
     *  between cube faces. */
    ao: {
      intensity: number;
      /** Sample radius in voxel edges: the world-space radius is
       *  `radiusVoxels × the rendered voxel size`, so the occlusion is sized to
       *  the cubes and scales with them (a few cube-widths reaches into the
       *  creases where stepped faces meet). */
      radiusVoxels: number;
      distanceFalloff: number;
      /** Compute AO at half resolution (cheaper, slightly softer). */
      halfRes: boolean;
      /** Occlusion tint, hex (e.g. the ground-bounce colour). */
      color: string;
    };
    /** Floor for the baked per-voxel AO folded into instance colour at build
     *  time: `1` = baked AO off, `0` = AO may fully darken. This is the
     *  macro-cavity term (whole valleys, off-screen occluders) that the
     *  screen-space `ao` above cannot reach. */
    aoFloor: number;
  };
  /** Geospatial orbit view: the camera orbits a focus point on the GLOBE; the
   *  whole area is covered by a coarse `baseVoxel` base, and detail sharpens in
   *  concentric rings toward the focus. Each cell renders at exactly one
   *  resolution (no overlap). All distances are world units; the flat clipmap is
   *  bent onto the sphere by the curvature.ts vertex shader. */
  view: {
    /** Coarsest voxel size — the base layer covering the whole visible area, and
     *  the slider's maximum. */
    baseVoxel: number;
    /** Voxel columns per cell edge. Cell world size = cellCols × that level's
     *  voxel size, so columns-per-cell (and thus per-cell cost) is constant while
     *  coarser levels get proportionally bigger cells — the far field is a handful
     *  of big coarse cells, not thousands of small ones. */
    cellCols: number;
    /** Quadtree LOD depth = number of zoom levels the clipmap bridges from the
     *  finest voxel (maxZoom) up to the whole-area coarse base (minZoom). Set at
     *  load from the manifest's zoom span (`maxZoom − minZoom + 1`) so the coarse
     *  root cell stays large however deep the pyramid goes — a fixed cap would
     *  collapse the base into thousands of root cells at high maxZoom. */
    lodLevels: number;
    /** Number of cells (per level) the finest LOD disk spans from the look-at, and
     *  the band-radius unit for the 3-level clipmap. Bigger = a larger fine area
     *  on screen and proportionally more streamed cells. */
    lodBandCells: number;
    /** Bring the finest detail in EARLIER (at higher altitude) by this many octaves,
     *  so tiles sharpen sooner as you zoom in instead of only at deep zoom. Each +1
     *  shifts the whole altitude→level curve one notch finer, i.e. the finest level
     *  (and every level) engages at ~2× the altitude. Reference points for this
     *  pyramid's zoom range: `0` = default (finest only near minAltitude, ~full
     *  zoom); `2` ≈ finest at ~67% zoom; `3` ≈ finest at the 50% zoom midpoint.
     *  HEAVY: the fine disk grows with altitude, so each +1 roughly QUADRUPLES the
     *  finest-disk cell/draw-call count — raise with care. */
    lodBias: number;
    /** Near reference distance (world units). Also the pan-speed scale base. */
    cameraHeight: number;
    /** The radial altitude at which the LOD reaches its finest level (L0 = 0);
     *  also sets the closest orbit distance (D_MIN = minAltitude / sin(pitch)). */
    minAltitude: number;
    /** Opening / default downward look angle, radians. Seeds the user-adjustable
     *  tilt (middle-drag changes it) and is the angle the compass reset eases back
     *  to. pitch = π/2 looks straight down (nadir); pitch → 0 looks at the horizon. */
    pitch: number;
    /** Tilt limits for middle-drag (radians). pitchMin ≈ near-horizon "from the
     *  ground plane" view; pitchMax ≈ nadir (kept a hair off π/2 so the camera-up
     *  basis never collapses). */
    pitchMin: number;
    pitchMax: number;
    /** Middle-drag vertical sensitivity: radians of tilt per pixel dragged. */
    tiltSpeed: number;
    /** Guard on how fine the slider may go (per-cell dense-grid budget). */
    maxCellVoxels: number;
    /** Outer zoom limit as a multiple of the globe radius (D_MAX = maxDistR·R) —
     *  far enough to frame the whole globe in space, no region cap. */
    maxDistR: number;
    /** Opening orbit distance as a multiple of the globe radius. */
    initialDistR: number;
    /** Zoom-toward-cursor strength (0 = zoom to centre, 1 = snap focus to cursor). */
    cursorBias: number;
    /** Straighten the tilt to top-down as you zoom out: below `straightenNearR·R`
     *  the camera honours the user's tilt (oblique surface roam); above
     *  `straightenFarR·R` the effective pitch is forced to nadir, so the eye pulls
     *  radially up over the area (top-down, area centred). Smoothstep between them. */
    straightenNearR: number;
    straightenFarR: number;
  };
}

// Celestial Manuscript — the map at golden dusk falling into a cosmic night.
export const mapTheme: MapTheme = {
  palette: {
    water: "#27496b", // deep indigo water
    skyTop: "#01030a", // the void — fallback until the sky map loads
  },
  space: {
    intensity: 0.4, // subtle: the sky sits behind the terrain, bloom lifts the brightest stars
    rotation: [0.0, 0.0, 0.3], // tilt the Milky Way band off horizontal
  },
  lighting: {
    keyColor: "#ffe1b0", // low moon-gold key
    keyIntensity: 1.35,
    fillColor: "#9fc0e8", // cool blue fill from behind
    fillIntensity: 0.4,
    ambient: 0.4,
    hemiSky: "#cdd6f4", // cool starlight from above
    hemiGround: "#2a2438", // violet ground bounce
    hemiIntensity: 0.55,
  },
  post: {
    enabled: true,
    bloomIntensity: 0.45,
    bloomThreshold: 0.82,
    vignette: 0.5,
    exposure: 1.0,
    ao: {
      intensity: 2.0,
      // World-space radius = radiusVoxels × the rendered voxel size, so AO is
      // sized to the cubes: ~2.5 cube-widths reaches into the creases between
      // stepped faces without washing across flat tops.
      radiusVoxels: 2.5,
      distanceFalloff: 1.0,
      halfRes: true,
      color: "#2a2438", // violet ground bounce (matches hemiGround)
    },
    aoFloor: 0.55,
  },
  view: {
    baseVoxel: 3.0,
    cellCols: 12, // columns per tile. Bigger cells ⇒ fewer InstancedMesh draw calls
    // (each covers ~(12/8)²≈2.25× the area), paid for by more voxels per cell — fine
    // now that the GPU places every box from per-instance attributes (no main-thread
    // per-voxel loop; see buildMesh.ts/curvature.ts). The fine-disk CELL count is
    // ~π·lodBandCells² (independent of cellCols), so lodBandCells is trimmed below to
    // keep the fine voxel budget + detail radius ~steady while draw calls drop.
    // Tuning knob: 12–16 trades draw calls for per-cell voxels (validate FPS +
    // renderer.info.render.calls on target hardware).
    lodLevels: 6, // overwritten at load from the manifest zoom span (App.tsx)
    lodBandCells: 6, // finest-disk radius in cells. Trimmed 8→6 alongside cellCols
    // 8→12 so the fine disk's world radius (∝ cellCols·lodBandCells) stays ~steady
    // while the fine-disk draw-call count (∝ lodBandCells²) drops ~45%.
    lodBias: 2, // detail appears ~2 octaves (≈67% zoom) earlier; 3 ≈ the 50% zoom midpoint but ~4× heavier
    cameraHeight: 30, // near reference distance + pan-speed base
    minAltitude: 5, // closest the eye flies above ground → LOD shows the finest level (L0=0)
    pitch: 0.95, // ~54° down — opening/default tilt (user changes it with middle-drag)
    pitchMin: 0.18, // ~10° above horizon — the "from the ground plane" tilt limit
    pitchMax: 1.55, // ≈ π/2 − 0.02 — nadir (top-down), kept off the up-vector singularity
    tiltSpeed: 0.006, // middle-drag: radians of tilt per pixel of vertical drag
    maxCellVoxels: 30_000_000,
    maxDistR: 6, // zoom out to 6× the globe radius (whole globe in the starfield)
    initialDistR: 3.2, // open framed on the globe (with starfield margin) so it's visible
    cursorBias: 0.5, // zoom toward the cursor (Google-Earth feel)
    straightenNearR: 0.5, // below 0.5×R: honour the user's tilt (oblique roam)
    straightenFarR: 2.2, // above 2.2×R: force nadir (top-down on the area, centred)
  },
};
