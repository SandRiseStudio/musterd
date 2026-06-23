import { buildLensMap } from './displacement';

/*
 * Liquid-glass engine — the runtime ported from Appendix A, reshaped to operate on a
 * bounded stage and a set of element refs (no global getElementById). One draggable lens
 * refracts a cloned copy of the stage's scene. The fresh-filter-id-per-frame trick defeats
 * Safari's filter caching (the Aave workaround). We keep this to a single contained stage —
 * the performant, cross-browser-supported case — rather than refracting the whole page.
 */

export interface GlassElements {
  stage: HTMLElement;
  scene: HTMLElement;
  lens: HTMLElement;
  lensClip: HTMLElement;
  blurWrap: HTMLElement;
  refraction: HTMLElement;
  tintLayer: HTMLElement;
  glintLayer: HTMLElement;
  housing: SVGElement;
  orb?: HTMLElement | null;
}

interface Params {
  depth: number;
  splay: number;
  feather: number;
  curve: number;
  blur: number;
  glint: number;
  tint: number;
  tintColor: string;
}

const PAD = 18;
const LENS = 132;
const RADIUS = 26;

// A single tuned preset: gentle mustard-tinted "simple glass" (chroma intentionally off —
// the two-pass chromatic aberration is the expensive path the source flags for mobile).
const PARAMS: Params = {
  depth: 54,
  splay: 3,
  feather: 22,
  curve: 1.8,
  blur: 0,
  glint: 30,
  tint: 0.08,
  tintColor: '#e1ad01',
};

const MAP_W = LENS + 2 * PAD;
const MAP_H = LENS + 2 * PAD;

