import { useMemo } from 'react';
import * as THREE from 'three';
import { GLOBE_R } from './globe';

// Polar ice caps. Web-Mercator stops at ±85.05°, so the projected terrain leaves a
// circular gap at each pole. These two spherical-cap meshes fill the gaps with ice.
// They live directly in ECEF at sea-level radius (NOT through the sphere-projection
// shader — they're already 3D), tucked slightly under the terrain edge so the
// terrain renders over them where it exists.

const CAP_COLAT = (7 * Math.PI) / 180; // cap reaches down to ~83° lat (overlaps the ~85° edge)
const CAP_R = GLOBE_R * 0.999; // just under sea level so terrain wins where present

export default function PolarCaps() {
  const geom = useMemo(
    () => new THREE.SphereGeometry(CAP_R, 64, 8, 0, Math.PI * 2, 0, CAP_COLAT),
    [],
  );
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#dfe8f2', // pale polar ice
        roughness: 0.9,
        metalness: 0.0,
      }),
    [],
  );
  return (
    <>
      <mesh geometry={geom} material={material} />
      {/* south cap: flip the north cap to -Y */}
      <mesh geometry={geom} material={material} rotation={[Math.PI, 0, 0]} />
    </>
  );
}
