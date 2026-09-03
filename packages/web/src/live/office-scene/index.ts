import type { Posture } from '@musterd/protocol';
import { preloadCanvasFont } from '../canvasFont';
import { roomTone, screenPan, type LifeContext } from '../sound';
import { modelProvider } from '../modelProvider';
import { providerIconHtml } from '../modelProviderIcon';
import {
  identityMeta,
  plateDetailParts,
  shortLaneState,
  shortWorkTitle,
} from '../presenceLabel';
import { musterdChipSvg } from '../../brand/chipMark';
import { memberInk } from '../format';
import { platesOpenMode, stillMode } from '../stillMode';
import { surfaceGlyph } from '../surfaceGlyph';
import { createActors, deskNeighbourPairs, type Actors } from './actors';
import { helpWalks } from './mapping';
import {
  ambientFrameBudgetMs,
  DEFAULT_CAPTURE_FPS,
  officeDpr,
  officeVisible,
  shouldCoalesceDraw,
  suspendIgnored,
} from './broadcast';
import { AMBIENT_SLOT_MS, decideAmbient, roll, slotAt, slotRng } from './ambientSeed';
import { createPet, petBeat, petBeg, petFollow, petGreet, petNotice, stepPet } from './pet';
import { createReceptionist, stepReceptionist } from './receptionist';
import { fitFloor, project, type Fit, type Pt } from './iso';
import { CHAIR_OFF, COFFEE_STAND, DESK_SLOTS, ENTRANCE, FWD, LEISURE_SPOTS , RECEPTIONIST } from './layout';
import { computeLightEnv, type LightEnv } from './lighting';
import { isWithinWorkingHours } from './workingHours';
import { assignSeats, audiblyWorking, type Placement } from './seating';
import { captionForPresence, pushCaption, tickCaption, CAPTION_HOLD_MS, type Caption, type CaptionRail } from '../captions';
import { createWelcome, stepWelcome } from './welcome';
import {
  animatedDeskAnchors,
  chairKindFor,
  boardAnchor,
  coffeeAnchor,
  DARK_PALETTE,
  deskHasProp,
  drawCue,
  magicAnchors,
  renderScene,
  setScenePalette,
  toneColor,
  type Cue,
  type ScenePalette,
} from './render';
import { GESTURE } from './skeleton';
import type { WallBoard } from './wallboard';
import {
  shapeSpeech,
  speechLength,
  speechTokens,
  SPEECH_MARK_GLYPH,
  typeCadence,
  type Addressee,
  type SpeechMarking,
  type SpeechToken,
} from './speech';
import type { AmbientLogEntry, OfficeData, OfficeEvent, OfficeHandle, OfficeNode, Pose } from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode, OfficeStats } from './types';

const DPR_CAP = 2;

/**
 * The synthetic head the receptionist's bubble hangs from, and the key `showSpeech` recognises as
 * "this is the house voice, not a seat".
 *
 * A bare string literal in three places was one typo away from a bubble that renders as an ordinary
 * member — and the failure would be silent, because `heads.get(who)` simply returns undefined and
 * `showSpeech` drops the line. She is deliberately NOT in the node map (staff, not roster —
 * receptionist.ts), so no name collision with a real seat is possible: a member called
 * `receptionist` could not be seated, since the room's own front desk is not a desk in `DESK_SLOTS`.
 */
const RECEPTIONIST_SPEAKER = 'receptionist';
const CUE_SECS = 1.5;

