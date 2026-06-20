import { mapTheme } from '../mapTheme';

// Warm "candlelit tabletop" lighting (ported from the mahabharata map). No
// shadows — keeps the curvature/perf budget and avoids a shadow-vs-curvature
// mismatch.
export default function LightingRig() {
  const { lighting } = mapTheme;
  return (
    <>
      <hemisphereLight args={[lighting.hemiSky, lighting.hemiGround, lighting.hemiIntensity]} />
      <ambientLight intensity={lighting.ambient} />
      <directionalLight position={[10, 16, 8]} intensity={lighting.keyIntensity} color={lighting.keyColor} />
      <directionalLight position={[-8, 6, -10]} intensity={lighting.fillIntensity} color={lighting.fillColor} />
    </>
  );
}
