import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';
import { GLOBE_R } from './globe';
import Skydome from './Skydome';
import LightingRig from './LightingRig';
import RoamControls from './RoamControls';
import TileField from './TileField';
import PolarCaps from './PolarCaps';
import PostFx from './PostFx';
import type { TileResult } from '../voxelTypes';

interface Props {
  voxelSize: number;
  focus: React.MutableRefObject<THREE.Vector3>;
  bounds: [number, number, number, number];
  workers: Worker[];
  inbox: React.MutableRefObject<TileResult[]>;
}

// Owns the <Canvas>. The camera orbits the globe; RoamControls drives near/far per
// frame to span surface-roam → whole-globe, so this far is only the initial value
// (large enough to see across the globe before the first frame updates it).
export default function Stage({ voxelSize, focus, bounds, workers, inbox }: Props) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 760;
  const far = 4 * GLOBE_R;
  return (
    <Canvas
      dpr={isMobile ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 20, 0], fov: 55, near: 0.1, far }}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMappingExposure: mapTheme.post.exposure }}
      onCreated={({ scene }) => {
        // Clear to the dark space colour so any uncovered edge (or the instant before
        // the starfield draws) reads as deep space, not a bright seam.
        scene.background = new THREE.Color(mapTheme.palette.skyTop);
      }}
    >
      <Skydome />
      <LightingRig />
      <RoamControls focus={focus} bounds={bounds} />
      <TileField voxelSize={voxelSize} focus={focus} bounds={bounds} workers={workers} inbox={inbox} />
      <PolarCaps />
      <PostFx enabled={!isMobile} voxelSize={voxelSize} />
    </Canvas>
  );
}
