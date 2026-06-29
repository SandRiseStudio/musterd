import * as THREE from 'three';

/**
 * The live constellation as a real three.js scene (ADR-less UI work): members are glowing 3D nodes,
 * directed exchanges are curved arcs, the active arc carries a comet. Glow comes from additive sprite
 * textures (no fragile post-processing). A projected HTML overlay carries crisp labels. Client-only —
 * mounted from a browser effect; owns its renderer, RAF, listeners, and tears them down on dispose().
 */

export interface GLNode {
  name: string;
  kind: 'agent' | 'human';
  online: boolean;
  working: boolean;
  label: string | null;
  /** This member's unique colour (an `hsl()` string) — used for the node glow. */
  color: string;
}
export interface GLEdge {
  from: string;
  to: string;
  active: boolean;
}
export interface GLData {
  nodes: GLNode[];
  edges: GLEdge[];
}

/** A live event to animate: a directed message (pulse along its arc), a team broadcast (ripple from
 * the sender), or a resolve (a green pulse + a settle ripple at the recipient). */
export type SceneEvent =
  | { kind: 'pulse'; from: string; to: string; color: string }
  | { kind: 'ripple'; from: string; color: string }
  | { kind: 'settle'; from: string; to: string; color: string };

export interface ConstellationHandle {
  update: (data: GLData) => void;
  emit: (ev: SceneEvent) => void;
  dispose: () => void;
}

const DPR_CAP = 2;
const R = 2.55; // ring radius (world units)

const C_MUSTARD = new THREE.Color('#f2c83e');
const C_OFFLINE = new THREE.Color('#80715f');

