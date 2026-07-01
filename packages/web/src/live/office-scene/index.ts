import { createActors, type Actors } from './actors';
import { fitFloor, type Fit, type Pt } from './iso';
import { assignSeats, type Placement } from './seating';
import { drawCue, renderScene, toneColor, type Cue } from './render';
import type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

const DPR_CAP = 2;
const CUE_SECS = 1.5;

/**
 * Mount the live isometric office. Same `{update, emit, dispose}` shape as the constellation scene (a
 * drop-in for ConstellationGL). The office is a code-drawn Canvas2D scene; every member is an actor
 * (see `actors.ts`) drawn at a live pose. When nothing moves, the scene is baked to an offscreen buffer
 * and blitted (cheap); while acts play as choreography (walks/carry/hand-raise) the frame does a full
 * depth-sorted redraw so walkers overlap desks correctly and their labels follow them. Transient cues
 * (status pulse, note, resolve…) animate on top either way. Rive is a later swap behind `drawActor`.
 * Client-only.
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

  const actors: Actors = createActors();
  let placements = new Map<string, Placement>();
  let byName = new Map<string, OfficeNode>();
  let heads = new Map<string, Pt>(); // home head anchors — where in-place cues sit

  const labels = new Map<string, HTMLDivElement>();
  const cues: Cue[] = [];

  // Pause the RAF loop when the tab is backgrounded (no CPU on an unseen office).
  const VISIBLE = () => document.visibilityState === 'visible';

  function sizeCanvases() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    for (const c of [canvas, buf]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    fit = fitFloor(width, height);
  }

  /** Redraw the office at rest (everyone home) into the offscreen buffer and rebuild the name labels. */
  function bake() {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    const anchors = renderScene(bctx, fit, placements, byName, actors.poses());
    heads = anchors.heads;
    syncLabels(anchors.heads);
  }

  /** Create/remove label elements + set their text, and position them from `headMap`. */
  function syncLabels(headMap: Map<string, Pt>) {
    const seen = new Set<string>();
    for (const [name, head] of headMap) {
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

  /** Cheap per-frame reposition of existing labels (used while walking — no structural change). */
  function positionLabels(headMap: Map<string, Pt>) {
    for (const [name, el] of labels) {
      const head = headMap.get(name);
      if (head) el.style.transform = `translate(-50%, -100%) translate(${head.x}px, ${head.y}px)`;
    }
  }

  function drawCues() {
    if (!cues.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const c of cues) drawCue(ctx, c, fit.scale);
  }

  /** Idle frame: blit the baked buffer, then any cues on top. */
  function drawStatic() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0);
    drawCues();
  }

  /** Active frame: full depth-sorted redraw with live poses, labels following, cues on top. */
  function drawDynamic() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    const anchors = renderScene(ctx, fit, placements, byName, actors.poses());
    drawCues();
    positionLabels(anchors.heads);
  }

  // — the loop runs while walks or cues are in flight; otherwise the office rests as a static blit —
  let raf = 0;
  let last = 0;
  let wasActive = false;
  function tick(now: number) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const walking = actors.step(dt);
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i]!;
      c.t += dt / CUE_SECS;
      if (c.t >= 1) cues.splice(i, 1);
    }
    if (walking) {
      drawDynamic();
    } else {
      if (wasActive) bake(); // walkers just re-seated — refresh the buffer + labels to home
      drawStatic();
    }
    wasActive = walking;
    if ((walking || cues.length) && !reduced && VISIBLE()) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
    }
  }
  function ensureLoop() {
    if (!raf && !reduced && VISIBLE()) {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  function update(next: OfficeData) {
    placements = assignSeats(next.nodes);
    byName = new Map(next.nodes.map((n) => [n.name, n]));
    actors.setHomes(placements, byName);
    bake();
    if (actors.active() || cues.length) ensureLoop();
    else drawStatic();
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
        // A real walk-over; fall back to an in-place cue only if the walk can't play (target gone).
        if (!actors.walk(ev.from, { kind: 'help', to: ev.to, urgent: ev.tier === 'urgent' })) {
          pushCue(ev.from, '#f4cf52', ev.tier === 'urgent' ? '!' : '', ev.tier === 'urgent');
        }
        break;
      case 'walk-handoff':
        if (!actors.walk(ev.from, { kind: 'handoff', to: ev.to, urgent: false })) {
          pushCue(ev.from, '#c6a3ff', '↦');
        }
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
    if (!raf) drawStatic();
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && (actors.active() || cues.length)) ensureLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  sizeCanvases();
  bake();
  drawStatic();

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
