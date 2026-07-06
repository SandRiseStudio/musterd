import { createActors, type Actors } from './actors';
import { fitFloor, project, type Fit, type Pt } from './iso';
import { ENTRANCE } from './layout';
import { assignSeats, type Placement } from './seating';
import {
  coffeeAnchor,
  DARK_PALETTE,
  drawCue,
  monitorAnchors,
  renderScene,
  setScenePalette,
  toneColor,
  type Cue,
  type ScenePalette,
} from './render';
import { loadRiveRig, type RiveRig } from './rive-rig';
import { truncateSpeech, typeCadence } from './speech';
import type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode, Pose } from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

const DPR_CAP = 2;
const CUE_SECS = 1.5;
// Speech-bubble lifecycle (ms): hold after the text finishes typing, then the exit transition length.
// The hold is deliberately generous (plus a per-character allowance, capped) so a bubble lingers long
// enough to actually read — and to click through to the stream — before it drifts away.
const SPEECH_HOLD_MS = 4200;
const SPEECH_HOLD_PER_CHAR_MS = 30;
const SPEECH_HOLD_MAX_MS = 7000;
const SPEECH_OUT_MS = 560;
/** How far above the head anchor the bubble sits (clears the name label). */
const SPEECH_LIFT = 26;
/** After a real act, keep the loop alive this long so the Rive character settles into idle rather than
 * freezing mid-gesture (ADR 086 #5 afterglow) — a brief, bounded post-act tail, not a continuous loop. */
const AFTERGLOW_MS = 2600;
/** Ambient micro-choreography (ADR 086 Phase 2): when the room is quiet, inject a gentle coffee-stroll
 * every ~90–180s. Timer-based (not RAF), one beat at a time, always preempted by a real act. This is the
 * whole-room cadence — on a small present roster it divides down to each person, so it must read as an
 * *occasional* break, not a constant water-cooler parade (the original 15–25s looked absurd on 2 people). */
const AMBIENT_MIN_MS = 90000;
const AMBIENT_MAX_MS = 180000;
/** While Tier B is awake for an *ambient-only* beat, coalesce toward ~20fps: only advance+redraw once
 * this much wall time has built up. A coffee stroll is visually identical at 20fps and ~3× cheaper; real
 * acts keep 60fps because their motion is not `ambientOnly`. */
const AMBIENT_FRAME_MS = 50;

/** An in-flight speech bubble over a member's head — its DOM root plus the timers/frames to cancel when
 * it's superseded (a newer act from the same member) or the office is disposed. */
interface Speech {
  outer: HTMLDivElement;
  cancels: Array<() => void>;
}

/**
 * Mount the live isometric office. Same `{update, emit, dispose}` shape as the constellation scene (a
 * drop-in for ConstellationGL). The office is a code-drawn Canvas2D scene; every member is an actor
 * (see `actors.ts`) drawn at a live pose. When nothing moves, the scene is baked to an offscreen buffer
 * and blitted (cheap); while acts play as choreography (walks/carry/hand-raise) the frame does a full
 * depth-sorted redraw so walkers overlap desks correctly and their labels follow them. Transient cues
 * (status pulse, note, resolve…) animate on top either way. Rive is a later swap behind `drawActor`.
 * Client-only.
 */
export interface OfficeOptions {
  /** Called with the act's envelope id when a speech bubble is clicked — the route uses it to scroll
   * to / highlight that act in the stream panel. Bubbles without an id (or no handler) aren't clickable. */
  onActClick?: (id: string) => void;
}

