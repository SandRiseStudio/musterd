import type { Posture } from '@musterd/protocol';
import { preloadCanvasFont } from '../canvasFont';
import { createActors, type Actors } from './actors';
import { createPet, petBeat, petFollow, petGreet, petNotice, stepPet } from './pet';
import { fitFloor, project, type Fit, type Pt } from './iso';
import { CHAIR_OFF, COFFEE_STAND, DESK_SLOTS, ENTRANCE, FWD } from './layout';
import { computeLightEnv, type LightEnv } from './lighting';
import { assignSeats, type Placement } from './seating';
import {
  animatedDeskAnchors,
  coffeeAnchor,
  DARK_PALETTE,
  drawCue,
  magicAnchors,
  renderScene,
  setScenePalette,
  toneColor,
  type Cue,
  type ScenePalette,
} from './render';
import { shapeSpeech, typeCadence } from './speech';
import type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode, Pose } from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from './types';

const DPR_CAP = 2;
const CUE_SECS = 1.5;

/** Posture → the name label's dot modifier. One green: only `working` earns it. */
const DOT_STATE: Record<Posture, 'on' | 'idle' | 'away' | 'off'> = {
  working: 'on',
  idle: 'idle',
  away: 'away',
  offline: 'off',
};
// Speech-bubble lifecycle (ms): hold after the text finishes typing, then the exit transition length.
// The hold is deliberately generous (plus a per-character allowance, capped) so a bubble lingers long
// enough to actually read — and to click through to the stream — before it drifts away.
const SPEECH_HOLD_MS = 4200;
const SPEECH_HOLD_PER_CHAR_MS = 22;
const SPEECH_HOLD_MAX_MS = 9000;
/** Routine status pulses linger less — they arrive constantly and shouldn't own the floor. */
const SPEECH_HOLD_MAX_STATUS_MS = 6000;
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

/** How often the office re-reads the PST clock so the lighting tracks the real sun (the sun moves slowly —
 * once a minute is plenty, and a rebake only happens when the veil/lamp state actually crosses a step). */
const LIGHT_TICK_MS = 60000;

/**
 * Current hour-of-day (0..24) in America/Los_Angeles — the office clock the lighting follows. A
 * `?light=HH` / `?light=HH:MM` query param overrides it, a dev aid for previewing dawn/dusk/night without
 * waiting for the wall clock (harmless in prod — it only applies when explicitly present).
 */
function pstNowHours(): number {
  try {
    const q = new URLSearchParams(window.location.search).get('light');
    const m = q && /^(\d{1,2})(?::(\d{2}))?$/.exec(q.trim());
    if (m) return (Number(m[1]) % 24) + (m[2] ? Number(m[2]) / 60 : 0);
  } catch {
    /* no window/search available — fall through to the real clock */
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hh % 24) + mm / 60;
}

/** An in-flight speech bubble over a member's head — its DOM root plus the timers/frames to cancel when
 * it's superseded (a newer act from the same member) or the office is disposed. */
interface Speech {
  outer: HTMLDivElement;
  cancels: Array<() => void>;
}