/** Posture → the name label's dot modifier. One green: only `working` earns it. */
const DOT_STATE: Record<Posture, 'on' | 'idle' | 'away' | 'off'> = {
  working: 'on',
  active: 'idle', // the dot's visual state keeps its CSS name; the wire token is `active`
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
/** Ambient micro-choreography (ADR 086 Phase 2, seeded by E1): when the room is quiet, inject one idle
 * beat (a seated micro-gesture — scratch, sip, swivel… — or a stroll), drawn per 10s wall-clock slot so
 * every viewer of the same team sees the same beats. How OFTEN is `ambientSeed.ambientFireP`, which
 * scales with how many people are in the room (E1b): a populated floor reads at ~2.5–3 beats/idle-min,
 * a room of two stays near the old ~30–70s cadence so a near-empty office does not read as twitchy.
 * Timer-based (not RAF), one beat at a time, always preempted by a real act. 90–180s read as a frozen
 * room once the beat variety grew (nick's call, 2026-07); the old 15–25s water-cooler parade is still
 * the floor to stay well above. */
/** While Tier B is awake for an *ambient-only* beat, coalesce toward ~20fps: only advance+redraw once
 * this much wall time has built up. A coffee stroll is visually identical at 20fps and ~3× cheaper; real
 * acts keep 60fps because their motion is not `ambientOnly`. */
const AMBIENT_FRAME_MS = 50;

/** How often the office re-reads the PST clock so the lighting tracks the real sun (the sun moves slowly —
 * once a minute is plenty, and a rebake only happens when the veil/lamp state actually crosses a step). */
const LIGHT_TICK_MS = 60000;

/**
 * The `?light=HH` / `?light=HH:MM` dev override, if present — a dev aid for previewing dawn/dusk/night
 * without waiting for the wall clock (harmless in prod — it only applies when explicitly present). The
 * shift check rides the same override (keeping the real weekday), so `?light=23` also previews the
 * after-hours office.
 */
function lightOverrideHours(): number | null {
  try {
    const q = new URLSearchParams(window.location.search).get('light');
    const m = q && /^(\d{1,2})(?::(\d{2}))?$/.exec(q.trim());
    if (m) return (Number(m[1]) % 24) + (m[2] ? Number(m[2]) / 60 : 0);
  } catch {
    /* no window/search available — the real clock rules */
  }
  return null;
}

/** Current hour-of-day (0..24) in America/Los_Angeles — the office clock the lighting follows. */
function pstNowHours(): number {
  const override = lightOverrideHours();
  if (override !== null) return override;
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

/**
 * `?still` — MEASUREMENT MODE. Two things in this file answer to it, and they are different sizes.
 *
 * THE BUBBLE HOLD. A speech bubble dismisses itself after `SPEECH_HOLD_MS + 22ms/char` (capped at
 * 6–9s). That is right for a reader and fatal for a measurement: the a11y contrast sweep settles,
 * freezes rAF and shoots one screenshot, and that window straddles the dismiss countdown — so the
 * same commit measures a different room run to run, and a bubble caught mid-fade is sampled over
 * whatever scene paint is behind it rather than over its own paper. Measured 2026-08-17:
 * /office-preview flipped red about 1 run in 3, always an `lc-speech__text` row, on #3b5854 /
 * #2d4245 / #724b29 — three different bits of furniture, one bubble.
 *
 * THE AMBIENT HOLD (added 2026-08-19, ADR 285). The idle-beat scheduler injects a stroll or a
 * micro-gesture every 30–70s, forever. It already stands down under reduced motion — but
 * /office-preview mounts this scene with `reduced: false` hardcoded, so on the route the contrast
 * gate leans on hardest it keeps running: an identity-keeping motion probe watched a room sit
 * perfectly still for 115 seconds and then start walking again at 137s. One re-arming timer is
 * enough to make a page that never settles, and the sweep then reports MEASURED MID-FLIGHT on every
 * run — a true signal that decays into noise precisely because it is always on.
 *
 * The room still paints what it would otherwise paint: nothing is hidden, nothing is repositioned,
 * and the script's own walks are untouched (they drain in ~22s, and they are the subject). What
 * stops is the room MOVING ON of its own accord. Inert unless explicitly present, like `?light=HH`.
 *
 * The flag itself is read by `../stillMode`, shared with the overlay reel and the asks-strip so the
 * four consumers cannot drift apart on what `?still` means.
 */

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
  /** `/live` only: the wall's agile board becomes a click target that hands back its viewport rect —
   * the route opens the work-board overlay zooming out FROM that rect. Requires `interactiveLabels`;
   * broadcast passes nothing and the wall stays paint. */
  onBoardClick?: (rect: DOMRect) => void;
  /** First hover/focus on the board hotspot — the route uses it to preload the overlay's lazy chunk
   * so the click meets code that is already here. */
  onBoardHover?: () => void;
  /** Broadcast mode (ADR 157): this office is a *stream source*, not a viewer's panel. The loop keeps
   * running while the tab is hidden or headless, DPR is pinned to 1 for a deterministic capture size,
   * and suspend requests are ignored. Only `/broadcast` passes it — see ./broadcast.ts. */
  broadcast?: boolean;
  /**
   * Encode fps when `broadcast` — the office coalesces draws to this rate so paint matches capture
   * (capture-perf plan). Defaults to 30 (CLI / ADR 157). Hosted streams pass 25 via `?fps=`.
   */
  captureFps?: number;
  /**
   * `/live` only: labels accept pointer/hover so the identity+work tip can open. Broadcast keeps
   * labels non-interactive (no cursor on a stream capture).
   */
  interactiveLabels?: boolean;
  /**
   * Hybrid work cues under nameplates (spec §2). When false, always-on work lines are omitted — use
   * the in-panel WorkStack fallback instead.
   */
  showWorkCues?: boolean;
  /**
   * The narration line (first-five-seconds §2) — one transient plain-language moment about what
   * just happened in the room. Called with the current caption, or null when it expires. The rail
   * used to be a floating lower-third element over the scene; it now reads as chrome, so the CHROME
   * renders it (WorkStack's header) and the scene only says what the moment is (nick, 2026-08-31).
   */
  onCaption?: (caption: Caption | null) => void;
}

export function mountOffice(
  host: HTMLElement,
  labelHost: HTMLElement,
  reduced: boolean,
  options: OfficeOptions = {},
): OfficeHandle {
  const broadcast = options.broadcast === true;
  /* Read once at mount: the flag cannot change under a running room, and re-parsing per bubble would
     put a URLSearchParams allocation on the speech path. */
  const STILL = stillMode();
  const captureFps =
    typeof options.captureFps === 'number' && options.captureFps > 0
      ? options.captureFps
      : DEFAULT_CAPTURE_FPS;
  const interactiveLabels = options.interactiveLabels === true;
  /* `?plates-open` (stillMode.ts) — measurement mode: every plate mounts with its detail already
     open, so the harness segment's four inks are visible to the contrast sweep. Read once here
     rather than per plate per sync: the flag cannot change without a navigation, and this runs
     inside syncLabels. Interactive routes only — a broadcast plate has no detail to open. */
  const platesOpen = interactiveLabels && platesOpenMode();
  const showWorkCues = options.showWorkCues !== false;
  const dpr = officeDpr(broadcast, DPR_CAP);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  host.appendChild(canvas);

  // The agile board's hotspot — a real button laid over the painted board (the canvas takes no
  // pointer events; every click target in the office is DOM in the label layer). Created before any
  // nameplate or speech bubble so those stay above it in paint order: a bubble drifting across the
  // wall must stay clickable. Positioned from `boardAnchor` on every bake, so it tracks resizes the
  // same way the labels do.
  const boardSpot =
    interactiveLabels && options.onBoardClick
      ? (() => {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'lc-boardspot';
          el.setAttribute('aria-label', 'Open the work board');
          const tag = document.createElement('span');
          tag.className = 'lc-boardspot__tag';
          tag.textContent = 'work board';
          el.appendChild(tag);
          el.addEventListener('click', () => options.onBoardClick!(el.getBoundingClientRect()));
          if (options.onBoardHover) {
            const warm = () => options.onBoardHover!();
            el.addEventListener('pointerenter', warm, { once: true });
            el.addEventListener('focus', warm, { once: true });
          }
          labelHost.appendChild(el);
          return el;
        })()
      : null;

  function positionBoardSpot(): void {
    if (!boardSpot) return;
    const a = boardAnchor(fit);
    boardSpot.style.left = `${a.x}px`;
    boardSpot.style.top = `${a.y}px`;
    boardSpot.style.width = `${a.w}px`;
    boardSpot.style.height = `${a.h}px`;
  }
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
  /** The front-desk receptionist (receptionist.ts) — staff, not roster; asleep when the room is empty. */
  const recep = createReceptionist();
  /** The scene clock, in seconds. Everything that animates on its own — breathing, the typing bursts —
   * reads it, so it advances only while the loop runs and a rested office holds its frame. */
  let clock = 0;
  let placements = new Map<string, Placement>();
  // The caption rail (first-five-seconds §2): one transient plain-language line. The queue/hold
  // logic lives here in the lazy chunk; the LINE renders in WorkStack's header via onCaption.
  let rail: CaptionRail = { current: null, shownAt: 0, queue: [] };
  let railTimer: ReturnType<typeof setInterval> | null = null;
  let onlineNames = new Set<string>();
  // The receptionist welcome (first-five-seconds §4) — stepped on a coarse timer; her bubble rides
  // the ordinary speech machinery via the synthetic 'receptionist' head injected each bake.
  const welcome = createWelcome(broadcast, typeof localStorage === 'undefined' ? null : localStorage);
  const welcomeTimer = setInterval(() => {
    if (STILL) return; // deterministic measurement mode: nothing transient may start
    if (!broadcast && (suspended || !VISIBLE())) return;
    // The team name is hers to say: she is the one character on the floor whose job is to tell a
    // stranger where they have landed (welcome.ts).
    const line = stepWelcome(welcome, Date.now(), actors.active(), teamName);
    if (line) showSpeech(RECEPTIONIST_SPEAKER, line, 'info');
  }, 5_000);
  function renderRail() {
    // The line is chrome now, not scene DOM — hand it out and let WorkStack's header carry it.
    options.onCaption?.(rail.current);
    if (rail.current === null && rail.queue.length === 0) {
      if (railTimer) clearInterval(railTimer);
      railTimer = null;
    } else if (!railTimer) {
      // Tick only while something shows or waits — no standing interval on an idle rail.
      railTimer = setInterval(() => {
        rail = tickCaption(rail, Date.now());
        renderRail();
      }, CAPTION_HOLD_MS / 4);
    }
  }
  function pushRail(caption: Caption) {
    rail = pushCaption(rail, caption, Date.now());
    renderRail();
  }
  let teamName = 'revive';
  let teamWorkingHours: OfficeData['teamWorkingHours'] = null;
  let wallBoard: WallBoard | null = null; // the wall's agile board (bake-time data)
  let heads = new Map<string, Pt>(); // home head anchors — where in-place cues sit
  let occupied = false; // any online member on the floor → overhead lights on
  let lightEnv: LightEnv = computeLightEnv(pstNowHours(), occupied); // office lighting from the PST clock

  const labels = new Map<string, HTMLDivElement>();
  const speeches = new Map<string, Speech>(); // one live speech bubble per member (name → bubble)
  const cues: Cue[] = [];

  const AUTO_COLLAPSE_MS = 5000;
  /** Expand + timer state survives syncLabels DOM rebuilds. */
  const plateExpand = new Map<
    string,
    { expanded: boolean; timer: ReturnType<typeof setTimeout> | null }
  >();

  function clearExpandTimer(name: string) {
    const st = plateExpand.get(name);
    if (!st?.timer) return;
    clearTimeout(st.timer);
    st.timer = null;
  }

  function applyExpandDom(name: string, expanded: boolean) {
    const el = labels.get(name);
    if (!el) return;
    el.classList.toggle('is-expanded', expanded);
    // The plate is the toggle now, so it carries the state a screen reader announces.
    el.querySelector('.lc-gl-label__plate')?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function scheduleCollapse(name: string) {
    const st = plateExpand.get(name);
    if (!st?.expanded) return;
    clearExpandTimer(name);
    st.timer = setTimeout(() => {
      st.expanded = false;
      st.timer = null;
      applyExpandDom(name, false);
    }, AUTO_COLLAPSE_MS);
  }

  function toggleExpand(name: string) {
    if (!interactiveLabels) return;
    let st = plateExpand.get(name);
    if (!st) {
      // Seeded from the flag for the same reason: without this, the first click on a plate that
      // MOUNTED open would set expanded=true — a no-op the viewer reads as a dead control.
      st = { expanded: platesOpen, timer: null };
      plateExpand.set(name, st);
    }
    clearExpandTimer(name);
    st.expanded = !st.expanded;
    applyExpandDom(name, st.expanded);
    // The tick lives HERE and not in applyExpandDom, whose other caller is scheduleCollapse's
    // timer — a tick from a timer is feedback for an action nobody chose (E4 spec §2).
    const at = heads.get(name);
    roomTone.moment(st.expanded ? 'plateOpen' : 'plateClose', at ? screenPan(at.x, width) : 0);
  }

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

  // Pause the RAF loop when the tab is backgrounded (no CPU on an unseen office) — except in broadcast
  // mode, where an unseen office is the normal case and the loop must keep feeding the capture.
  const VISIBLE = () => officeVisible(broadcast);

  // Suspended = the panel is collapsed (opacity: 0, still mounted). Measured before this flag: a
  // collapsed office kept the full-scene ambient repaint running at ~18fps for invisible pixels —
  // any `working` seat keeps `living()` true, so the "rest on a still frame" state never engages on
  // a working team. While suspended the loop parks and ambient beats skip; `setSuspended(false)`
  // re-bakes and paints one fresh frame immediately, so re-expanding is still instant.
  let suspended = false;

  function sizeCanvases() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    for (const c of [canvas, buf]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    // The backing store above is in DEVICE pixels; the element still needs its CSS size, or it lays
    // out at the attribute size and renders `dpr`× too large. `/live` never saw this because
    // `.lc-gl-canvas canvas { width/height: 100% !important }` supplies it there — which is exactly
    // why the landing hero (host `.hero__canvas`, no such rule) shipped a 2× scene on musterd.io
    // until 2026-08-13. A scene must size its own canvas correctly for any host, not depend on the
    // consumer's stylesheet; `/live`'s `!important` rules still win over these, so nothing moves there.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
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

  /** Recompute the office lighting from the PST clock + occupancy + the team's declared shift, and push
   * the natural-light wash (tint + strength) to the CSS overlay. Returns whether the *canvas* light
   * (night veil / desk lamps) crossed a step and so needs a rebake — the caller decides whether to act
   * on it. */
  function refreshLightEnv(): boolean {
    const prev = lightEnv;
    const inShift = teamWorkingHours
      ? isWithinWorkingHours(teamWorkingHours, new Date(), lightOverrideHours() ?? undefined)
      : null;
    lightEnv = computeLightEnv(pstNowHours(), occupied, inShift);
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
    const anchors = renderScene(
      bctx,
      fit,
      placements,
      nodes,
      poses,
      clock,
      teamName,
      lightEnv,
      pet,
      actors.sceneFx(),
      recep,
      wallBoard,
      teamWorkingHours,
    );
    heads = anchors.heads;
    // The receptionist's bubble anchor — synthetic head above her desk. syncLabels skips names
    // without a node, so she gains a voice without gaining a nameplate or a roster row.
    const rp = project(RECEPTIONIST.lx, RECEPTIONIST.ly, fit);
    heads.set(RECEPTIONIST_SPEAKER, { x: rp.x, y: rp.y - 58 * fit.scale });
    syncLabels(anchors.heads, nodes, poses);
    repositionSpeeches(anchors.heads);
    positionBoardSpot();
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
   * truth; the "+N" pills and location carry the secondary read.
   *
   * Present members: collapsed plate is dot + name + provider icon; expand grows a divider after the
   * name and reveals model · harness · role behind it. Broadcast: icon + short model only. */
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
        if (interactiveLabels) el.tabIndex = 0;
        labelHost.appendChild(el);
        labels.set(name, el);
      }
      el.textContent = '';
      el.style.pointerEvents = interactiveLabels ? 'auto' : 'none';
      el.classList.toggle('is-broadcast', !interactiveLabels);
      /* The plate's rim wears the seat's own hue rather than the house mustard — the same identity
         the body under it is painted in. `memberColor`, a FILL: the CSS mixes it into the paper rim
         at 34% and it never carries text, so the fill/ink split is respected. */
      el.style.setProperty('--lc-plate-hue', node.color);

      const present = node.presence !== 'offline';
      // Absent state means the viewer has not touched this plate yet, which is where `?plates-open`
      // lands: the DEFAULT is open under the flag, so plates mount unpacked with no transition to
      // race. An explicit state always wins, so a viewer collapsing one still collapses it.
      const expanded = plateExpand.get(name)?.expanded ?? platesOpen;
      el.classList.toggle('is-expanded', expanded);

      const meta = identityMeta({
        surface: node.surface,
        model: node.model,
        role: node.role,
      });

      const plate = document.createElement('span');
      plate.className = 'lc-gl-label__plate';
      const dot = document.createElement('span');
      dot.className = `lc-gl-label__dot lc-gl-label__dot--${DOT_STATE[node.posture]}`;
      plate.appendChild(dot);
      const who = document.createElement('span');
      who.className = 'lc-gl-label__who';
      who.textContent = name;
      plate.appendChild(who);

      if (present) {
        // The divider only exists once there is detail to divide from the name. Collapsed, the plate
        // is a dot, a name and the provider mark — the chevron is gone because the plate itself has
        // always been the click target, so the arrow was a second affordance for the same gesture
        // paying rent in the one dimension that matters at twenty seats.
        const plateRule = document.createElement('span');
        plateRule.className = 'lc-gl-label__rule';
        plateRule.setAttribute('aria-hidden', 'true');
        plate.appendChild(plateRule);

        if (node.dnd) {
          // dnd is prominent on the COLLAPSED plate (presence-honesty §3): same slot grammar as the
          // service tag, filled pill in the warn ink — visible at both scales without expanding.
          const dndTag = document.createElement('span');
          dndTag.className = 'lc-gl-label__dnd';
          dndTag.textContent = 'dnd';
          plate.appendChild(dndTag);
        }
        if (node.woken) {
          // Why this seat is in the room (ADR 131) — a wake put it there, rather than a person
          // opening a session. On the COLLAPSED plate, same slot grammar as `dnd` and `service`,
          // because the window it has to be read in is the whole problem: a clean codex wake held
          // presence for ELEVEN SECONDS (claim 14:19:04 → ws_close 14:19:15). A fact that only
          // appears on expand is a fact nobody will ever expand in time to see.
          // Quieter than `dnd` on purpose. dnd is an instruction to the room — do not walk to me —
          // and it outranks this; `woken` is context you check once something has caught your eye.
          const wokenTag = document.createElement('span');
          wokenTag.className = 'lc-gl-label__woken';
          wokenTag.textContent = 'woken';
          plate.appendChild(wokenTag);
        }
        if (node.service) {
          // A service seat has no model to attest (ADR 232 — it is pure code), so the provider
          // slot would render the unknown-"?" mark and read as a broken attestation. Say what it
          // is instead: a small mono "service" tag where the icon would sit.
          const tag = document.createElement('span');
          tag.className = 'lc-gl-label__service';
          tag.textContent = 'service';
          plate.appendChild(tag);
        } else {
          const provider = modelProvider(node.model);
          const icon = document.createElement('span');
          icon.className = 'lc-gl-label__provider';
          icon.style.borderColor = provider.border;
          icon.style.background = provider.fill;
          icon.innerHTML = providerIconHtml(provider);
          plate.appendChild(icon);
        }

        // The detail is a two-part nest on purpose: the outer element is the animating *track* (a
        // 0fr→1fr grid column, which is the only way to slide open to a width nobody knows in
        // advance), and the inner one holds the content at its natural size so the track can clip it.
        const detail = document.createElement('span');
        detail.className = 'lc-gl-label__detail';
        const detailIn = document.createElement('span');
        detailIn.className = 'lc-gl-label__detailin';
        // Services carry no model: the tag above already says what they are, so the expanded
        // detail is harness · role only, and broadcast (model crumb only) shows nothing extra.
        const detailParts = interactiveLabels
          ? plateDetailParts({
              surface: node.surface,
              model: node.service ? null : node.model,
              role: node.role,
            })
          : plateDetailParts({ model: node.service ? null : node.model }).filter(
              (p) => p.kind === 'model',
            );
        for (const [i, part] of detailParts.entries()) {
          if (i > 0) {
            const divider = document.createElement('span');
            divider.className = 'lc-gl-label__rule';
            divider.setAttribute('aria-hidden', 'true');
            detailIn.appendChild(divider);
          }
          const segEl = document.createElement('span');
          segEl.className = `lc-gl-label__seg lc-gl-label__seg--${part.kind}`;
          // The three harnesses whose seats a provider pin cannot distinguish (a cursor seat's pin
          // says Claude) get a glyph + their own ink; everything else stays bare text.
          const glyph = part.kind === 'harness' ? surfaceGlyph(node.surface) : null;
          if (glyph) {
            segEl.classList.add(`lc-gl-label__seg--hz-${glyph.id}`);
            const mark = document.createElement('span');
            mark.className = 'lc-gl-label__hz';
            mark.setAttribute('aria-hidden', 'true');
            mark.innerHTML = glyph.svg;
            segEl.appendChild(mark);
            segEl.appendChild(document.createTextNode(part.text));
          } else {
            segEl.textContent = part.text;
          }
          detailIn.appendChild(segEl);
        }
        // Each child carries its own position so ONE css rule can stagger them. Five nth-child rules
        // did the same job and cost enough gzip to sit on the CSS budget's ceiling.
        for (const [i, child] of [...detailIn.children].entries()) {
          (child as HTMLElement).style.setProperty('--i', String(i));
        }
        detail.appendChild(detailIn);
        plate.appendChild(detail);

        if (interactiveLabels) {
          // The caret is the affordance, and it is back because removing it went too far: the plate
          // got 34% narrower for the twenty-seat floor, and nothing on it said it could open
          // (nick, 2026-08-03: "i cant tell i am able to expand the nameplate"). It rides the plate's
          // right edge, turns a quarter-turn on open, and costs ~7px — the width is worth paying for
          // a control nobody can find otherwise.
          const caret = document.createElement('span');
          caret.className = 'lc-gl-label__caret';
          caret.setAttribute('aria-hidden', 'true');
          plate.appendChild(caret);

          // The plate itself is the button — the caret is a picture of one, not a second target.
          plate.setAttribute('role', 'button');
          plate.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          plate.setAttribute('aria-label', `${name} identity`);
          plate.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExpand(name);
          });
        }
      }
      el.appendChild(plate);

      if (interactiveLabels) {
        el.addEventListener('pointerenter', () => clearExpandTimer(name));
        el.addEventListener('pointerleave', () => scheduleCollapse(name));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpand(name);
          }
        });
      }

      const chip = shortLaneState(node.laneState);
      const said = node.workSource === 'status';
      const showWork =
        showWorkCues && present && node.workTitle != null && node.workTitle.length > 0;
      if (showWork) {
        const workEl = document.createElement('span');
        workEl.className = `lc-gl-label__work${chip === 'blocked' ? ' is-blocked' : ''}`;
        workEl.textContent = shortWorkTitle(node.workTitle!);
        el.appendChild(workEl);
      }

      if (interactiveLabels && (meta.title || node.workTitle)) {
        const tip = document.createElement('div');
        tip.className = 'lc-gl-label__tip';
        tip.setAttribute('role', 'tooltip');
        const tipLines = [
          meta.title || null,
          node.workTitle
            ? `${node.workTitle}${chip ? ` (${chip})` : ''}${said ? ' · said' : ''}${
                node.moreLanes > 0 ? ` · +${node.moreLanes}` : ''
              }`
            : null,
        ].filter(Boolean);
        tip.textContent = tipLines.join('\n');
        el.appendChild(tip);
        el.title = '';
      } else if (meta.title) {
        el.title = meta.title;
      } else {
        el.title = '';
      }

      el.classList.toggle('is-offline', node.presence !== 'online');
      el.style.transform = `translate(-50%, -100%) translate(${head.x}px, ${head.y}px)`;
    }
    for (const [name, el] of labels) {
      if (!seen.has(name)) {
        clearExpandTimer(name);
        plateExpand.delete(name);
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

  /**
   * The light-trace: one quadratic arc from just under the speaker's bubble to the recipient's head,
   * bowed upward so it clears the furniture between them rather than cutting through the room. Sized
   * to the bounding box of the two anchors (plus the bow) so the SVG never covers the whole stage and
   * intercepts nothing — it is inert decoration over a canvas that owns the pointer.
   */
  function drawTether(from: Pt, to: Pt): SVGSVGElement {
    const bow = Math.min(120, Math.max(48, Math.hypot(to.x - from.x, to.y - from.y) * 0.28));
    const y0 = from.y - SPEECH_LIFT + 8; // leaves the bubble at its lower edge, not the head
    const cx = (from.x + to.x) / 2;
    const cy = Math.min(y0, to.y) - bow;
    const minX = Math.min(from.x, to.x) - 2;
    const minY = cy - 2;
    const w = Math.abs(to.x - from.x) + 4;
    const h = Math.max(y0, to.y) - minY + 4;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lc-speech-trace');
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${from.x} ${y0} Q${cx} ${cy} ${to.x} ${to.y}`);
    // The dash is the whole path length, so the CSS animation draws it on from the speaker's end.
    svg.appendChild(path);
    return svg;
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
  function showSpeech(
    who: string,
    raw: string,
    tone: string,
    id?: string,
    act?: string,
    addressee?: Addressee | null,
    marking?: SpeechMarking | null,
  ) {
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
    /* ── the bubble's colour is WHO, not WHAT ──────────────────────────────────────────────────
       `--lc-speech-tone` names an act tone for historical reasons and now carries the sender's
       identity hue: ring, tail, blush and glow all come off it, so every bubble a member speaks
       looks like that member and no other. See speech.ts `speechMark` for the full argument and
       for where the act went instead.

       Two values, because a colour that is both SEEN and READ needs two (format.ts, and the
       --lc-*-ink block in Live.css). `node.color` is `memberColor` — a FILL, and it spans luminance
       0.154–0.699 across the hue bands, so mixing it into the rich-token text colours would be
       readable for indigo and not for amber. `memberInk` is the same hue held at a luminance that
       clears AA on the paper, and it is what the text usages mix with.

       The receptionist is not in the node map (she is staff, not roster — receptionist.ts), so she
       falls through to the act tone and to her own stock in the CSS. That is the intended path, not
       a gap: she is the one speaker on the floor with no identity to paint. */
    const speaker = actors.nodes().get(who);
    inner.style.setProperty('--lc-speech-tone', speaker ? speaker.color : toneColor(tone));
    // Both are set on every bubble, never one of them: `--lc-speech-ink` has no `:root` definition
    // (it is runtime-parametric, which is what exempts it from `tokens:check`), so a bubble that set
    // only the tone would leave every text usage with an unresolved var() — and an unresolved
    // `color:` is not an error, CSS just drops the declaration and the span silently inherits. That
    // is the exact failure mode the --lc-type-* note in packages/web/AGENTS.md records costing three
    // of six tokens in #1104. The receptionist gets the act tone for both, which is what she had.
    inner.style.setProperty(
      '--lc-speech-ink',
      speaker ? memberInk(who, speaker.kind, speaker.hue) : 'var(--lc-paper-ink)',
    );
    if (marking) {
      inner.classList.add(`is-mark--${marking.mark}`);
      // The loud variant of `needs-human`: the tier actually holds its sender (ADR 147 §2), so
      // nothing that seat was doing moves again until a person answers.
      if (marking.holds) inner.classList.add('is-holding');
      /* A real element rather than a pseudo, for two reasons that both bit: `__inner`'s ::before
         and ::after are the bubble's tail, and hanging the badge off `__text::after` instead
         anchored it to the TEXT — so on a bubble with a recipient chip it landed halfway down the
         body instead of at the corner. As a child of `__inner` it sits against the bubble's own box
         and inherits the enter/fade transition, which a pseudo on the outer wrapper would not. */
      const badge = document.createElement('span');
      badge.className = 'lc-speech__mark';
      badge.textContent = SPEECH_MARK_GLYPH[marking.mark];
      badge.setAttribute('aria-hidden', 'true');
      inner.appendChild(badge);
    }

    /* ── the receptionist's bubble is HOUSE, not a member's ────────────────────────────────────
       Everything the room says about itself comes out of her mouth — where you are, what these
       people are, what the bubbles mean (welcome.ts). Until now that arrived wearing the same paper
       and the same tail as an agent's status update, which quietly made the house voice look like a
       eleventh seat: the one bubble on the floor that is NOT an attested member speaking was the one
       hardest to tell apart from one.
       Same argument as receptionist.ts's "staff, not roster" — no nameplate, no headcount, no roster
       row — carried into the one place she does appear as a speaker. She gets the brand mark rather
       than an identity hue, because the mark IS her identity: she speaks for musterd, not for a
       seat. */
    if (who === RECEPTIONIST_SPEAKER) {
      outer.classList.add('is-reception');
      const mark = document.createElement('span');
      mark.className = 'lc-speech__brand';
      // Static markup from a constant path (brand/chipMark.ts) — no interpolated content ever
      // reaches it. Same shape as the provider pin and the harness glyph above.
      mark.innerHTML = musterdChipSvg(13);
      inner.appendChild(mark);
    }
    // ── the recipient chip ────────────────────────────────────────────────────────────────────
    // A directed act names who it is aimed at, so the body can safely say "you". Team and broadcast
    // acts pass no addressee: the team is already the default audience, and a chip on every bubble
    // would be chrome. The chip carries MEANING, so unlike the tether it survives reduced-motion
    // and measurement mode.
    if (addressee) {
      const chip = document.createElement('span');
      // A set chip drops the single-name width clamp: at 3-4 names the clamp ellipsises, and a chip
      // that names the set and then hides part of it is the failure this whole path exists to end.
      chip.className = addressee.names.length > 1 ? 'lc-speech__to lc-speech__to--set' : 'lc-speech__to';
      chip.textContent = `→ ${addressee.label}`;
      inner.appendChild(chip);
    }
    const textEl = document.createElement('span');
    textEl.className = 'lc-speech__text';
    inner.appendChild(textEl);

    // ── rich token rendering ──────────────────────────────────────────────────────────────────
    // The bubble speaks the stream's rich-text vocabulary: **strong**, `code`, #refs, collapsed
    // ULIDs, SHAs, plus the lane/goal lead verb — each a styled span, not a flat text dump. The
    // typewriter reveals *across* tokens: prose slices in char by char, chips pop in whole the
    // moment the reveal reaches them (a little beat of delight, honest to the token's atomicity).
    const glanceTokens = speechTokens(glance);
    const fullTokens = clamped ? speechTokens(full) : glanceTokens;
    interface Rendered {
      node: Text | HTMLElement;
      text: string;
      chip: boolean;
    }
    /** (Re)build textEl from tokens; `revealed` = show everything at once (hover/finish/reduced). */
    const buildTokens = (tokens: SpeechToken[], revealed: boolean): Rendered[] => {
      textEl.textContent = '';
      const out: Rendered[] = [];
      for (const t of tokens) {
        if (t.kind === 'text') {
          const node = document.createTextNode(revealed ? t.text : '');
          textEl.appendChild(node);
          out.push({ node, text: t.text, chip: false });
        } else {
          const el = document.createElement('span');
          el.className = `lc-st lc-st-${t.kind}`;
          el.textContent = t.text;
          if (t.kind === 'id') el.title = t.title; // full ULID one hover away
          if (!revealed) el.classList.add('is-off');
          textEl.appendChild(el);
          out.push({ node: el, text: t.text, chip: true });
        }
      }
      return out;
    };
    /** Advance the reveal to `n` visible characters: prose slices, chips pop whole. */
    const reveal = (rendered: Rendered[], n: number) => {
      let cum = 0;
      for (const r of rendered) {
        const take = Math.max(0, Math.min(r.text.length, n - cum));
        if (r.chip) {
          if (take > 0) (r.node as HTMLElement).classList.remove('is-off');
        } else {
          (r.node as Text).nodeValue = r.text.slice(0, take);
        }
        cum += r.text.length;
      }
    };
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

    // ── the light-trace ───────────────────────────────────────────────────────────────────────
    // A soft arc from the bubble toward the recipient's desk, drawn once and fading as the bubble
    // settles: it makes the room read as wired together rather than as a set of separate speakers.
    // Pure delight, so it stands down wherever delight is not wanted — reduced motion, and STILL
    // (ADR 285) where a moving line would make the contrast sweep nondeterministic. A recipient who
    // isn't on the floor (offline, or capped out of the render) has no desk to point at, so the
    // chip stands alone.
    //
    // An ADR 254 eligible set names 2–4 seats, any one of whom discharges the act, so it gets a
    // trace to EACH of their desks rather than a picked one: the room shows the same ambiguity the
    // ledger holds. A sender inside their own set is skipped here for the same reason a self-
    // addressed member act drops its tether.
    const targets = addressee?.tether
      ? addressee.names.filter((n) => n !== who).map((n) => heads.get(n))
      : [];
    const drawn = targets.filter((t): t is NonNullable<typeof t> => t !== undefined);
    if (drawn.length > 0 && !reduced && !STILL) {
      for (const target of drawn) {
        const trace = drawTether(head, target);
        labelHost.appendChild(trace);
        s.cancels.push(() => trace.remove());
      }
      // The whoosh deliberately follows the tether's own gate (E4 spec §2): a sweep describing
      // motion that is not drawing would be a lie. Pan rides sender → addressee with the trace, and
      // stays ONE sweep however many traces drew — four whooshes for one act is noise, not weight.
      roomTone.moment('whoosh', screenPan(head.x, width), screenPan(drawn[0]!.x, width));
    }

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
        buildTokens(fullTokens, true);
        outer.classList.add('is-expanded');
        // measure on the next frame so the expanded (clamp-removed) layout has painted
        requestAnimationFrame(() => {
          inner.style.setProperty('--lc-speech-h', `${inner.scrollHeight}px`);
        });
      };
      collapse = () => {
        outer.classList.remove('is-expanded');
        inner.style.removeProperty('--lc-speech-h');
        buildTokens(glanceTokens, true);
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
      if (STILL) return; // measurement mode: the bubble stays up, so the sweep measures a room that stops
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
      buildTokens(glanceTokens, true);
      begin();
      return;
    }

    const rendered = buildTokens(glanceTokens, false);
    const total = speechLength(glanceTokens);
    const caret = document.createElement('span');
    caret.className = 'lc-caret';
    textEl.appendChild(caret); // unrevealed nodes are empty/hidden, so the caret rides the frontier
    let i = 0;
    finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      caret.remove();
      buildTokens(glanceTokens, true);
      begin();
    };
    const iv = setInterval(() => {
      i += 1;
      reveal(rendered, i);
      if (i >= total) finish();
    }, typeCadence(total));
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
    const anchors = renderScene(
      ctx,
      fit,
      placements,
      actors.nodes(),
      actors.poses(),
      clock,
      teamName,
      lightEnv,
      pet,
      actors.sceneFx(),
      recep,
      wallBoard,
      teamWorkingHours,
    );
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
    // The same predicate the renderer types on and the room-tone `working[]` is collected by
    // (E2 spec §2's park invariant): keyed on activity while the renderer keyed on posture, a
    // posture-working seat with stale activity froze mid-typing on the park frame — and the sound
    // layer would have kept typing after the room visually idled.
    for (const n of actors.nodes().values()) if (audiblyWorking(n)) return true;
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
  // Render counters for a capture harness (OfficeHandle.stats). Under broadcast, `draws` tracks the
  // capture fps while `ticks` tracks rAF — the gap is the waste the draw-rate cap removes.
  let ticks = 0;
  let draws = 0;
  const since = performance.now();
  function tick(now: number) {
    ticks++;
    // Frame-rate coalescing: viewers cap ambient-only motion to ~20fps (ADR 086 Phase 2). Broadcast
    // coalesces *every* stretch to the capture fps so paint matches encode (no #368 judder, no full-rAF
    // waste). `dt` accumulates either way, so walk maths stay correct with fewer samples.
    const inAfterglow = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    const noRealMotion = actors.ambientOnly() || !actors.active();
    const ambientOnly = noRealMotion && cues.length === 0 && !inAfterglow;
    const capped = shouldCoalesceDraw(broadcast, ambientOnly);
    acc += last ? now - last : 1000 / 60;
    last = now;
    if (capped && acc < ambientFrameBudgetMs(broadcast, AMBIENT_FRAME_MS, captureFps)) {
      raf = requestAnimationFrame(tick); // too soon for the next coalesced frame — keep the loop, skip the draw
      return;
    }
    draws++;
    const dt = Math.min(0.05, acc / 1000);
    acc = 0;
    clock += dt;
    const walking = actors.step(dt);
    if (walking) noticePassersBy(); // a sleeping dog wakes to watch whoever is walking past it
    const petActive = stepPet(pet, dt); // false once it's asleep — the pet never keeps the room awake
    // The receptionist wakes for a present member and looks up while any check-in beat holds. Like
    // the pet, she never keeps an empty room awake: asleep returns false and the room bakes still.
    const anyonePresent = [...actors.nodes().values()].some((n) => n.presence !== 'offline');
    const recepActive = stepReceptionist(recep, dt, anyonePresent, actors.checkInHolds() > 0, { team: teamName, nowMs: Date.now() });
    pushOccupancy(now);
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
    if (walking || alive || petActive || recepActive) {
      drawDynamic();
    } else {
      if (wasActive) bake(); // walkers just re-seated (or the pet/receptionist dozed off) — refresh
      drawStatic();
    }
    wasActive = walking || alive || petActive || recepActive;
    // Keep animating while anything moves *or* while the room is alive (someone at a desk breathing and
    // typing — capped to ~20fps above). When the last walk/cue clears and nobody is working, we draw one
    // final settled frame and park: the frame stays on-canvas until the next act or presence change.
    // Afterglow: a brief tail past the last motion so a character eases into idle instead of freezing
    // mid-gesture — `actors.step` also reports its own blends, so a member never stops half-out of a chair.
    const settling = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    if ((walking || cues.length || settling || alive || petActive) && !reduced && !suspended && VISIBLE()) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
      acc = 0;
      // The loop is parking, so occupancy stops updating — hand the sound layer a final snapshot
      // with `working: []` as the floor of the park invariant (E2 spec §2): a parked room must not
      // keep typing off its last live snapshot.
      pushOccupancy(now, true);
    }
  }
  function ensureLoop() {
    if (!raf && !reduced && !suspended && VISIBLE()) {
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

  // ── occupancy → room tone ──────────────────────────────────────────────────────────────────────
  // The scene tells the sound engine who is near whom, so the murmur only plays when two members
  // actually share a zone and pans toward them (life/sound design §2.2). One-way and throttled: the
  // engine never reads the scene, and a push every couple of seconds is plenty for a layer whose
  // events are 2.5–8s apart.
  let occAt = 0;
  /** When the last act cue landed — the "recent act rate" nudge in `density` (E2 spec §2). */
  let actPulseAt = 0;
  /** FNV-ish name hash (same idiom as seating's) — a desk's audio seed is as stable as its chair. */
  const audioSeed = (name: string): number => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h;
  };
  function pushOccupancy(now: number, parked = false): void {
    if (!parked && now - occAt < 2000) return;
    occAt = now;
    const toX = (lx: number, ly: number): number => {
      const sx = project(lx, ly, fit).x;
      return Math.max(-1, Math.min(1, (sx / width) * 2 - 1));
    };
    // Group present members by shared zone: a pod (desk slots), a leisure zone, or the nook.
    const zones = new Map<string, { lx: number; ly: number }[]>();
    // Desks that may type, tap and creak (E2 spec §2/§3) — collected by `audiblyWorking` (posture,
    // never activity) so the ears agree with the typing the eyes see. Forced empty on the park
    // frame: the parked room is exactly the room that should be quiet.
    const working: { x: number; seed: number }[] = [];
    let present = 0;
    for (const [name, pl] of placements) {
      const node = actors.nodes().get(name);
      if (!node || node.presence === 'offline') continue;
      present++;
      let zone: string | null = null;
      let at: { lx: number; ly: number } | null = null;
      if (pl.kind === 'desk') {
        const slot = DESK_SLOTS[pl.slot];
        if (slot) {
          // Bench neighbours and the two window desks are proximity zones of their own — two bench
          // sitters are exactly the "near each other" pair the room tone listens for.
          zone = slot.kind === 'pod' ? `pod-${slot.pod}` : slot.kind;
          at = { lx: slot.lx, ly: slot.ly };
          if (!parked && audiblyWorking(node)) {
            working.push({ x: toX(slot.lx, slot.ly), seed: audioSeed(name) });
          }
        }
      } else if (pl.kind === 'leisure') {
        const spot = LEISURE_SPOTS[pl.spot];
        if (spot) {
          zone = spot.zone;
          at = { lx: spot.lx, ly: spot.ly };
        }
      } else if (pl.kind === 'nook') {
        zone = 'lounge';
        at = { lx: 700, ly: 190 };
      }
      if (zone && at) {
        const list = zones.get(zone) ?? [];
        list.push(at);
        zones.set(zone, list);
      }
    }
    const pairs: { x: number }[] = [];
    for (const members of zones.values()) {
      if (members.length >= 2) {
        const mid = members.slice(0, 2);
        pairs.push({ x: toX((mid[0]!.lx + mid[1]!.lx) / 2, (mid[0]!.ly + mid[1]!.ly) / 2) });
      }
    }
    // Work intensity: the working share of who is present, nudged up while acts are actually
    // landing (a fading pulse, gone after a quiet minute). Tempo and mix only — never gain.
    const share = present > 0 ? working.length / present : 0;
    // Wall clock, not the rAF timestamp `now` — `actPulseAt` is stamped with Date.now().
    const actNudge = Math.max(0, 0.25 * (1 - (Date.now() - actPulseAt) / 60_000));
    const ctx: LifeContext = {
      pairs,
      // An asleep dog is a quiet dog — it neither pads nor jingles.
      dog: pet.mode === 'sleep' ? null : { x: toX(pet.lx, pet.ly), walking: pet.mode === 'walk' },
      working,
      density: Math.min(1, share + (working.length > 0 ? actNudge : 0)),
      // The same envelope the daylight overlay and the wall clock read — audio and window light
      // can never disagree, and `?light=HH` overrides audio too.
      daylight: lightEnv.daylight,
      hours: lightEnv.hours,
    };
    roomTone.setOccupancy(ctx);
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
  function coffeeStroll(who: string, slot: number): boolean {
    if (!actors.ambientWalk(who)) return false;
    if (roll(teamName, slot, 'pet-follow') < 0.5) petFollow(pet, COFFEE_STAND, slotRng(teamName, slot, 'pet-follow-walk'));
    return true;
  }

  function quiet(): boolean {
    return !actors.active() && cues.length === 0 && !(lastActive > 0 && performance.now() - lastActive < AFTERGLOW_MS);
  }
  /** The shared beat log — the E1 falsifier: what the slot lattice decided, and whether this browser
   * could play it. Two visible viewers over the same interval must log the same slots, actors, and
   * beats in the same order; `played` is the one honest per-browser field (a locally busy room skips
   * a beat, bounded to that one slot). Read from CDP via the `window.__office` handle. */
  const ambientLog: AmbientLogEntry[] = [];
  function logAmbient(e: AmbientLogEntry): void {
    ambientLog.push(e);
    if (ambientLog.length > 200) ambientLog.shift();
  }
  function scheduleAmbient() {
    /* `STILL` sits beside `reduced` rather than inside `fireAmbient`: the point is that no timer is
       left ARMED, not merely that the beat is skipped when it lands. A scheduler that keeps
       re-arming and declining still re-enters the page's timer set, and the next reader wonders why
       a "held" room has a pending callback. Same reason `disposed` is checked here. */
    if (reduced || disposed || STILL) return;
    if (ambientTimer) clearTimeout(ambientTimer);
    // Armed to the next slot boundary, not a random delay: the wall-clock lattice is the scheduling
    // quantum (E1 spec §2), so every viewer of this team wakes at the same instants. The +5ms nudge
    // keeps a timer that fires a hair early from landing in the old slot and drawing stale rolls.
    ambientTimer = setTimeout(fireAmbient, AMBIENT_SLOT_MS - (Date.now() % AMBIENT_SLOT_MS) + 5);
  }
  function fireAmbient() {
    ambientTimer = null;
    if (disposed) return; // office torn down between the timer arming and firing — don't re-arm or wake

    // Only stir a calm, visible room; otherwise let this slot pass and wait for the next one. The
    // decision itself is pure over roster-derived inputs (stanley's E1 review item): local scene
    // state may veto PLAYING a beat, but it can never change WHICH beat every viewer chose.
    if (!reduced && !suspended && VISIBLE() && quiet()) {
      const slot = slotAt(Date.now());
      const nodes = actors.nodes();
      const members: string[] = [];
      // Mirrors `homePoses`'s desk test exactly: present desk members, minus owned (empty) desks.
      for (const [name, pl] of placements) {
        if (pl.kind === 'desk' && !pl.owned && nodes.has(name)) members.push(name);
      }
      const decision = decideAmbient(teamName, slot, {
        members,
        pairs: deskNeighbourPairs(placements, nodes),
      });
      if (decision.kind === 'pet') {
        // The pet's beat: it wakes, stretches, pads to a fresh nap spot (a sunbeam by day, a rug by
        // night, occasionally a working member's side) and curls back up.
        const played = petBeat(pet, {
          daylight: lightEnv.daylight,
          workSpots: workingSideSpots(),
          rng: slotRng(teamName, slot, 'pet-beat'),
        });
        logAmbient({ slot, kind: 'pet', played });
        if (played) ensureLoop();
      } else if (decision.kind === 'pair') {
        // The pair beat: two neighbours turn and talk — the one beat with two subjects, so it is
        // decided above the per-member pick.
        const played = actors.deskChat(decision.a, decision.b, slotRng(teamName, slot, 'chat'));
        logAmbient({ slot, kind: 'pair', pair: [decision.a, decision.b], played });
        if (played) ensureLoop();
      } else if (decision.kind === 'member') {
        const played = playAmbientBeat(decision.who, slot);
        logAmbient({ slot, kind: 'member', who: decision.who, played });
        if (played) ensureLoop();
      }
    }
    scheduleAmbient();
  }

  /**
   * One ambient beat for one idle desk member: a weighted pick over the beats they can actually play —
   * the chair beats (swivel/roll) need casters under them, a sip needs a mug on that desk — with the
   * coffee-stroll staying in the mix at ~1 in 5. Weighted rather than uniform so the broad, always-valid
   * beats (stretch/glance/scratch/chin/lean) carry the room and the chair theatrics stay occasional.
   */
  function playAmbientBeat(who: string, slot: number): boolean {
    const pl = placements.get(who);
    const deskSlot = pl?.kind === 'desk' ? pl.slot : null;
    const casters = deskSlot !== null && chairKindFor(deskSlot) !== 'stool';
    const mug = deskSlot !== null && deskHasProp(deskSlot, 'coffee');
    const water = deskSlot !== null && deskHasProp(deskSlot, 'water');
    // A seated LEISURE spot (couch, meeting chair, waiting chair) is a different body: already
    // reclined with its hands in its lap, and with no desk, no casters and no mug to work against.
    // So it swaps the desk's `lean` — which would recline someone who is already reclined — for
    // `settle`, and leans the weights toward the broad, deskless beats (nick, 2026-08-31).
    const lounging = pl?.kind === 'leisure' && (LEISURE_SPOTS[pl.spot]?.sit ?? 0) > 0;
    const beats: Array<[number, () => boolean]> = [
      [15, () => actors.gestureBeat(who, GESTURE.stretch)],
      [lounging ? 20 : 15, () => actors.gestureBeat(who, GESTURE.glance)],
      [14, () => actors.gestureBeat(who, GESTURE.scratch)],
      [lounging ? 18 : 14, () => actors.gestureBeat(who, GESTURE.chin)],
      [14, () => actors.gestureBeat(who, lounging ? GESTURE.settle : GESTURE.lean)],
      // The errands — real trips with a point to them, so they stay the occasional highlight:
      [15, () => coffeeStroll(who, slot)],
      [9, () => actors.errandPhone(who, slotRng(teamName, slot, 'phone'))], // gets up, takes a call, paces, comes back
      // A meal is the one errand the dog cares about: it drops whatever it was doing and follows the
      // plate to the lounge to sit and stare at it. Not every time — a dog that never misses a meal is
      // a mechanism, and the beat reads better when you notice it happening rather than expect it.
      [
        7,
        () => {
          const seat = actors.errandFridge(who, slotRng(teamName, slot, 'fridge'));
          if (!seat) return actors.gestureBeat(who, GESTURE.glance); // lounge full → cheap fallback
          if (roll(teamName, slot, 'pet-beg') < 0.65) petBeg(pet, seat, slotRng(teamName, slot, 'pet-beg-walk'));
          return true;
        },
      ],
    ];
    if (water) beats.push([8, () => actors.errandWater(who)]);
    if (mug) beats.push([14, () => actors.gestureBeat(who, GESTURE.sip)]);
    if (casters) beats.push([9, () => actors.gestureBeat(who, GESTURE.swivel)], [5, () => actors.gestureBeat(who, GESTURE.roll)]);
    let total = 0;
    for (const [w] of beats) total += w;
    let r = roll(teamName, slot, 'beat') * total;
    for (const [w, play] of beats) {
      r -= w;
      if (r <= 0) return play();
    }
    return false;
  }

  function update(next: OfficeData) {
    const nextOnline = new Set(next.nodes.filter((n) => n.presence === 'online').map((n) => n.name));
    if (onlineNames.size > 0) {
      const line = captionForPresence(onlineNames, nextOnline);
      if (line) pushRail(line);
    }
    onlineNames = nextOnline;
    teamName = next.teamName ?? 'revive';
    teamWorkingHours = next.teamWorkingHours ?? null;
    wallBoard = next.wallBoard ?? null;
    placements = assignSeats(next.nodes);
    const byName = new Map(next.nodes.map((n) => [n.name, n]));
    // The overhead lights follow occupancy: on while anyone's online on the floor, off once the room empties.
    occupied = next.nodes.some((n) => n.presence === 'online');
    refreshLightEnv(); // fold the new occupancy (+ current clock) into the lighting before we bake
    // Animate presence changes (walk in/out, drift) unless reduced-motion asked for stillness.
    actors.setHomes(placements, byName, !reduced);
    // The pulse is read ONCE, above the motion gate: the door's sound plays under reduced-motion
    // (audio is not motion, E3 spec §2); only the visual glow stays gated.
    if (actors.takeDoorPulses() > 0) {
      roomTone.moment('door', screenPan(project(ENTRANCE.lx, ENTRANCE.ly, fit).x, width));
      if (!reduced) pushDoorCue(); // the entrance "opens" as someone comes/goes
    }
    // Someone just walked in: the dog goes to meet them at the door. Arrivals only — nobody, dog included,
    // gets up to see you leave. This outranks whatever nap it had planned, which is the whole point of it.
    if (!reduced && actors.takeArrivals() > 0) petGreet(pet);
    bake();
    if (actors.active() || cues.length) ensureLoop();
    else paintResting(); // no motion → hold a still frame (Rive-aware; not the code-drawn buffer)
  }

  function pushCue(name: string, color: string, glyph: Cue['glyph'], urgent = false) {
    actPulseAt = Date.now(); // an act just landed — the density nudge's clock (E2 spec §2)
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y + 20 }, color, glyph, t: 0, urgent });
  }

  /** The acceptance celebration burst — a one-shot confetti puff over a member's head. */
  function pushConfetti(name: string) {
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y }, color: '#5cd49a', glyph: '', t: 0, urgent: false, kind: 'confetti' });
  }

  /** The `count` nearest drawn members to `name` (excluding them) within one pod's reach — the desk
   * neighbors who plausibly noticed. Head positions are already screen-space, so plain distance works. */
  function nearestNeighbors(name: string, count: number): string[] {
    const at = heads.get(name);
    if (!at) return [];
    return [...heads.entries()]
      .filter(([n]) => n !== name)
      .map(([n, p]) => ({ n, d: Math.hypot(p.x - at.x, p.y - at.y) }))
      .filter((e) => e.d < 190 * fit.scale)
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map((e) => e.n);
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
    if (ev.kind === 'caption') {
      pushRail(ev.caption);
      return;
    }
    // Speech is legible content, not motion — it plays even under reduced-motion (typewriter off there).
    if (ev.kind === 'speech') {
      showSpeech(ev.who, ev.text, ev.tone, ev.id, ev.act, ev.addressee, ev.marking);
      // An ask lands with acoustic weight in the room (E3 spec §2): one soft held tone, panned to
      // the asked member's desk when directed, soft-centre for a team ask. Stateless by design.
      if (ev.act === 'ask') {
        // `ask` is deliberately not an ELIGIBLE_ACT (envelope.ts), so an ask's addressee is always
        // the single routed member — the first name is the only name.
        const at = ev.addressee ? heads.get(ev.addressee.names[0]!) : undefined;
        roomTone.moment('askbell', at ? screenPan(at.x, width) : 0);
      }
      return;
    }
    // The fanfare emits ABOVE the motion gate (E3 spec §2): the celebration sound plays under
    // reduced-motion; the confetti and glances below stay gated with the rest of the choreography.
    if (ev.kind === 'accept' && ev.of && ev.of !== ev.who && heads.has(ev.of)) {
      roomTone.moment('fanfare', screenPan(heads.get(ev.of)!.x, width));
    }
    if (reduced) return;
    switch (ev.kind) {
      case 'screen-pulse':
        pushCue(ev.who, toneColor(ev.tone), '');
        break;
      // `to` is a list on the three ELIGIBLE_ACTS: one name normally, 2-4 for an ADR 254 set. Each
      // name gets the identical treatment a single recipient gets — the room must not rank them,
      // because the ledger does not (nick, 2026-09-02).
      case 'note':
        pushCue(ev.from, toneColor(ev.tone), '');
        for (const to of ev.to) {
          pushCue(to, toneColor(ev.tone), '');
          pushThread(ev.from, to, toneColor(ev.tone));
        }
        break;
      case 'walk-help': {
        // The sender walks to EVERY name, one desk after another: `actors.walk` queues per call —
        // one trip in flight plus three pending, so a set at the MAX_ELIGIBLE cap of four fits
        // exactly, WITH NO HEADROOM. A sender who already has a walk running loses the tail of a
        // four-name set to the backlog guard, silently. Measured in the browser 2026-09-02: the
        // /office-preview script re-fires faster than an ~8.5s round trip drains, so from its
        // second loop on the guard refuses legs — including the single-recipient `Ada -> Bo` walk
        // that predates eligible sets entirely. That makes it a property of the queue depth and the
        // act rate, not of this fan-out; on /live, acts arrive far enough apart that it has room.
        // The fallback cue fires only if NO leg could play — one unreachable desk among several is
        // not a failed act, it is a shorter trip.
        let walked = false;
        for (const req of helpWalks(ev)) {
          pushThread(ev.from, req.to);
          if (actors.walk(ev.from, req)) walked = true;
        }
        if (!walked) {
          pushCue(ev.from, '#f4cf52', ev.tier === 'urgent' ? '!' : '', ev.tier === 'urgent');
        }
        break;
      }
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
        // The celebration (liveliness ladder inc 1, nick 2026-08-19): a directed accept lands on the
        // CELEBRANT — whose work was accepted — as confetti over their head, a green thread from the
        // acceptor, and the nearest desk neighbors turning for a beat. Event choreography only:
        // one cue lifetime, no re-arming, nothing for ?still to hold.
        if (ev.of && ev.of !== ev.who && heads.has(ev.of)) {
          pushThread(ev.who, ev.of, '#5cd49a');
          pushCue(ev.of, '#5cd49a', '✓');
          pushConfetti(ev.of);
          for (const name of nearestNeighbors(ev.of, 2)) {
            if (name !== ev.who) actors.gestureBeat(name, GESTURE.glance);
          }
        }
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
        for (const to of ev.to) pushCue(to, col, '?', ev.urgent);
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
    // ensureLoop's own suspended/reduced guards apply — a collapsed office stays parked on tab-focus.
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
    stats: () => ({ ticks, draws, since }),
    ambientLog: () => [...ambientLog],
    setSuspended: (on: boolean) => {
      // A stream never parks (ADR 157). The broadcast route has no collapse control, so this only ever
      // fires from a host surface that shouldn't be able to freeze the outgoing frame anyway.
      if (suspendIgnored(broadcast, on)) return;
      if (on === suspended) return;
      suspended = on;
      if (on) {
        // Park the loop now — no CPU behind a collapsed panel. Ambient beats self-skip via the
        // `fireAmbient` guard; the timer keeps its cadence so nothing needs re-arming on resume.
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
        acc = 0;
      } else {
        // One fresh frame immediately (light + poses may have moved while parked) → instant
        // re-expand; the loop only re-engages if the room is actually alive.
        refreshLightEnv();
        bake();
        if (living() || actors.active() || cues.length) ensureLoop();
        else paintResting();
      }
    },
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
    pokeErrand: (kind) => {
      // The errand twin of pokeGesture: play the full fridge/water/coffee arc now, on the first idle
      // member who can (a 25s fridge sequence is unverifiable if you have to wait the scheduler out).
      // Water keeps the scheduler's own gate — the bottle comes off *their desk*, so a deskless
      // (leisure) member or a desk without the prop can't play it.
      for (const who of actors.idleDeskMembers()) {
        if (kind === 'water') {
          const pl = placements.get(who);
          if (pl?.kind !== 'desk' || !deskHasProp(pl.slot, 'water')) continue;
        }
        const played =
          kind === 'fridge'
            ? actors.errandFridge(who)
            : kind === 'water'
              ? actors.errandWater(who)
              : kind === 'phone'
                ? actors.errandPhone(who)
                : coffeeStroll(who, slotAt(Date.now()));
        if (played) {
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
      if (railTimer) clearInterval(railTimer); // stop the caption rail
      options.onCaption?.(null);
      clearInterval(welcomeTimer); // stop the receptionist welcome
      if (ambientTimer) clearTimeout(ambientTimer); // stop the idle-beat scheduler
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [who, s] of [...speeches]) clearSpeech(who, s); // cancel timers + remove bubbles
      for (const name of plateExpand.keys()) clearExpandTimer(name);
      plateExpand.clear();
      for (const el of labels.values()) el.remove();
      labels.clear();
      ambientHost.remove(); // removes the day-cycle wash, steam, and the animated desk props
      boardSpot?.remove();
      canvas.remove();
    },
  };
}
