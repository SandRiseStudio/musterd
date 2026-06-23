import * as THREE from 'three';
import fragmentShader from './shaders/particles.frag.glsl';
import vertexShader from './shaders/particles.vert.glsl';

interface HeroUniforms {
  uTime: { value: number };
  uProgress: { value: number };
  uSize: { value: number };
  uPixelRatio: { value: number };
  uPointer: { value: THREE.Vector2 };
  uColor: { value: THREE.Color };
  uColorCore: { value: THREE.Color };
}

export interface Particles {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  uniforms: HeroUniforms;
  dispose: () => void;
}

const MUSTARD = new THREE.Color('#e1ad01');
const CORE = new THREE.Color('#fff3d0');

/**
 * A drifting field of mustard points. The geometry is a flattened ellipsoid so the
 * field fills a wide viewport; per-point seed + scale attributes give each point its
 * own drift and size. `uProgress` / `uSize` are animated on entrance by anime.js.
 */
export function createParticles(count: number, pixelRatio: number): Particles {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Point in a flattened ellipsoid (wider in x/y than z).
    const r = Math.cbrt(Math.random()); // uniform-ish density toward the surface
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r * 6.2;
    positions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r * 3.8;
    positions[i * 3 + 2] = Math.cos(phi) * r * 2.6;

    seeds[i * 3] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();

    // Mostly small points, a sparse few large/bright ones (pow biases toward 0).
    scales[i] = 0.35 + Math.pow(Math.random(), 6) * 2.4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

  const uniforms: HeroUniforms = {
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uSize: { value: 1.0 },
    uPixelRatio: { value: pixelRatio },
    uPointer: { value: new THREE.Vector2(0, 0) },
    uColor: { value: MUSTARD.clone() },
    uColorCore: { value: CORE.clone() },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // The literal `uniforms` is structurally valid; ShaderMaterial just wants an index signature.
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
  });

  const points = new THREE.Points(geometry, material);

  return {
    points,
    material,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
