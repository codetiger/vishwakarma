// Globe geometry — the single source of truth for mapping the FLAT Web-Mercator
// world (worldBounds [0,0,3600,3600] world units, z increasing north) onto a 3D
// sphere. The GPU vertex shader in curvature.ts mirrors `flatToECEF` EXACTLY
// (same global mercator origin, same lon/lat math), so KEEP THE TWO IN SYNC the
// way the tile decoders are kept in sync. The CPU camera (RoamControls) places
// itself with these helpers; the GPU places the geometry with the matching
// shader — both land in the same ECEF space, so eye and ground agree.
//
// Assumes a GLOBAL pyramid: the flat origin is the mercator SW corner (-E,-E), so
// the full map spans one equatorial circumference and wraps to a closed sphere.
// (A globe only makes sense for a world pyramid; manifest.world === true.)

import * as THREE from 'three';
import { E, WORLD_SCALE_XZ } from '../voxel/proj';

// Full mercator square width in world units = equatorial circumference.
const MAP_SPAN = (2 * E) / WORLD_SCALE_XZ; // = 3600
// Radius chosen so the equator circumference equals the flat map width, i.e. the
// flat map wraps once around the globe with no scale change at the equator.
export const GLOBE_R = MAP_SPAN / (2 * Math.PI); // ≈ 572.96 world units

const HALF_PI = Math.PI / 2;

/** Flat world (x, z) → geographic [lon, lat] in radians. Global mercator origin:
 *  x=0 → lon=−π, x=MAP_SPAN → lon=+π; z=0 → lat≈−85°, z=MAP_SPAN → lat≈+85°. */
export function worldToLonLat(x: number, z: number): [number, number] {
  const lon = (x * WORLD_SCALE_XZ - E) * (Math.PI / E);
  const mny = (z * WORLD_SCALE_XZ - E) * (Math.PI / E);
  const lat = 2 * Math.atan(Math.exp(mny)) - HALF_PI;
  return [lon, lat];
}

/** Inverse of worldToLonLat: geographic [lon, lat] (radians) → flat world (x, z). */
export function lonLatToWorld(lon: number, lat: number): [number, number] {
  const mercX = (lon / Math.PI) * E;
  const mercY = (Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) * E;
  return [(mercX + E) / WORLD_SCALE_XZ, (mercY + E) / WORLD_SCALE_XZ];
}

/** Unit sphere direction for a geographic lon/lat. North pole = +Y; lon=0 → +Z. */
function dirFromLonLat(lon: number, lat: number, out: THREE.Vector3): THREE.Vector3 {
  const cosLat = Math.cos(lat);
  return out.set(cosLat * Math.sin(lon), Math.sin(lat), cosLat * Math.cos(lon));
}

/** Flat world (x, z) + height h (world Y units) → ECEF position on the sphere. */
export function flatToECEF(x: number, z: number, h: number, out: THREE.Vector3): THREE.Vector3 {
  const [lon, lat] = worldToLonLat(x, z);
  dirFromLonLat(lon, lat, out);
  return out.multiplyScalar(GLOBE_R + h);
}

/** ECEF position → flat world (x, z). (Height = |p|−R is not returned.) */
export function ecefToFlat(p: THREE.Vector3): [number, number] {
  const r = p.length() || 1;
  const lat = Math.asin(THREE.MathUtils.clamp(p.y / r, -1, 1));
  const lon = Math.atan2(p.x, p.z);
  return lonLatToWorld(lon, lat);
}

export interface ENU {
  east: THREE.Vector3;
  north: THREE.Vector3;
  up: THREE.Vector3;
}

/** Local East/North/Up orthonormal basis at a flat world (x, z) point. */
export function enuBasis(x: number, z: number, out: ENU): ENU {
  const [lon] = worldToLonLat(x, z);
  flatToECEF(x, z, 0, out.up).normalize(); // radial = up
  out.east.set(Math.cos(lon), 0, -Math.sin(lon)); // ∂dir/∂lon, already unit
  out.north.crossVectors(out.up, out.east).normalize(); // up × east = north
  return out;
}

// Web-Mercator latitude limit (±85.05°): beyond this z leaves the map.
const LAT_LIMIT = 2 * Math.atan(Math.exp(Math.PI)) - HALF_PI;

export interface CapBounds {
  xC: number; // flat x of the cap centre (sub-eye longitude)
  xHalf: number; // longitude half-extent in flat units (≤ MAP_SPAN/2)
  zMin: number; // south flat z (Mercator-correct)
  zMax: number; // north flat z (Mercator-correct)
}

/** Flat-Mercator bounding box of the spherical cap of angular radius `capAngle`
 *  centred on the eye's nadir (the visible region from an ECEF eye). The latitude
 *  band is converted through the Mercator stretch (so it widens correctly near the
 *  poles), and the longitude half-extent is the cap's true longitude reach. Used to
 *  drive the clipmap root scan so the visible globe is fully covered at every
 *  latitude (a single isotropic flat radius under-covers near the poles). */
export function visibleCapBounds(eye: THREE.Vector3, capAngle: number, out: CapBounds): CapBounds {
  const r = eye.length() || 1;
  const latE = Math.asin(THREE.MathUtils.clamp(eye.y / r, -1, 1));
  const lonE = Math.atan2(eye.x, eye.z);
  // Latitude band, clamped to the Mercator data limit so z stays on the map.
  const latN = Math.min(latE + capAngle, LAT_LIMIT);
  const latS = Math.max(latE - capAngle, -LAT_LIMIT);
  out.zMax = lonLatToWorld(0, latN)[1];
  out.zMin = lonLatToWorld(0, latS)[1];
  // Longitude reach of the cap: if it touches a pole it spans all longitudes.
  const cosLatE = Math.cos(latE);
  const s = Math.sin(capAngle);
  const dLon = s >= cosLatE ? Math.PI : Math.asin(THREE.MathUtils.clamp(s / cosLatE, -1, 1));
  out.xHalf = GLOBE_R * dLon; // dx/dlon = MAP_SPAN/(2π) = GLOBE_R
  out.xC = lonLatToWorld(lonE, 0)[0];
  return out;
}

/** Round-trip + radius sanity (no DOM/THREE-renderer needed). Returns true if OK. */
export function selfTest(): boolean {
  const tmp = new THREE.Vector3();
  let ok = true;
  for (const [x, z] of [[100, 200], [1800, 1800], [3000, 500], [50, 3550]] as const) {
    flatToECEF(x, z, 0, tmp);
    const [rx, rz] = ecefToFlat(tmp);
    if (Math.abs(rx - x) > 1e-2 || Math.abs(rz - z) > 1e-2) ok = false;
  }
  flatToECEF(1800, 1800, 0, tmp);
  if (Math.abs(tmp.length() - GLOBE_R) > 1e-6) ok = false;
  // Cap bounds: an eye over (lon 0, lat 0) sees a finite, ordered, symmetric box.
  const cap: CapBounds = { xC: 0, xHalf: 0, zMin: 0, zMax: 0 };
  visibleCapBounds(tmp.set(0, 0, 2 * GLOBE_R), Math.acos(0.5), cap);
  if (!(cap.xHalf > 0 && cap.zMax > cap.zMin && Number.isFinite(cap.xC))) ok = false;
  return ok;
}