/** ease-in-out cubic — gentle accelerate/decelerate for a smoother comet glide. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function radialTexture(stops: [number, string][]): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}
function ringTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function nodePos(i: number, n: number): THREE.Vector3 {
  if (n <= 1) return new THREE.Vector3(0, 0, 0);
  const a = (i / n) * Math.PI * 2 - Math.PI / 2;
  return new THREE.Vector3(R * Math.cos(a), R * Math.sin(a) * 0.92, Math.sin(i * 1.7) * 0.55);
}

interface NodeObj {
  group: THREE.Group;
  halo: THREE.Sprite;
  core: THREE.Sprite;
  ring: THREE.Sprite;
  label: HTMLDivElement;
  data: GLNode;
  hot: number; // 0..1 hover lift
  breath: number; // phase
}

export function mountConstellation(
  host: HTMLElement,
  labelHost: HTMLElement,
  reduced: boolean,
): ConstellationHandle {
  let width = host.clientWidth || 1;
  let height = host.clientHeight || 1;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, DPR_CAP);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 100);
  const root = new THREE.Group(); // rotated by parallax
  scene.add(root);

  // Keep the whole ring in frame at any panel size: set the camera distance to fit the ring's *height*
  // (the panel is always tall), then horizontally *squish* the field to fit narrow panels — so nodes
  // and their arcs never clip off the sides when the window shrinks.
  function fitCamera() {
    width = host.clientWidth || 1;
    height = host.clientHeight || 1;
    camera.aspect = width / height;
    const tanH = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const need = R * 1.18; // ring extent + glow/label margin
    camera.position.z = need / tanH;
    camera.updateProjectionMatrix();
    const halfW = camera.position.z * tanH * camera.aspect;
    root.scale.x = Math.min(1, halfW / need);
    renderer.setSize(width, height);
  }
  fitCamera();

  const glowTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.22, 'rgba(255,255,255,0.82)'],
    [0.5, 'rgba(255,255,255,0.22)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const coreTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.4, 'rgba(255,255,255,0.95)'],
    [0.75, 'rgba(255,255,255,0.4)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const ringTex = ringTexture();

  // — warm dust field —
  const dustCount = 520;
  const dpos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dpos[i * 3] = (Math.random() - 0.5) * 11;
    dpos[i * 3 + 1] = (Math.random() - 0.5) * 8;
    dpos[i * 3 + 2] = (Math.random() - 0.5) * 5 - 1.5;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.05,
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color('#e7b67a'),
    opacity: 0.5,
    sizeAttenuation: true,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  root.add(dust);

  const nodes = new Map<string, NodeObj>();
  let arcs: THREE.Mesh[] = [];
  let activeCurve: THREE.QuadraticBezierCurve3 | null = null;

  // — comet pulse —
  const pulse = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: coreTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: C_MUSTARD }),
  );
  pulse.scale.setScalar(0.28);
  pulse.visible = false;
  root.add(pulse);

  function colorFor(n: GLNode): THREE.Color {
    if (!n.online) return C_OFFLINE;
    return new THREE.Color(n.color); // each member's unique colour (ADR-less UI; format.memberColor)
  }

  function makeNode(n: GLNode): NodeObj {
    const group = new THREE.Group();
    const col = colorFor(n);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: col.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }),
    );
    halo.scale.setScalar(1.5);
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: coreTex, color: col.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    core.scale.setScalar(0.5);
    const ring = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ringTex, color: C_MUSTARD.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }),
    );
    ring.scale.setScalar(0.92);
    group.add(halo, ring, core);
    group.renderOrder = 2;

    const label = document.createElement('div');
    label.className = 'lc-gl-label';
    labelHost.appendChild(label);

    return { group, halo, core, ring, label, data: n, hot: 0, breath: Math.random() * 6 };
  }

  function applyNodeColors(o: NodeObj) {
    const col = colorFor(o.data);
    (o.halo.material as THREE.SpriteMaterial).color.copy(col);
    (o.core.material as THREE.SpriteMaterial).color.copy(o.data.online ? col.clone().lerp(new THREE.Color('#ffffff'), 0.25) : col);
  }

  function clearArcs() {
    for (const a of arcs) {
      a.geometry.dispose();
      (a.material as THREE.Material).dispose();
      root.remove(a);
    }
    arcs = [];
    activeCurve = null;
  }

  const C_ARC = new THREE.Color('#ffd49a'); // warm amber thread
  function buildArc(a: THREE.Vector3, b: THREE.Vector3, active: boolean): { mesh: THREE.Mesh; curve: THREE.QuadraticBezierCurve3 } {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
    const ctrl = mid.add(perp.multiplyScalar(0.62)).add(new THREE.Vector3(0, 0, 0.55));
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), ctrl, b.clone());
    const geo = new THREE.TubeGeometry(curve, 50, active ? 0.05 : 0.026, 8, false);
    const mat = new THREE.MeshBasicMaterial({
      color: active ? C_MUSTARD : C_ARC,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: active ? 1 : 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    return { mesh, curve };
  }

  let data: GLData = { nodes: [], edges: [] };
  const posOf = new Map<string, THREE.Vector3>();

  function update(next: GLData) {
    data = next;
    posOf.clear();
    next.nodes.forEach((n, i) => posOf.set(n.name, nodePos(i, next.nodes.length)));

    // diff nodes
    const seen = new Set<string>();
    for (const n of next.nodes) {
      seen.add(n.name);
      let o = nodes.get(n.name);
      if (!o) {
        o = makeNode(n);
        nodes.set(n.name, o);
        root.add(o.group);
      }
      o.data = n;
      applyNodeColors(o);
      o.group.position.copy(posOf.get(n.name)!);
      o.ring.material.opacity = 0; // updated in loop if working
      o.label.textContent = '';
      const nameEl = document.createElement('span');
      nameEl.className = 'lc-gl-label__name';
      nameEl.textContent = n.name;
      o.label.appendChild(nameEl);
      if (n.working && n.label) {
        const st = document.createElement('span');
        st.className = 'lc-gl-label__state';
        st.textContent = n.label;
        o.label.appendChild(st);
      }
      o.label.classList.toggle('is-offline', !n.online);
    }
    for (const [name, o] of nodes) {
      if (seen.has(name)) continue;
      root.remove(o.group);
      o.halo.material.dispose();
      o.core.material.dispose();
      o.ring.material.dispose();
      o.label.remove();
      nodes.delete(name);
    }

    // arcs
    clearArcs();
    for (const e of next.edges) {
      const a = posOf.get(e.from);
      const b = posOf.get(e.to);
      if (!a || !b) continue;
      const { mesh, curve } = buildArc(a, b, e.active);
      mesh.userData = { from: e.from, to: e.to, active: e.active };
      arcs.push(mesh);
      root.add(mesh);
      if (e.active) activeCurve = curve;
    }
    pulse.visible = !!activeCurve && !reduced;
    if (reduced) {
      projectLabels();
      renderer.render(scene, camera);
    }
  }

  // — interaction —
  const pointer = new THREE.Vector2(0, 0);
  const pointerTarget = new THREE.Vector2(0, 0);
  const ndc = new THREE.Vector2(0, 0);
  let hovered: string | null = null;
  const raycaster = new THREE.Raycaster();

  const onMove = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    pointerTarget.set(x * 2 - 1, -(y * 2 - 1));
    ndc.set(x * 2 - 1, -(y * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const cores = [...nodes.values()].map((o) => o.core);
    const hit = raycaster.intersectObjects(cores, false)[0];
    hovered = hit ? ([...nodes.values()].find((o) => o.core === hit.object)?.data.name ?? null) : null;
    host.style.cursor = hovered ? 'pointer' : 'default';
  };
  const onLeave = () => {
    pointerTarget.set(0, 0);
    hovered = null;
  };
  host.addEventListener('pointermove', onMove, { passive: true });
  host.addEventListener('pointerleave', onLeave, { passive: true });

  const onResize = () => fitCamera();
  window.addEventListener('resize', onResize);
  const ro =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitCamera()) : null;
  ro?.observe(host);

  const projected = new THREE.Vector3();
  function projectLabels() {
    for (const o of nodes.values()) {
      projected.copy(o.group.position);
      o.group.localToWorld(projected.set(0, 0, 0));
      projected.project(camera);
      const sx = (projected.x * 0.5 + 0.5) * width;
      const sy = (-projected.y * 0.5 + 0.5) * height;
      o.label.style.transform = `translate(-50%, 0) translate(${sx}px, ${sy + 22}px)`;
      o.label.style.opacity = projected.z < 1 ? (o.data.online ? '1' : '0.6') : '0';
    }
  }

  // — transient, data-driven event animations: a comet per directed message, a ripple per broadcast —
  interface LivePulse {
    sprite: THREE.Sprite;
    curve: THREE.QuadraticBezierCurve3;
    dir: number;
    t: number;
  }
  interface Ripple {
    sprite: THREE.Sprite;
    t: number;
  }
  const livePulses: LivePulse[] = [];
  const ripples: Ripple[] = [];

  function arcCurve(a: THREE.Vector3, b: THREE.Vector3): THREE.QuadraticBezierCurve3 {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const d = b.clone().sub(a);
    const perp = new THREE.Vector3(-d.y, d.x, 0).normalize();
    const ctrl = mid.add(perp.multiplyScalar(0.62)).add(new THREE.Vector3(0, 0, 0.55));
    return new THREE.QuadraticBezierCurve3(a.clone(), ctrl, b.clone());
  }
  function emitPulse(from: string, to: string, color: string) {
    if (reduced) return;
    const s0 = [from, to].sort()[0]!;
    const a = posOf.get(s0);
    const b = posOf.get(s0 === from ? to : from);
    if (!a || !b) return;
    const curve = arcCurve(a, b); // built on the sorted pair so it rides the visible arc
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: coreTex,
        color: new THREE.Color(color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sp.scale.setScalar(0.36);
    sp.renderOrder = 3;
    root.add(sp);
    livePulses.push({ sprite: sp, curve, dir: from === s0 ? 1 : -1, t: 0 });
  }
  function emitRipple(from: string, color: string) {
    if (reduced) return;
    const p = posOf.get(from);
    if (!p) return;
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringTex,
        color: new THREE.Color(color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.85,
      }),
    );
    sp.position.copy(p);
    sp.scale.setScalar(0.6);
    sp.renderOrder = 3;
    root.add(sp);
    ripples.push({ sprite: sp, t: 0 });
  }
  function emit(ev: SceneEvent) {
    if (ev.kind === 'pulse') emitPulse(ev.from, ev.to, ev.color);
    else if (ev.kind === 'ripple') emitRipple(ev.from, ev.color);
    else if (ev.kind === 'settle') {
      // a resolve: the act travels, then the thread settles where it lands
      emitPulse(ev.from, ev.to, ev.color);
      emitRipple(ev.to, ev.color);
    }
  }

  const clock = new THREE.Clock();
  let raf = 0;
  let running = true;
  let t = 0;
  let pulseT = 0;

  function frame() {
    const dt = clock.getDelta();
    t += dt;
    pointer.lerp(pointerTarget, 0.05);
    root.rotation.y = pointer.x * 0.18;
    root.rotation.x = pointer.y * 0.12;

    dust.rotation.y = t * 0.012;

    for (const o of nodes.values()) {
      const target = hovered === null ? 1 : hovered === o.data.name ? 1 : 0.18;
      o.hot += ((hovered === o.data.name ? 1 : 0) - o.hot) * Math.min(1, dt * 8);
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.4 + o.breath);
      const on = o.data.online ? 1 : 0;
      const lift = 1 + o.hot * 0.7;
      o.halo.scale.setScalar((1.45 + breathe * 0.12) * lift);
      o.halo.material.opacity = on * (0.32 + breathe * 0.22 + o.hot * 0.5) * (hovered && hovered !== o.data.name ? 0.3 : 1);
      o.core.scale.setScalar(0.5 * (1 + o.hot * 0.25));
      (o.core.material as THREE.SpriteMaterial).opacity = (o.data.online ? 0.95 : 0.5) * target;
      if (o.data.working && o.data.online) {
        const rp = 0.5 + 0.5 * Math.sin(t * 1.6 + o.breath);
        o.ring.material.opacity = (0.5 + rp * 0.4) * target;
        o.ring.scale.setScalar((0.9 + rp * 0.08) * lift);
      } else {
        o.ring.material.opacity = 0;
      }
    }
    for (const a of arcs) {
      const m = a.material as THREE.MeshBasicMaterial;
      const ud = a.userData as { from: string; to: string; active: boolean };
      const connects = hovered !== null && (ud.from === hovered || ud.to === hovered);
      let op = ud.active ? 1 : 0.5;
      if (hovered !== null) op = connects ? (ud.active ? 1 : 0.95) : ud.active ? 0.45 : 0.14;
      m.opacity = op;
    }

    if (activeCurve && pulse.visible) {
      // ambient comet on the current thread — slow, constant glide
      pulseT = (pulseT + dt / 3.6) % 1;
      activeCurve.getPointAt(pulseT, pulse.position);
      pulse.scale.setScalar(0.26 + 0.05 * Math.sin(t * 4));
    }

    // transient event comets (one per directed message) — slower, eased glide
    for (let i = livePulses.length - 1; i >= 0; i--) {
      const lp = livePulses[i]!;
      lp.t += dt / 1.9;
      if (lp.t >= 1) {
        root.remove(lp.sprite);
        (lp.sprite.material as THREE.Material).dispose();
        livePulses.splice(i, 1);
        continue;
      }
      const eased = easeInOut(lp.t);
      const tt = lp.dir > 0 ? eased : 1 - eased;
      lp.curve.getPointAt(tt < 0 ? 0 : tt > 1 ? 1 : tt, lp.sprite.position);
      const fade = lp.t < 0.16 ? lp.t / 0.16 : lp.t > 0.8 ? (1 - lp.t) / 0.2 : 1;
      (lp.sprite.material as THREE.SpriteMaterial).opacity = fade;
      lp.sprite.scale.setScalar(0.3 + 0.12 * Math.sin(lp.t * Math.PI));
    }
    // broadcast / settle ripples (expanding ring from the sender) — slower, gentler ease-out
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i]!;
      rp.t += dt / 1.7;
      if (rp.t >= 1) {
        root.remove(rp.sprite);
        (rp.sprite.material as THREE.Material).dispose();
        ripples.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - rp.t, 3);
      rp.sprite.scale.setScalar(0.55 + e * 3.8);
      (rp.sprite.material as THREE.SpriteMaterial).opacity = (1 - rp.t) * (1 - rp.t) * 0.78;
    }

    projectLabels();
    renderer.render(scene, camera);
    if (running && !reduced) raf = requestAnimationFrame(frame);
  }

  if (reduced) {
    // one static frame, no loop
    projectLabels();
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(frame);
  }

  const onVisibility = () => {
    running = document.visibilityState === 'visible';
    if (running && !reduced) {
      clock.getDelta();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    update,
    emit,
    dispose: () => {
      cancelAnimationFrame(raf);
      running = false;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const o of nodes.values()) {
        o.halo.material.dispose();
        o.core.material.dispose();
        o.ring.material.dispose();
        o.label.remove();
      }
      for (const lp of livePulses) {
        root.remove(lp.sprite);
        (lp.sprite.material as THREE.Material).dispose();
      }
      for (const rp of ripples) {
        root.remove(rp.sprite);
        (rp.sprite.material as THREE.Material).dispose();
      }
      clearArcs();
      dustGeo.dispose();
      dustMat.dispose();
      glowTex.dispose();
      coreTex.dispose();
      ringTex.dispose();
      (pulse.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
