import { EffectComposer, Bloom, Vignette, N8AO, ToneMapping, SMAA } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';

// Post chain, in render order:
//   N8AO       — screen-space ambient occlusion: contact darkening in the creases
//                between cube faces the direct lights can't reach (the single
//                biggest win for making flat-shaded cubes read as solid terrain).
//                Its world-space radius is sized to the voxel (see below).
//   Bloom      — a gentle glow on the marble peaks / snow.
//   ToneMapping— ACES filmic rolloff so the bloomed highlights don't clip (the
//                R3F-postprocessing composer renders to an HDR buffer and does
//                NOT apply the renderer's tone mapping for us — exposure comes
//                from gl.toneMappingExposure, set on the <Canvas> in Stage).
//   SMAA       — edge anti-aliasing: the composer bypasses the context's MSAA
//                (multisampling=0), so without this the high-contrast voxel
//                silhouettes alias badly.
//   Vignette   — a cosmic vignette.
const aoColor = new THREE.Color(mapTheme.post.ao.color);

export default function PostFx({ enabled = true, voxelSize }: { enabled?: boolean; voxelSize: number }) {
  if (!enabled || !mapTheme.post.enabled) return null;
  const { ao } = mapTheme.post;
  // World-space AO radius tied to the rendered cube size: a few voxel edges, so
  // the occlusion sits in the creases between adjacent cube faces and scales with
  // the voxels as the slider/LOD changes.
  const aoRadius = ao.radiusVoxels * voxelSize;
  return (
    <EffectComposer multisampling={0}>
      <N8AO
        aoRadius={aoRadius}
        distanceFalloff={ao.distanceFalloff}
        intensity={ao.intensity}
        halfRes={ao.halfRes}
        color={aoColor}
      />
      <Bloom
        intensity={mapTheme.post.bloomIntensity}
        luminanceThreshold={mapTheme.post.bloomThreshold}
        luminanceSmoothing={0.2}
        mipmapBlur
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
      <Vignette eskil={false} offset={0.3} darkness={mapTheme.post.vignette} />
    </EffectComposer>
  );
}
