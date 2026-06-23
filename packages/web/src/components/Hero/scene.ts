import * as THREE from 'three';
import { playEntrance } from './anime-three';
import { createParticles } from './effect';

export interface HeroHandle {
  dispose: () => void;
}

const DPR_CAP = 2;

/**
 * Mounts the WebGL hero into `container`. Client-only — call from a browser effect.
 * Owns its renderer, RAF loop, and listeners, and tears all of it down on dispose().
 * Pauses rendering when the tab is hidden; caps device-pixel-ratio for fill-rate.
 */
export function mountHero(container: HTMLElement): HeroHandle {
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, DPR_CAP);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  camera.position.z = 8.4;

  const count = width < 700 ? 1400 : 2800;
  const particles = createParticles(count, pixelRatio);
  scene.add(particles.points);

  const entrance = playEntrance(camera, particles.material);

  // Pointer parallax with damping.
  const pointerTarget = new THREE.Vector2(0, 0);
  const pointerCurrent = new THREE.Vector2(0, 0);
  const onPointerMove = (e: PointerEvent) => {
    pointerTarget.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h);
    particles.uniforms.uPixelRatio.value = pr;
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let raf = 0;
  let running = true;
  let elapsed = 0;

  const render = () => {
    raf = requestAnimationFrame(render);
    if (!running) return;
    elapsed += clock.getDelta();
    particles.uniforms.uTime.value = elapsed;

    pointerCurrent.lerp(pointerTarget, 0.04);
    particles.uniforms.uPointer.value.copy(pointerCurrent);

    particles.points.rotation.y = elapsed * 0.02 + pointerCurrent.x * 0.1;
    particles.points.rotation.x = pointerCurrent.y * 0.08;

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(render);

  const onVisibility = () => {
    running = document.visibilityState === 'visible';
    if (running) clock.getDelta(); // discard the hidden gap so elapsed doesn't jump
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      entrance.pause();
      particles.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
