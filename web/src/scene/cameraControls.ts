// Shared imperative bridge between the on-screen UI and RoamControls, mirroring
// the curveUniforms shared-singleton idiom. The UI calls intents (zoomBy,
// resetNorth); RoamControls applies them each frame and writes back live state
// the UI polls (the compass reads `heading`). TileField reads `surfaceAltitude`
// to drive the LOD (the camera now lives in ECEF, so camera.position.y is no
// longer an altitude). Keeping this out of React state avoids re-rendering the
// scene every frame.

export const cameraControls = {
  // --- live state, written by RoamControls each frame ---
  heading: 0, // radians, 0 = north-up (compass reads this)
  surfaceAltitude: 30, // eye height above the ground under the focus (LOD input)

  // --- intents, set by the UI and consumed+cleared by RoamControls ---
  _zoomFactor: 1, // pending multiplicative zoom (1 = none)
  _resetNorth: false, // pending snap-to-north request

  /** Multiply the orbit distance (UI +/− buttons). <1 zooms in, >1 zooms out. */
  zoomBy(factor: number): void {
    this._zoomFactor *= factor;
  },
  /** Ease the heading back to north (compass click). */
  resetNorth(): void {
    this._resetNorth = true;
  },
};