export function mountOffice(
  host: HTMLElement,
  labelHost: HTMLElement,
  reduced: boolean,
  options: OfficeOptions = {},
): OfficeHandle {
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
  let rig: RiveRig | null = null; // the Rive character rig, once its WASM + .riv load (else code-drawn)
  let placements = new Map<string, Placement>();
  let heads = new Map<string, Pt>(); // home head anchors — where in-place cues sit

  const labels = new Map<string, HTMLDivElement>();
  const speeches = new Map<string, Speech>(); // one live speech bubble per member (name → bubble)
  const cues: Cue[] = [];

  // ── Tier-A ambient overlay (ADR 086): GPU-composited CSS life over the baked floor — a slow day-cycle
  // wash, coffee-nook steam, and breathing monitor glows on working desks. Pure CSS, no canvas/RAF cost;
  // off entirely under reduced-motion. Lives in its own layer between the canvas and the label overlay.
  const ambientHost = document.createElement('div');
  ambientHost.className = 'lc-gl-ambient';
  const glows = new Map<string, HTMLDivElement>(); // per working-member monitor glow
  let steamEl: HTMLDivElement | null = null;
  if (!reduced) {
    host.appendChild(ambientHost);
    const daylight = document.createElement('div');
    daylight.className = 'lc-amb-daylight';
    ambientHost.appendChild(daylight);
    steamEl = document.createElement('div');
    steamEl.className = 'lc-amb-steam';
    steamEl.innerHTML = '<i></i><i></i><i></i>';
    ambientHost.appendChild(steamEl);
  }
  let lastActive = 0; // ms timestamp of the last real act/cue — drives the afterglow tail (#5)

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

  /** Read the office surface tokens (`--floor`, `--floor-2`, `--wood`, `--couch`) the active theme
   * cascades to the canvas host, so the scene paints daylight on a light page and dusk inside the `.lc`
   * stage. Any token that can't be read falls back to the dusk palette. */
  function resolveScenePalette(): ScenePalette {
    const cs = getComputedStyle(host);
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      floor: read('--floor', DARK_PALETTE.floor),
      floor2: read('--floor-2', DARK_PALETTE.floor2),
      wood: read('--wood', DARK_PALETTE.wood),
      couch: read('--couch', DARK_PALETTE.couch),
    };
  }

  /** Redraw the office at rest (everyone home) into the offscreen buffer and rebuild the name labels. */
  function bake() {
    setScenePalette(resolveScenePalette()); // follow the theme cascaded to the host before painting
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    const nodes = actors.nodes();
    const poses = actors.poses();
    const anchors = renderScene(bctx, fit, placements, nodes, poses);
    heads = anchors.heads;
    syncLabels(anchors.heads, nodes, poses);
    repositionSpeeches(anchors.heads);
    if (!reduced) {
      syncGlows(monitorAnchors(placements, nodes, fit));
      positionSteam();
    }
  }

  /** Create/remove/position a breathing glow over each working member's monitor (Tier-A, CSS-animated). */
  function syncGlows(anchors: Map<string, Pt>) {
    const seen = new Set<string>();
    for (const [name, at] of anchors) {
      seen.add(name);
      let el = glows.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lc-amb-glow';
        ambientHost.appendChild(el);
        glows.set(name, el);
      }
      el.style.transform = `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`;
    }
    for (const [name, el] of glows) {
      if (!seen.has(name)) {
        el.remove();
        glows.delete(name);
      }
    }
  }

  function positionSteam() {
    if (!steamEl) return;
    const p = coffeeAnchor(fit);
    steamEl.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
  }

  /** Create/remove label elements + set their text, and position them from `headMap`. Small (nook/strip)
   * actors are left unlabelled — their names bunch at a glance and the roster panel is the name source of
   * truth; the "+N" pills and location carry the secondary read. */
  function syncLabels(headMap: Map<string, Pt>, nodes: Map<string, OfficeNode>, poses: Map<string, Pose>) {
    const seen = new Set<string>();
    for (const [name, head] of headMap) {
      const node = nodes.get(name);
      if (!node || poses.get(name)?.small) continue;
      seen.add(name);
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
      // the same presence dot the roster panel leads with — green when online, dim otherwise
      const dot = document.createElement('span');
      dot.className = `lc-gl-label__dot lc-gl-label__dot--${node.presence === 'online' ? 'on' : 'off'}`;
      nameEl.appendChild(dot);
      nameEl.appendChild(document.createTextNode(name));
      el.appendChild(nameEl);
      // The member's status/activity is no longer a persistent caption here (it used to render as one
      // ultra-wide, never-fading line). It now surfaces as an ephemeral speech bubble on each act (below);
      // the roster panel remains the always-on source of truth for who's doing what.
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
    repositionSpeeches(headMap);
  }

  // ── ephemeral speech: an act's body types out over the sender's head, then fades ───────────────────
  function positionSpeech(outer: HTMLDivElement, head: Pt) {
    outer.style.transform = `translate(-50%, -100%) translate(${head.x}px, ${head.y - SPEECH_LIFT}px)`;
  }

  /** Keep every live bubble anchored over its member (follows a walker; snaps after a reseat). */
  function repositionSpeeches(headMap: Map<string, Pt>) {
    for (const [name, s] of speeches) {
      const head = headMap.get(name);
      if (head) positionSpeech(s.outer, head);
    }
  }

  function clearSpeech(who: string, s: Speech) {
    for (const c of s.cancels) c();
    s.outer.remove();
    if (speeches.get(who) === s) speeches.delete(who);
  }

  /** Show a member's act body as a typed-out bubble that holds, then drifts up and fades. One bubble per
   * member — a newer act supersedes the previous. Driven by timers/CSS (not the RAF loop), so it animates
   * even while the office rests; reduced-motion shows the text at once with no typewriter. When the act's
   * envelope `id` is known (and the host wired `onActClick`), the bubble is a click-through to that act
   * in the stream panel. */
  function showSpeech(who: string, raw: string, tone: string, id?: string) {
    const text = truncateSpeech(raw);
    const head = heads.get(who);
    if (!text || !head) return; // nothing to say, or the sender isn't on the floor (offline / capped)

    const prev = speeches.get(who);
    if (prev) clearSpeech(who, prev);

    const outer = document.createElement('div');
    outer.className = 'lc-speech';
    const inner = document.createElement('div');
    inner.className = 'lc-speech__inner';
    if (id && options.onActClick) {
      outer.classList.add('is-clickable');
      outer.title = 'Show this in the stream';
      outer.addEventListener('click', () => {
        outer.classList.add('is-picked'); // a soft acknowledge pulse as focus hands off to the stream
        options.onActClick!(id);
      });
    }
    inner.style.setProperty('--lc-speech-tone', toneColor(tone));
    const textEl = document.createElement('span');
    textEl.className = 'lc-speech__text';
    const textNode = document.createTextNode('');
    textEl.appendChild(textNode);
    inner.appendChild(textEl);
    outer.appendChild(inner);
    labelHost.appendChild(outer);

    const s: Speech = { outer, cancels: [] };
    speeches.set(who, s);
    positionSpeech(outer, head);

    // enter on the next frame so the hidden initial state paints first → the CSS transition actually runs
    const raf = requestAnimationFrame(() => outer.classList.add('is-in'));
    s.cancels.push(() => cancelAnimationFrame(raf));

    // Linger scaled to length (longer text earns a longer read), then drift away. Hovering the bubble
    // pauses the countdown so a reader (or a click) is never raced by the fade.
    const holdMs = Math.min(SPEECH_HOLD_MAX_MS, SPEECH_HOLD_MS + text.length * SPEECH_HOLD_PER_CHAR_MS);
    const leave = () => {
      let hold: ReturnType<typeof setTimeout>;
      const begin = () => {
        hold = setTimeout(() => {
          outer.classList.remove('is-in');
          outer.classList.add('is-out');
          const rm = setTimeout(() => clearSpeech(who, s), SPEECH_OUT_MS);
          s.cancels.push(() => clearTimeout(rm));
        }, holdMs);
      };
      begin();
      outer.addEventListener('mouseenter', () => clearTimeout(hold));
      outer.addEventListener('mouseleave', begin);
      s.cancels.push(() => clearTimeout(hold));
    };

    if (reduced) {
      textNode.nodeValue = text; // no typewriter under reduced-motion — the whole line at once
      leave();
      return;
    }

    // typewriter: reveal one char at a time with a trailing caret, then hold + leave
    const caret = document.createElement('span');
    caret.className = 'lc-caret';
    textEl.appendChild(caret);
    let i = 0;
    const iv = setInterval(() => {
      i += 1;
      textNode.nodeValue = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(iv);
        caret.remove();
        leave();
      }
    }, typeCadence(text.length));
    s.cancels.push(() => clearInterval(iv));
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
    const anchors = renderScene(ctx, fit, placements, actors.nodes(), actors.poses(), rig ?? undefined);
    drawCues();
    positionLabels(anchors.heads);
  }

  /** Feed the Rive rig this frame's live (node, pose) for every drawn member. */
  function advanceRig(dt: number) {
    if (!rig) return;
    const nodes = actors.nodes();
    const present = new Map<string, { node: OfficeNode; pose: Pose }>();
    for (const [name, pose] of actors.poses()) {
      const node = nodes.get(name);
      if (node) present.set(name, { node, pose });
    }
    rig.advance(dt, present);
  }

  /** Paint one resting frame with no loop running: settle the Rive characters into their idle pose (a
   * small nominal advance), else blit the code-drawn buffer. Used when nothing is animating so the office
   * holds a still frame instead of burning rAF — Rive's own idle motion is intentionally frozen at rest. */
  function paintResting() {
    if (rig) {
      advanceRig(1 / 60);
      drawDynamic();
    } else {
      drawStatic();
    }
  }

  let disposed = false; // set in dispose(); gates the async Rive load and the ambient scheduler's re-arm

  // — the loop runs while walks or cues are in flight; otherwise the office rests on a still frame —
  let raf = 0;
  let last = 0;
  let acc = 0; // wall time accrued since the last drawn frame — coalesced under the ambient FPS cap
  let wasActive = false;
  function tick(now: number) {
    // Idle-FPS cap (ADR 086 Phase 2): when the only motion is an ambient beat, don't advance/redraw every
    // frame — accrue wall time and coalesce toward ~20fps. Real acts (not `ambientOnly`) and the afterglow
    // settle keep the full frame rate. Accumulate `dt` so the walk maths stay correct with fewer samples.
    const inAfterglow = rig != null && lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    const capped = actors.ambientOnly() && cues.length === 0 && !inAfterglow;
    acc += last ? now - last : 1000 / 60;
    last = now;
    if (capped && acc < AMBIENT_FRAME_MS) {
      raf = requestAnimationFrame(tick); // too soon for the next ambient frame — keep the loop, skip the draw
      return;
    }
    const dt = Math.min(0.05, acc / 1000);
    acc = 0;
    const walking = actors.step(dt);
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i]!;
      c.t += dt / CUE_SECS;
      if (c.t >= 1) cues.splice(i, 1);
    }
    // Anchor the afterglow window to the *end* of motion, not to emit-time: a walk-help/handoff often
    // outlasts AFTERGLOW_MS, so keep `lastActive` fresh while anything is moving. Then the settle tail
    // measures from the frame the last walk/cue clears — the Rive character eases into idle rather than
    // freezing the instant a long walk ends (#5).
    if (walking || cues.length) lastActive = now;
    if (rig) {
      advanceRig(dt);
      drawDynamic();
    } else if (walking) {
      drawDynamic();
    } else {
      if (wasActive) bake(); // walkers just re-seated — refresh the buffer + labels to home
      drawStatic();
    }
    wasActive = walking;
    // Keep animating only while something actually moves. With the Rive rig loaded this is what lets the
    // office *rest*: Rive characters animate continuously, so gating the loop on `rig` (as before) meant it
    // never stopped and redrew every frame forever. Now, when the last walk/cue clears we draw one final
    // settled frame (above) and park — the frame stays on-canvas until the next act or presence change.
    // Afterglow (#5): for a brief window after the last motion, keep advancing so the Rive character settles
    // into idle instead of freezing mid-gesture — a bounded post-act tail, not a continuous loop.
    const settling = rig != null && lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    if ((walking || cues.length || settling) && !reduced && VISIBLE()) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
      acc = 0;
    }
  }
  function ensureLoop() {
    if (!raf && !reduced && VISIBLE()) {
      last = 0;
      acc = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  // ── Ambient micro-choreography scheduler (ADR 086 Phase 2) ──────────────────────────────────────────
  // A timer (not the RAF loop) that, in a genuinely quiet room, sends one idle desk member on a slow
  // coffee-stroll every ~15–25s. Self-generated visual filler: it emits no acts, and any real act cancels
  // it and pushes the next slot out. Off entirely under reduced-motion / hidden tab.
  let ambientTimer: ReturnType<typeof setTimeout> | null = null;
  /** No real motion in flight (no walks, no cues, past the afterglow tail) — safe to inject a beat. */
  function quiet(): boolean {
    return !actors.active() && cues.length === 0 && !(lastActive > 0 && performance.now() - lastActive < AFTERGLOW_MS);
  }
  function scheduleAmbient() {
    if (reduced || disposed) return;
    if (ambientTimer) clearTimeout(ambientTimer);
    const delay = AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
    ambientTimer = setTimeout(fireAmbient, delay);
  }
  function fireAmbient() {
    ambientTimer = null;
    if (disposed) return; // office torn down between the timer arming and firing — don't re-arm or wake

    // Only stir a calm, visible room; otherwise let this slot pass and wait for the next one.
    if (!reduced && VISIBLE() && quiet()) {
      const idle = actors.idleDeskMembers();
      const who = idle.length ? idle[Math.floor(Math.random() * idle.length)]! : null;
      if (who) {
        // Most beats are a cheap in-place gesture (stretch/glance); occasionally a coffee-stroll. The
        // gesture path no-ops visually until the `.riv` exposes the `gesture` layer, then lights up.
        const beat = Math.random();
        const played =
          beat < 0.7
            ? actors.gestureBeat(who, beat < 0.35 ? 1 : 2) // 1 stretch · 2 glance
            : actors.ambientWalk(who);
        if (played) ensureLoop();
      }
    }
    scheduleAmbient();
  }

  function update(next: OfficeData) {
    placements = assignSeats(next.nodes);
    const byName = new Map(next.nodes.map((n) => [n.name, n]));
    // Animate presence changes (walk in/out, drift) unless reduced-motion asked for stillness.
    actors.setHomes(placements, byName, !reduced);
    if (!reduced && actors.takeDoorPulses() > 0) pushDoorCue(); // the entrance "opens" as someone comes/goes
    bake();
    if (actors.active() || cues.length) ensureLoop();
    else paintResting(); // no motion → hold a still frame (Rive-aware; not the code-drawn buffer)
  }

  function pushCue(name: string, color: string, glyph: Cue['glyph'], urgent = false) {
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y + 20 }, color, glyph, t: 0, urgent });
  }

  /** A broadcast sweep rolling out from the announcer. */
  function pushWave(name: string, color: string) {
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y + 20 }, color, glyph: '', t: 0, urgent: false, kind: 'wave' });
  }

  /** The entrance glows as a member walks in or out. */
  function pushDoorCue() {
    const p = project(ENTRANCE.lx, ENTRANCE.ly, fit);
    cues.push({ at: { x: p.x, y: p.y }, color: '#cfe7ee', glyph: '', t: 0, urgent: false, kind: 'door' });
  }

  function emit(ev: OfficeEvent) {
    // A real act always preempts ambient filler: cancel any in-flight coffee-stroll and push the next
    // ambient slot out past this act, so ambient never delays real choreography or a speech bubble.
    if (!reduced) {
      actors.cancelAmbient();
      scheduleAmbient();
    }
    // Speech is legible content, not motion — it plays even under reduced-motion (typewriter off there).
    if (ev.kind === 'speech') {
      showSpeech(ev.who, ev.text, ev.tone, ev.id);
      return;
    }
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
        // Broadcast staging: the announcer raises a megaphone, a wave sweeps the room, and every other
        // present member gets a brief "heard it" pulse.
        pushCue(ev.from, '#f4cf52', '📣');
        pushWave(ev.from, '#f4cf52');
        for (const name of heads.keys()) if (name !== ev.from) pushCue(name, '#f4cf52', '');
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
    lastActive = performance.now(); // arm the afterglow tail (#5) off this real act
    ensureLoop();
  }

  const onResize = () => {
    sizeCanvases();
    bake();
    if (!raf) paintResting(); // repaint the resting frame at the new size (Rive-aware)
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && (rig || actors.active() || cues.length)) ensureLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  sizeCanvases();
  bake();
  drawStatic();
  scheduleAmbient(); // start the idle coffee-stroll timer (no-op under reduced-motion)

  // Load the Rive character rig (client-only WASM). On success the office switches to a continuous
  // Rive redraw; on any failure `rig` stays null and the code-drawn avatar is used unchanged.
  void loadRiveRig().then((r) => {
    if (disposed) {
      r?.dispose();
      return;
    }
    rig = r;
    if (!rig) return;
    if (reduced) {
      advanceRig(0.016); // reduced-motion: one settled frame, no loop
      drawDynamic();
    } else {
      ensureLoop();
    }
  });

  return {
    update,
    emit,
    pokeGesture: (kind = 1) => {
      // Same path as the ambient scheduler's gesture beat, but on demand — try idle desk members until
      // one accepts (gestureBeat rejects a small/walking/already-gesturing member).
      for (const who of actors.idleDeskMembers()) {
        if (actors.gestureBeat(who, kind)) {
          ensureLoop();
          return who;
        }
      }
      return null;
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (ambientTimer) clearTimeout(ambientTimer); // stop the idle-beat scheduler
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      rig?.dispose();
      rig = null;
      for (const [who, s] of [...speeches]) clearSpeech(who, s); // cancel timers + remove bubbles
      for (const el of labels.values()) el.remove();
      labels.clear();
      glows.clear();
      ambientHost.remove(); // removes the day-cycle wash, steam, and any monitor glows
      canvas.remove();
    },
  };
}
