import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';
import Skydome from './Skydome';
import LightingRig from './LightingRig';
import RoamControls from './RoamControls';
import TileField from './TileField';
import PostFx from './PostFx';
import type { TileResult } from '../voxelTypes';

interface Props {
  voxelSize: number;
  focus: React.MutableRefObject<THREE.Vector3>;
  bounds: [number, number, number, number];
  workers: Worker[];
  inbox: React.MutableRefObject<TileResult[]>;
  onStats?: (tiles: number, voxels: number) => void;
}

// Owns the <Canvas>. The camera roams just above the terrain; the far plane
// reaches past the LOD clipmap's outer radius so the distant coarse terrain is
// visible, fading into the radial fog (curvature-based, in the shared curvature
// shader — not linear scene fog).
export default function Stage({ voxelSize, focus, bounds, workers, inbox, onStats }: Props) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 760;
  const far = mapTheme.view.maxRadius + 60;
  return (
    <Canvas
      dpr={isMobile ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 20, 0], fov: 55, near: 0.1, far }}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMappingExposure: mapTheme.post.exposure }}
      onCreated={({ scene }) => {
        // Clear to the fog/sky horizon colour (not the dark sky top) so the
        // farthest fogged terrain blends into the backdrop with no seam even in
        // the instant before the Skydome draws or at any uncovered edge.
        scene.background = new THREE.Color(mapTheme.palette.skyHorizon);
      }}
    >
      <Skydome />
      <LightingRig />
      <RoamControls focus={focus} bounds={bounds} />
      <TileField voxelSize={voxelSize} focus={focus} bounds={bounds} workers={workers} inbox={inbox} onStats={onStats} />
      <PostFx enabled={!isMobile} voxelSize={voxelSize} />
    </Canvas>
  );
}
