import { fitFloor, type Fit, type Pt } from './iso';
import { assignSeats, type Placement } from './seating';
import { drawCue, renderScene, toneColor, type Cue } from './render';
import type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

const DPR_CAP = 2;
const CUE_SECS = 1.5;

/**
 * Mount the live isometric office. Same lifecycle + `{update, emit, dispose}` shape as the constellation
 * scene (a drop-in for ConstellationGL): the static office is baked to an offscreen buffer on data/resize
 * and blitted each frame; act cues animate on top; name labels are projected HTML in `labelHost`. M1 has
 * no Rive and no walking — a code-drawn office that reads live presence + act cues. Client-only.
 */
export function mountOffice(host: HTMLElement, labelHost: HTMLElement, reduced: boolean): OfficeHandle {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d')!;

  let width = Math.max(1, host.clientWidth);
  let height = Math.max(1, host.clientHeight);
  let fit: Fit = fitFloor(width, height);

  let placements = new Map<string, Placement>();
  let byName = new Map<string, OfficeNode>();
  let heads = new Map<string, Pt>();

  const labels = new Map<string, HTMLDivElement>();
  const cues: Cue[] = [];

  function sizeCanvases() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    for (const c of [canvas, buf]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    fit = fitFloor(width, height);
  }

  /** Redraw the static office into the offscreen buffer and refresh the name labels. */
  function bake() {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    const anchors = renderScene(bctx, fit, placements, byName);
    heads = anchors.heads;
    syncLabels();
  }

  function syncLabels() {
    const seen = new Set<string>();
    for (const [name, head] of heads) {
      seen.add(name);
      const node = byName.get(name);
      if (!node) continue;
      let el = labels.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lc-gl-label';
        labelHost.appendChild(el);
        labels.set(name, el);
      }
      el.textContent = '';
      const nameEl = document.createElement('span');
      nameEl.className = 'lc-gl-label__name';
      nameEl.textContent = name;
      el.appendChild(nameEl);
      if (node.activity === 'working' && node.state) {
        const st = document.createElement('span');
        st.className = 'lc-gl-label__state';
        st.textContent = node.state;
        el.appendChild(st);
      }
      el.classList.toggle('is-offline', node.presence !== 'online');
      el.style.transform = `translate(-50%, -100%) translate(${head.x}px, ${head.y}px)`;
    }
    for (const [name, el] of labels) {
      if (!seen.has(name)) {
        el.remove();
        labels.delete(name);
      }
    }
  }

  function paint() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0);
    if (cues.length) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const c of cues) drawCue(ctx, c, fit.scale);
    }
  }

  // — the loop only runs while cues are in flight (the office is otherwise static in M1) —
  let raf = 0;
  let last = 0;
  function tick(now: number) {
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i]!;
      c.t += dt / CUE_SECS;
      if (c.t >= 1) cues.splice(i, 1);
    }
    paint();
    if (cues.length && !reduced && document.visibilityState === 'visible') {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
    }
  }
  function ensureLoop() {
    if (!raf && !reduced && document.visibilityState === 'visible') {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  function update(next: OfficeData) {
    placements = assignSeats(next.nodes);
    byName = new Map(next.nodes.map((n) => [n.name, n]));
    bake();
    paint();
  }

  function pushCue(name: string, color: string, glyph: Cue['glyph'], urgent = false) {
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y + 20 }, color, glyph, t: 0, urgent });
  }

  function emit(ev: OfficeEvent) {
    if (reduced) return;
    switch (ev.kind) {
      case 'screen-pulse':
        pushCue(ev.who, toneColor(ev.tone), '');
        break;
      case 'note':
        pushCue(ev.to, toneColor(ev.tone), '');
        pushCue(ev.from, toneColor(ev.tone), '');
        break;
      case 'walk-help':
        pushCue(ev.from, '#f4cf52', ev.tier === 'urgent' ? '!' : '', ev.tier === 'urgent');
        pushCue(ev.to, '#f4cf52', '', ev.tier === 'urgent');
        break;
      case 'walk-handoff':
        pushCue(ev.from, '#c6a3ff', '↦');
        pushCue(ev.to, '#c6a3ff', '');
        break;
      case 'megaphone':
        pushCue(ev.from, '#f4cf52', '📣');
        break;
      case 'accept':
        pushCue(ev.who, '#5cd49a', '✓');
        break;
      case 'decline':
        pushCue(ev.who, '#f3776a', '');
        break;
      case 'wait':
        pushCue(ev.who, '#88a9cf', '');
        break;
      case 'resolve':
        pushCue(ev.who, '#5cd49a', '✓');
        break;
    }
    ensureLoop();
  }

  const onResize = () => {
    sizeCanvases();
    bake();
    paint();
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && cues.length) ensureLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  sizeCanvases();
  bake();
  paint();

  return {
    update,
    emit,
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const el of labels.values()) el.remove();
      labels.clear();
      canvas.remove();
    },
  };
}
