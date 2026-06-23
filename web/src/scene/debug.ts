// Hidden debug overlay — toggle with the backtick (`) key. Lets you read the live
// camera pose (to reproduce an exact view when reporting an artifact) and flip render
// debug flags (wireframe / AO / post / LOD-level tint) to localize rendering issues.
//
// Shared singleton, mirroring the cameraControls idiom: RoamControls + TileField write
// the live metrics each frame; App's overlay polls them via requestAnimationFrame and
// owns the flag checkboxes. Non-React consumers (TileField, the shader) read the flags
// here so a toggle takes effect without prop threading.
export const debug = {
  // --- render flags (set by the overlay checkboxes) ---
  wireframe: false, // show the raw voxel geometry as wireframe
  levelTint: false, // tint each cell by its LOD level (overlaps/levels become obvious)
  noAO: false, // disable screen-space N8AO
  noPost: false, // disable the whole post-processing chain

  // --- live metrics (written each frame) ---
  pitchDeg: 90, // effective tilt: 90 = top-down (nadir), 0 = horizon
  headingDeg: 0, // 0 = north up, +clockwise
  distR: 0, // orbit distance ÷ globe radius
  altitude: 0, // eye height above the ground under the focus (world units)
  lon: 0, // focus longitude (deg)
  lat: 0, // focus latitude (deg)
  L0: 0, // finest LOD level shown anywhere this frame
  cells: 0, // visible voxel cells (≈ per-cell draw calls)
};
