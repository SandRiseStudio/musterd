import { createTimeline } from 'animejs';
import 'animejs/adapters/three';
import type * as THREE from 'three';

/**
 * The entrance, driven by anime.js through the three.js adapter (animejs 4.5+).
 * The adapter lets anime.js target three objects directly — camera position and the
 * ShaderMaterial's uniforms — so the dolly-in and the particle bloom run on one timeline.
 */
export function playEntrance(camera: THREE.PerspectiveCamera, material: THREE.ShaderMaterial) {
  const tl = createTimeline({ defaults: { ease: 'outExpo' } });

  // Camera dolly-in (adapter maps `z` → camera.position.z).
  tl.add(camera, { z: [8.4, 6.0], duration: 2400 }, 0);

  // Particle bloom (adapter maps uniform names directly onto the material).
  tl.add(material, { uProgress: [0, 1], duration: 2600, ease: 'outQuart' }, 0);
  tl.add(material, { uSize: [0.2, 1.0], duration: 2200, ease: 'outQuart' }, 150);

  return tl;
}
