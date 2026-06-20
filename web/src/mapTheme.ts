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
    /** Deep-space backdrop: skyTop = zenith (near-black), skyHorizon = a touch lighter
     *  low in the sky. Both dark — the starfield is the feature, not a gradient. */
    skyTop: string;
    skyHorizon: string;
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
  /** round-world signature: larger = horizon falls away sooner. */
  curvature: number;
  /** Distance-based LOD clipmap view: the camera roams just above the terrain
   *  (height locked to the surface below it); the whole area is covered by a
   *  coarse `baseVoxel` base, and detail sharpens in concentric rings toward the
   *  camera. Each cell renders at exactly one resolution (no overlap). All
   *  distances are world units; rendering is 1:1 with world space. */
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
    /** Load cells out to this radius from the focus (≈ camera far reach). */
    maxRadius: number;
    /** Eye height above the (smoothed) terrain directly beneath it. */
    cameraHeight: number;
    /** Camera altitude range above terrain (world Y units). minAltitude also sets
     *  the altitude at which the LOD shows the finest level (L0 = 0); maxAltitude
     *  the coarse-overview ceiling. The wheel zoom maps onto this range. */
    minAltitude: number;
    maxAltitude: number;
    /** Downward look angle, radians (fixed pitch — terrain-independent aim). */
    pitch: number;
    /** Guard on how fine the slider may go (per-cell dense-grid budget). */
    maxCellVoxels: number;
    /** Eye inset from the map edge (world units), fixed at every zoom so the
     *  framing doesn't jump as you zoom and coastal regions stay reachable.
     *  Small enough to roam right up to the coast; the world rim beyond curves
     *  down (round-world shader) into the starfield. Auto-capped to 40% of each
     *  span. */
    edgeMargin: number;
  };
}

// Celestial Manuscript — the map at golden dusk falling into a cosmic night.
export const mapTheme: MapTheme = {
  palette: {
    water: "#27496b", // deep indigo water
    skyTop: "#01030a", // the void at zenith
    skyHorizon: "#070b18", // a touch lighter low in the sky (subtle, the stars carry it)
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
  // Slight round-world bend: the patch under the eye stays level and the rim
  // falls away in every direction, so the far edge curves down into the haze
  // instead of ending as a flat sea cut against the sky. Larger = sooner.
  curvature: 0.0009,
  view: {
    baseVoxel: 3.0,
    cellCols: 8, // columns per tile: smaller ⇒ cheaper tiles that stream in faster
    // & more incrementally (the worker pool absorbs the higher tile count), finer
    // LOD granularity, and a finer reachable voxel size (the min-size budget ∝
    // cellCols²). Trade-off: more tiles ⇒ more draw calls and a thicker apron share
    // per tile — bump back toward 12–16 if draw-call count hurts the frame rate.
    lodLevels: 6, // overwritten at load from the manifest zoom span (App.tsx)
    lodBandCells: 8, // finest-disk radius in cells; bigger = more fine area + more tiles
    lodBias: 2, // detail appears ~2 octaves (≈67% zoom) earlier; 3 ≈ the 50% zoom midpoint but ~4× heavier
    maxRadius: 360,
    cameraHeight: 30, // base eye altitude above terrain (zoom scales it)
    minAltitude: 5, // closest the eye flies above ground → LOD shows the finest level (L0=0)
    maxAltitude: 80, // coarse-overview ceiling → LOD shows the coarsest of its 3 levels
    pitch: 0.95, // ~54° down — Google-Earth-like tilt
    maxCellVoxels: 30_000_000,
    edgeMargin: 30,
  },
};