export function createLiquidGlass(els: GlassElements): { dispose: () => void } {
  const { stage, scene, lens, lensClip, blurWrap, refraction, tintLayer, glintLayer, housing } = els;

  let version = 0;
  let curLeft = Math.max(0, (stage.clientWidth - LENS) / 2);
  let curTop = Math.max(0, (stage.clientHeight - LENS) / 2);
  let needsPaint = true;

  // Clone the scene; the CSS `filter` only warps an element's own subtree, so the lens
  // holds a non-interactive copy while the real scene stays live behind it.
  const cloneWrap = document.createElement('div');
  cloneWrap.className = 'lg-refraction-scene';
  cloneWrap.innerHTML = scene.innerHTML;
  refraction.appendChild(cloneWrap);
  const cloneOrb = cloneWrap.querySelector<HTMLElement>('[data-lg-orb]');
  const realOrb = els.orb ?? scene.querySelector<HTMLElement>('[data-lg-orb]');

  function applyFilter(mapUrl: string) {
    const id = `lg-v${++version}`;
    const sc = PARAMS.depth;
    const disp = `<feDisplacementMap in="SourceGraphic" in2="map" scale="${sc}" xChannelSelector="R" yChannelSelector="G" result="disp"/>`;
    housing.innerHTML = `
      <defs>
        <filter id="${id}" x="0" y="0" width="100%" height="100%"
                filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
          <feImage href="${mapUrl}" x="0" y="0" width="${MAP_W}" height="${MAP_H}" preserveAspectRatio="none" result="map"/>
          ${disp}
        </filter>
      </defs>`;
    refraction.style.filter = `url(#${id})`;
  }

  function place() {
    lens.style.left = `${curLeft}px`;
    lens.style.top = `${curTop}px`;
    lens.style.width = `${LENS}px`;
    lens.style.height = `${LENS}px`;
    lens.style.borderRadius = `${RADIUS}px`;
    lensClip.style.clipPath = `inset(0 round ${RADIUS}px)`;
    refraction.style.width = `${MAP_W}px`;
    refraction.style.height = `${MAP_H}px`;
    refraction.style.left = `${-PAD}px`;
    refraction.style.top = `${-PAD}px`;
    refraction.style.transform = 'none';
    refraction.style.clipPath = `inset(${PAD}px round ${RADIUS}px)`;
    cloneWrap.style.width = `${stage.clientWidth}px`;
    cloneWrap.style.height = `${stage.clientHeight}px`;
    cloneWrap.style.left = `${-(curLeft - PAD)}px`;
    cloneWrap.style.top = `${-(curTop - PAD)}px`;
    blurWrap.style.filter = PARAMS.blur > 0 ? `blur(${PARAMS.blur}px)` : 'none';
    glintLayer.style.opacity = `${Math.min(1, PARAMS.glint / 100)}`;
    tintLayer.style.background = PARAMS.tintColor;
    tintLayer.style.opacity = `${PARAMS.tint}`;
    needsPaint = true;
  }

  function paint() {
    applyFilter(buildLensMap(MAP_W, MAP_H, LENS, LENS, RADIUS, PARAMS.splay, PARAMS.curve, PARAMS.feather));
  }

  // Gentle Lissajous drift for the showcase orb so the refraction visibly lives.
  const ORB = 64;
  let orbPhase = 0;
  let orbX = stage.clientWidth * 0.5;
  let orbY = stage.clientHeight * 0.5;
  function animateScene(dt: number) {
    if (!realOrb) return;
    orbPhase += dt * 0.6;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    // Drive left/top (not transform): Safari won't sample a compositor transform
    // through the SVG filter, so a transformed orb wouldn't refract.
    orbX = w * 0.5 - ORB / 2 + Math.cos(orbPhase) * w * 0.3;
    orbY = h * 0.5 - ORB / 2 + Math.sin(orbPhase * 0.8) * h * 0.28;
    realOrb.style.left = `${orbX}px`;
    realOrb.style.top = `${orbY}px`;
    if (cloneOrb) {
      cloneOrb.style.left = `${orbX}px`;
      cloneOrb.style.top = `${orbY}px`;
    }
  }
  function orbInLensRegion() {
    if (!realOrb) return false;
    const m = ORB + 40;
    return (
      orbX - m < curLeft + LENS + PAD &&
      orbX + m > curLeft - PAD &&
      orbY - m < curTop + LENS + PAD &&
      orbY + m > curTop - PAD
    );
  }

  function clampToStage(left: number, top: number) {
    curLeft = Math.max(0, Math.min(left, stage.clientWidth - LENS));
    curTop = Math.max(0, Math.min(top, stage.clientHeight - LENS));
  }

  // ── drag ──────────────────────────────────────────────────────────────────
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  const onDown = (e: PointerEvent) => {
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    ox = curLeft;
    oy = curTop;
    lens.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    clampToStage(ox + (e.clientX - sx), oy + (e.clientY - sy));
    place();
  };
  const onUp = () => {
    dragging = false;
  };
  lens.addEventListener('pointerdown', onDown);
  lens.addEventListener('pointermove', onMove);
  lens.addEventListener('pointerup', onUp);

  const ro = new ResizeObserver(() => {
    clampToStage(curLeft, curTop);
    place();
  });
  ro.observe(stage);

  // ── loop ──────────────────────────────────────────────────────────────────
  let raf = 0;
  let running = true;
  let last = 0;
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    if (!running) return;
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0;
    last = t;
    animateScene(dt);
    if (needsPaint || orbInLensRegion()) {
      paint();
      needsPaint = false;
    }
  };

  const onVisibility = () => {
    running = document.visibilityState === 'visible';
    last = 0;
  };
  document.addEventListener('visibilitychange', onVisibility);

  place();
  paint();
  needsPaint = false;
  raf = requestAnimationFrame(loop);

  return {
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      lens.removeEventListener('pointerdown', onDown);
      lens.removeEventListener('pointermove', onMove);
      lens.removeEventListener('pointerup', onUp);
      cloneWrap.remove();
      housing.innerHTML = '';
    },
  };
}
