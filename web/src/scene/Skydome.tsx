import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mapTheme } from '../mapTheme';

// Deep-space backdrop: a WORLD-FIXED equirectangular sky map (ESO/S. Brunier "The
// Milky Way panorama", CC BY 3.0) set as `scene.background`. three.js renders an
// equirectangular background at infinity in a constant world orientation, so the
// globe (world-fixed in ECEF) and the sky share one frame — orbit the planet and
// the stars track exactly, no parallax and no fudge rotation. It flows through the
// post chain, so Bloom lifts the brightest stars (the subtle-realistic look) and
// N8AO ignores it (no depth). Tune brightness + tilt via `mapTheme.space`.
// Loaded from public/textures/ via the BASE_URL idiom so GitHub Pages sub-paths work.
const SKY_URL = new URL(
  `${import.meta.env.BASE_URL}textures/space.jpg`,
  document.baseURI,
).href;

export default function Skydome() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const fallback = new THREE.Color(mapTheme.palette.skyTop);
    let tex: THREE.Texture | null = null;
    let cancelled = false;

    new THREE.TextureLoader().load(SKY_URL, (loaded) => {
      if (cancelled) {
        loaded.dispose();
        return;
      }
      tex = loaded;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.anisotropy = gl.capabilities.getMaxAnisotropy();
      scene.background = tex;
      scene.backgroundIntensity = mapTheme.space.intensity;
      scene.backgroundRotation = new THREE.Euler(...mapTheme.space.rotation);
    });

    return () => {
      cancelled = true;
      if (scene.background === tex) scene.background = fallback;
      tex?.dispose();
    };
  }, [scene, gl]);

  return null;
}