/**
 * Mount the live isometric office. Exposes a `{update, emit, dispose}` handle the `OfficeScene`
 * component drives. The office is a code-drawn Canvas2D scene; every member is an actor
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
  // Warm the izzocam chyron face the canvas labels/glyphs paint in, so they land on-brand from the
  // first cue instead of flashing the system fallback (canvas never triggers the load itself).
  preloadCanvasFont();

  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d')!;

  let width = Math.max(1, host.clientWidth);
  let height = Math.max(1, host.clientHeight);
  let fit: Fit = fitFloor(width, height);

  const actors: Actors = createActors();
  /** The office dog (pet.ts): asleep in the baked frame; stirred by the ambient scheduler below. */
  const pet = createPet();
  /** The scene clock, in seconds. Everything that animates on its own — breathing, the typing bursts —
   * reads it, so it advances only while the loop runs and a rested office holds its frame. */
  let clock = 0;
  let placements = new Map<string, Placement>();
  let teamName = 'revive';
  let heads = new Map<string, Pt>(); // home head anchors — where in-place cues sit
  let occupied = false; // any online member on the floor → overhead lights on
  let lightEnv: LightEnv = computeLightEnv(pstNowHours(), occupied); // office lighting from the PST clock

  const labels = new Map<string, HTMLDivElement>();
  const speeches = new Map<string, Speech>(); // one live speech bubble per member (name → bubble)
  const cues: Cue[] = [];

  // ── Tier-A ambient overlay (ADR 086): GPU-composited CSS life over the baked floor — a slow day-cycle
  // wash, coffee-nook steam, and the animated desk props. Pure CSS, no canvas/RAF cost; off entirely under
  // reduced-motion. Lives in its own layer between the canvas and the label overlay. (The working-monitor
  // glow is *not* here — it's drawn in the canvas by `screenPanel` so a nearer monitor occludes it.)
  const ambientHost = document.createElement('div');
  ambientHost.className = 'lc-gl-ambient';
  let steamEl: HTMLDivElement | null = null;
  // Animated desk props (Tier-A CSS): a spinning blade over each fan and rising steam over each desk mug.
  // Fixed sets (a stable per-desk hash decides which desks have them), so these pools only reposition on
  // resize/rebake — never grow/shrink with the roster.
  const fanEls: HTMLDivElement[] = [];
  const deskSteamEls: HTMLDivElement[] = [];
  // Ambient magic (fixed sets, positions from the scene geometry): golden dust motes drifting in the
  // window light shafts — they fade with --lc-amb-strength, so night simply has none — and a soft
  // twinkle riding each string-light bulb the canvas paints.
  const moteEls: HTMLDivElement[] = [];
  const twinkleEls: HTMLDivElement[] = [];
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
      wall: read('--wall', DARK_PALETTE.wall),
    };
  }

  /** Recompute the office lighting from the PST clock + occupancy, and push the natural-light wash (tint +
   * strength) to the CSS overlay. Returns whether the *canvas* light (night veil / desk lamps) crossed a
   * step and so needs a rebake — the caller decides whether to act on it. */
  function refreshLightEnv(): boolean {
    const prev = lightEnv;
    lightEnv = computeLightEnv(pstNowHours(), occupied);
    if (!reduced) {
      // natural light enters as the soft-light wash — colour + strength straight off the clock
      ambientHost.style.setProperty('--lc-amb-strength', lightEnv.skyStrength.toFixed(3));
      ambientHost.style.setProperty('--lc-amb-tint', lightEnv.skyTint);
    }
    return Math.abs(lightEnv.veilAlpha - prev.veilAlpha) > 0.01 || lightEnv.lampsOn !== prev.lampsOn;
  }

  /** Redraw the office at rest (everyone home) into the offscreen buffer and rebuild the name labels. */
  function bake() {
    setScenePalette(resolveScenePalette()); // follow the theme cascaded to the host before painting
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    const nodes = actors.nodes();
    const poses = actors.poses();
    const anchors = renderScene(bctx, fit, placements, nodes, poses, clock, teamName, lightEnv, pet);
    heads = anchors.heads;
    syncLabels(anchors.heads, nodes, poses);
    repositionSpeeches(anchors.heads);
    if (!reduced) {
      positionSteam();
      syncDeskProps();
      syncMagic();
    }
  }

  /** Position the dust-mote and bulb-twinkle overlays on the scene geometry (see `magicAnchors`).
   * Fixed sets — only repositioned on rebake/resize. Each element gets a stable stagger so the field
   * shimmers out of phase instead of pulsing in lockstep. */
  function syncMagic() {
    const { motes, bulbs } = magicAnchors(fit);
    syncAnchorPool(moteEls, motes, 'lc-amb-mote', '<i></i>', 'translate(-50%, -50%)');
    syncAnchorPool(twinkleEls, bulbs, 'lc-amb-twinkle', '<i></i>', 'translate(-50%, -50%)');
    moteEls.forEach((el, i) => {
      el.style.setProperty('--lc-mote-delay', `${((i * 1.37) % 8).toFixed(2)}s`);
      el.style.setProperty('--lc-mote-dur', `${(7 + (i % 5) * 1.15).toFixed(2)}s`);
    });
    twinkleEls.forEach((el, i) => {
      el.style.setProperty('--lc-twinkle-delay', `${((i * 0.61) % 3.4).toFixed(2)}s`);
    });
  }

  /** Grow/shrink an element pool to `pts.length` and position each at its anchor. Used for the fixed-set
   * animated desk props — cheap reposition on every bake, structural change only if the count ever moves. */
  function syncAnchorPool(pool: HTMLDivElement[], pts: Pt[], cls: string, inner: string, origin: string) {
    while (pool.length < pts.length) {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = inner;
      ambientHost.appendChild(el);
      pool.push(el);
    }
    while (pool.length > pts.length) pool.pop()!.remove();
    pts.forEach((p, i) => {
      pool[i]!.style.transform = `${origin} translate(${p.x}px, ${p.y}px)`;
    });
  }

  /** Position the spinning-fan and desk-coffee-steam overlays over the props the canvas just baked. Fans
   * only spin at occupied desks — an unattended fan reads as wrong — so pass the seated-slot set. */
  function syncDeskProps() {
    const occupied = new Set<number>();
    for (const pl of placements.values()) if (pl.kind === 'desk') occupied.add(pl.slot);
    const { fans, coffees } = animatedDeskAnchors(fit, occupied);
    syncAnchorPool(fanEls, fans, 'lc-amb-fan', '<div class="lc-amb-fan__tilt"><div class="lc-amb-fan__blades"></div></div>', 'translate(-50%, -50%)');
    syncAnchorPool(deskSteamEls, coffees, 'lc-amb-steam lc-amb-steam--desk', '<i></i><i></i><i></i>', 'translate(-50%, -100%)');
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
      // The same dot the roster panel leads with, off the same posture: green working · amber idle ·
      // amber-dim away · faint offline. It used to key off raw `presence`, which is only *connectedness* —
      // so an idle member sat at a desk under a green dot and read as hard at work.
      const dot = document.createElement('span');
      dot.className = `lc-gl-label__dot lc-gl-label__dot--${DOT_STATE[node.posture]}`;
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
  function showSpeech(who: string, raw: string, tone: string, id?: string, act?: string) {
    const { glance, full, clamped } = shapeSpeech(raw, act);
    const head = heads.get(who);
    if (!glance || !head) return; // nothing to say, or the sender isn't on the floor (offline / capped)

    const prev = speeches.get(who);
    if (prev) clearSpeech(who, prev);

    const outer = document.createElement('div');
    outer.className = 'lc-speech';
    // Bubbles accept the pointer so hovering expands the text and pauses the fade — even before the
    // (click-through) affordance is wired below.
    outer.style.pointerEvents = 'auto';
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
    if (clamped) {
      // a quiet "there's more" chip — hovering the bubble reveals the full text
      const more = document.createElement('span');
      more.className = 'lc-speech__more';
      more.textContent = '⋯';
      inner.appendChild(more);
    }
    outer.appendChild(inner);
    labelHost.appendChild(outer);

    const s: Speech = { outer, cancels: [] };
    speeches.set(who, s);
    positionSpeech(outer, head);

    // enter on the next frame so the hidden initial state paints first → the CSS transition actually runs
    const raf = requestAnimationFrame(() => outer.classList.add('is-in'));
    s.cancels.push(() => cancelAnimationFrame(raf));

    // Hover = "let me read this": finish any in-flight typewriter, swap to the full text, and grow the
    // bubble smoothly. We measure the natural height after the swap and hand it to CSS as --lc-speech-h
    // so max-height can transition (height:auto can't). The outer transform is left untouched — it
    // updates per frame to follow a walker, so all growth happens on the inner element.
    let expand = () => {};
    let collapse = () => {};
    if (clamped) {
      expand = () => {
        textNode.nodeValue = full;
        outer.classList.add('is-expanded');
        // measure on the next frame so the expanded (clamp-removed) layout has painted
        requestAnimationFrame(() => {
          inner.style.setProperty('--lc-speech-h', `${inner.scrollHeight}px`);
        });
      };
      collapse = () => {
        outer.classList.remove('is-expanded');
        inner.style.removeProperty('--lc-speech-h');
        textNode.nodeValue = glance;
      };
    }

    // The dismiss countdown: begin() arms it, and it's cancelled while hovered (below) so a reader —
    // or a click — is never raced by the fade. Longer glances earn a longer base read.
    const holdCap = act === 'status_update' ? SPEECH_HOLD_MAX_STATUS_MS : SPEECH_HOLD_MAX_MS;
    const holdMs = Math.min(holdCap, SPEECH_HOLD_MS + glance.length * SPEECH_HOLD_PER_CHAR_MS);
    let hold: ReturnType<typeof setTimeout> | undefined;
    let counting = false; // true once the typewriter has finished and the fade timer is live
    const begin = () => {
      counting = true;
      hold = setTimeout(() => {
        outer.classList.remove('is-in');
        outer.classList.add('is-out');
        const rm = setTimeout(() => clearSpeech(who, s), SPEECH_OUT_MS);
        s.cancels.push(() => clearTimeout(rm));
      }, holdMs);
    };
    s.cancels.push(() => clearTimeout(hold));

    // typewriter state (a no-op under reduced motion — the whole glance shows at once)
    let done = reduced;
    let finish = () => {};

    // One hover contract for the whole life of the bubble: finish any in-flight typewriter, expand to
    // the full text, and freeze the fade. Leaving restores the glance and re-arms the countdown.
    outer.addEventListener('mouseenter', () => {
      if (!done) finish(); // complete the glance instantly, which also arms the countdown
      clearTimeout(hold);
      expand();
    });
    outer.addEventListener('mouseleave', () => {
      collapse();
      if (counting) begin();
    });

    if (reduced) {
      textNode.nodeValue = glance;
      begin();
      return;
    }

    const caret = document.createElement('span');
    caret.className = 'lc-caret';
    textEl.appendChild(caret);
    let i = 0;
    finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      caret.remove();
      textNode.nodeValue = glance;
      begin();
    };
    const iv = setInterval(() => {
      i += 1;
      textNode.nodeValue = glance.slice(0, i);
      if (i >= glance.length) finish();
    }, typeCadence(glance.length));
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
    const anchors = renderScene(ctx, fit, placements, actors.nodes(), actors.poses(), clock, teamName, lightEnv, pet);
    drawCues();
    positionLabels(anchors.heads);
  }

  /**
   * Is the room *alive* — is there body motion the scene has to keep drawing even with nobody walking?
   *
   * A member at their desk who is `working` breathes and types, so their frame changes every tick. This is
   * the one deliberate perf trade in the character work (the Rive rig anticipated it: "if we later want
   * always-on breathing, it's a deliberate perf trade recorded then"). It is bounded three ways: the loop
   * is capped to the ambient ~20fps when this is the *only* thing happening, it stops dead on a hidden tab
   * or under reduced-motion, and a room where nobody is working still rests on the baked frame — which is
   * exactly the state ADR 086 was protecting.
   */
  function living(): boolean {
    if (reduced) return false;
    for (const n of actors.nodes().values()) if (n.activity === 'working') return true;
    return false;
  }

  /** Paint one resting frame with no loop running — the office holds a still frame instead of burning rAF. */
  function paintResting() {
    drawStatic();
  }

  let disposed = false; // set in dispose(); gates the ambient scheduler's re-arm

  // — the loop runs while walks or cues are in flight; otherwise the office rests on a still frame —
  let raf = 0;
  let last = 0;
  let acc = 0; // wall time accrued since the last drawn frame — coalesced under the ambient FPS cap
  let wasActive = false;
  function tick(now: number) {
    // Idle-FPS cap (ADR 086 Phase 2): when the only motion is ambient — a coffee-stroll beat, or just a
    // room of people breathing and typing at their desks — don't redraw every frame; accrue wall time and
    // coalesce toward ~20fps. Real acts and cues keep the full frame rate. `dt` accumulates either way, so
    // the walk maths stay correct with fewer samples.
    const inAfterglow = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    const noRealMotion = actors.ambientOnly() || !actors.active();
    const capped = noRealMotion && cues.length === 0 && !inAfterglow;
    acc += last ? now - last : 1000 / 60;
    last = now;
    if (capped && acc < AMBIENT_FRAME_MS) {
      raf = requestAnimationFrame(tick); // too soon for the next ambient frame — keep the loop, skip the draw
      return;
    }
    const dt = Math.min(0.05, acc / 1000);
    acc = 0;
    clock += dt;
    const walking = actors.step(dt);
    if (walking) noticePassersBy(); // a sleeping dog wakes to watch whoever is walking past it
    const petActive = stepPet(pet, dt); // false once it's asleep — the pet never keeps the room awake
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
    const alive = living();
    if (walking || alive || petActive) {
      drawDynamic();
    } else {
      if (wasActive) bake(); // walkers just re-seated (or the pet curled up) — refresh the buffer
      drawStatic();
    }
    wasActive = walking || alive || petActive;
    // Keep animating while anything moves *or* while the room is alive (someone at a desk breathing and
    // typing — capped to ~20fps above). When the last walk/cue clears and nobody is working, we draw one
    // final settled frame and park: the frame stays on-canvas until the next act or presence change.
    // Afterglow: a brief tail past the last motion so a character eases into idle instead of freezing
    // mid-gesture — `actors.step` also reports its own blends, so a member never stops half-out of a chair.
    const settling = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    if ((walking || cues.length || settling || alive || petActive) && !reduced && VISIBLE()) {
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
  /**
   * The dog notices people. Called each frame something is walking: if anyone on the move passes close to
   * the sleeping dog, it lifts its head and watches them by. Cheap by construction — it only looks at
   * members who are actually moving, and `petNotice` bails immediately unless the dog is asleep.
   */
  function noticePassersBy(): void {
    const moving: { lx: number; ly: number }[] = [];
    for (const pose of actors.poses().values()) if (pose.moving) moving.push({ lx: pose.lx, ly: pose.ly });
    if (moving.length) petNotice(pet, moving);
  }

  /** Open-floor spots just beside each working member's chair — where the pet sits to supervise. */
  function workingSideSpots(): { lx: number; ly: number }[] {
    const out: { lx: number; ly: number }[] = [];
    for (const [name, pl] of placements) {
      if (pl.kind !== 'desk') continue;
      if (actors.nodes().get(name)?.activity !== 'working') continue;
      const slot = DESK_SLOTS[pl.slot];
      if (!slot) continue;
      const f = FWD[slot.dir];
      // beside the chair: back from the desk to the chair, then out perpendicular to the facing
      out.push({
        lx: slot.lx - f[0] * CHAIR_OFF + f[1] * 46,
        ly: slot.ly - f[1] * CHAIR_OFF - f[0] * 46,
      });
    }
    return out;
  }

  /**
   * A coffee-stroll, with the dog sometimes tagging along to the nook and sitting with them while they
   * pour. Whether the dog comes is *its* business: the stroll's own success is what's reported back, so a
   * dog that stays put can never cost a member their walk.
   */
  function coffeeStroll(who: string): boolean {
    if (!actors.ambientWalk(who)) return false;
    if (Math.random() < 0.5) petFollow(pet, COFFEE_STAND);
    return true;
  }

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
      // Sometimes the beat is the pet's: it wakes, stretches, pads to a fresh nap spot (a sunbeam by
      // day, a rug by night, occasionally a working member's side) and curls back up.
      if (Math.random() < 0.35 && petBeat(pet, { daylight: lightEnv.daylight, workSpots: workingSideSpots() })) {
        ensureLoop();
        scheduleAmbient();
        return;
      }
      const idle = actors.idleDeskMembers();
      const who = idle.length ? idle[Math.floor(Math.random() * idle.length)]! : null;
      if (who) {
        // Most beats are a cheap in-place gesture (stretch/glance); occasionally a coffee-stroll. The
        // gesture path no-ops visually until the `.riv` exposes the `gesture` layer, then lights up.
        const beat = Math.random();
        const played =
          beat < 0.7
            ? actors.gestureBeat(who, beat < 0.35 ? 1 : 2) // 1 stretch · 2 glance
            : coffeeStroll(who);
        if (played) ensureLoop();
      }
    }
    scheduleAmbient();
  }

  function update(next: OfficeData) {
    teamName = next.teamName ?? 'revive';
    placements = assignSeats(next.nodes);
    const byName = new Map(next.nodes.map((n) => [n.name, n]));
    // The overhead lights follow occupancy: on while anyone's online on the floor, off once the room empties.
    occupied = next.nodes.some((n) => n.presence === 'online');
    refreshLightEnv(); // fold the new occupancy (+ current clock) into the lighting before we bake
    // Animate presence changes (walk in/out, drift) unless reduced-motion asked for stillness.
    actors.setHomes(placements, byName, !reduced);
    if (!reduced && actors.takeDoorPulses() > 0) pushDoorCue(); // the entrance "opens" as someone comes/goes
    // Someone just walked in: the dog goes to meet them at the door. Arrivals only — nobody, dog included,
    // gets up to see you leave. This outranks whatever nap it had planned, which is the whole point of it.
    if (!reduced && actors.takeArrivals() > 0) petGreet(pet);
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

  /** A quiet mustard relationship between two Members for a meaningful directed Act. */
  function pushThread(from: string, to: string, color = toneColor('accent')) {
    const start = heads.get(from);
    const end = heads.get(to);
    if (!start || !end || cues.some((cue) => cue.kind === 'thread' && cue.source === from)) return;
    cues.push({
      at: { x: start.x, y: start.y + 18 },
      to: { x: end.x, y: end.y + 18 },
      color,
      glyph: '',
      t: 0,
      urgent: false,
      kind: 'thread',
      source: from,
    });
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
      showSpeech(ev.who, ev.text, ev.tone, ev.id, ev.act);
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
        pushThread(ev.from, ev.to, toneColor(ev.tone));
        break;
      case 'walk-help':
        pushThread(ev.from, ev.to);
        // A real walk-over; fall back to an in-place cue only if the walk can't play (target gone).
        if (!actors.walk(ev.from, { kind: 'help', to: ev.to, urgent: ev.tier === 'urgent' })) {
          pushCue(ev.from, '#f4cf52', ev.tier === 'urgent' ? '!' : '', ev.tier === 'urgent');
        }
        break;
      case 'walk-handoff':
        pushThread(ev.from, ev.to, toneColor('handoff'));
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
      case 'steer': {
        // Interrupt-class (ADR 103): a room-wide magenta sweep everyone feels, and — when the steer
        // names a member — an urgent redirect run over to them. If the target is gone (or it's a team
        // steer), the sweep plus a bold urgent marker at the sender carry it.
        const col = toneColor('steer');
        pushWave(ev.from, col);
        if (!ev.to || !actors.walk(ev.from, { kind: 'help', to: ev.to, urgent: true })) {
          pushCue(ev.from, col, '↪', true);
        }
        break;
      }
      case 'challenge': {
        // An epistemic "justify?" — a question mark over the challenger, mirrored over the challenged
        // party when it's directed. Urgent only when flagged (bolder ring + glyph then).
        const col = toneColor('challenge');
        pushCue(ev.from, col, '?', ev.urgent);
        if (ev.to) pushCue(ev.to, col, '?', ev.urgent);
        break;
      }
      case 'defer':
        // A plan mutation on a Goal — the board shifts, so it pulses out across the room in the lane
        // family rather than sitting as a single-seat cue.
        pushCue(ev.who, toneColor('lane'), '');
        pushWave(ev.who, toneColor('lane'));
        break;
    }
    lastActive = performance.now(); // arm the afterglow tail (#5) off this real act
    ensureLoop();
  }

  const onResize = () => {
    sizeCanvases();
    bake();
    if (!raf) paintResting(); // repaint the resting frame at the new size
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && (living() || actors.active() || cues.length)) ensureLoop();
  };
  document.addEventListener('visibilitychange', onVisibility);

  refreshLightEnv(); // seat the natural-light wash + veil from the PST clock before the first bake
  sizeCanvases();
  bake();
  drawStatic();
  scheduleAmbient(); // start the idle coffee-stroll timer (no-op under reduced-motion)

  // Track the real PST sun: re-read the clock every minute and rebake only when the veil/lamp state moves.
  const lightTimer = setInterval(() => {
    if (refreshLightEnv()) {
      bake();
      if (!raf) paintResting();
    }
  }, LIGHT_TICK_MS);

  ensureLoop(); // a room with anyone working is alive from the first frame (no-op under reduced-motion)

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
      clearInterval(lightTimer); // stop the PST lighting clock
      if (ambientTimer) clearTimeout(ambientTimer); // stop the idle-beat scheduler
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [who, s] of [...speeches]) clearSpeech(who, s); // cancel timers + remove bubbles
      for (const el of labels.values()) el.remove();
      labels.clear();
      ambientHost.remove(); // removes the day-cycle wash, steam, and the animated desk props
      canvas.remove();
    },
  };
}
