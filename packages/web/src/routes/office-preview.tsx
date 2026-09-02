import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { memberColor } from '../live/format';
import { OfficeOverlay } from '../live/OfficeOverlay';
import { isStill } from '../live/stillMode';
import type { Caption } from '../live/captions';
import type { RoomEntry } from '../live/workingOn';
import type { OfficeData, OfficeEvent, OfficeHandle } from '../live/office-scene';

export const Route = createFileRoute('/office-preview')({
  head: () => ({
    meta: [{ title: 'musterd — office preview' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: OfficePreviewPage,
});

/* Synthetic fixture — no live daemon. Mounts the office scene directly and drives it with a looping
   act script so the walk/handoff/megaphone choreography plays on its own, plus roster controls (join /
   leave / away) that exercise the presence transitions — arrivals walk in, departures walk out, away
   drifts to the nook. Design fixture; also how the motion is verified in a real browser. */

type Kind = 'agent' | 'human';
type Mock = {
  name: string;
  kind: Kind;
  /** A `kind: 'service'` ledger seat (ADR 232) — drawn as an agent, nameplated as a service. */
  service?: true;
  activity: OfficeData['nodes'][number]['activity'];
  state: string | null;
};

const POOL: Mock[] = [
  { name: 'Ada', kind: 'human', activity: 'working', state: 'reviewing the isometric office' },
  { name: 'Bo', kind: 'agent', activity: 'working', state: 'porting the floor renderer' },
  { name: 'Cy', kind: 'human', activity: 'working', state: 'wiring the firehose subscribe' },
  { name: 'Dev', kind: 'agent', activity: 'active', state: null },
  { name: 'Eli', kind: 'human', activity: 'working', state: 'writing the seating tests' },
  { name: 'Fen', kind: 'agent', activity: 'working', state: 'watching the deploy' },
  { name: 'Gus', kind: 'human', activity: 'active', state: null },
  { name: 'Hana', kind: 'agent', activity: 'working', state: 'profiling the render loop' },
  { name: 'Ivy', kind: 'human', activity: 'working', state: 'designing the character rig' },
  // The service seat — the nameplate's "service" tag can only be eyeballed (and contrast-measured)
  // here if the fixture actually seats one (same argument as the varied FIXTURE_IDENTITY above).
  { name: 'Jib', kind: 'agent', service: true, activity: 'active', state: null },
];

/**
 * Harness + model per fixture member. Deliberately varied, including a long id and a `null` model:
 * the nameplate's provider icon + expand detail have to survive both the widest label it will ever
 * see and the seat that has nothing to report.
 */
const FIXTURE_IDENTITY: Record<string, { surface: string; model: string | null; role?: string }> = {
  Ada: { surface: 'claude-code', model: 'claude-opus-5', role: 'lead' },
  Bo: { surface: 'cursor', model: 'claude-sonnet-4-5' },
  Cy: { surface: 'codex', model: 'gpt-5.6-terra-medium' },
  Dev: { surface: 'cli', model: null },
  Eli: { surface: 'claude-code', model: 'gemini-3.2-pro' },
  Fen: { surface: 'web', model: 'grok-4.5' },
  Gus: { surface: 'slack', model: 'llama-4-maverick' },
  Hana: { surface: 'opencode', model: 'deepseek-v4-pro' },
  Ivy: { surface: 'cursor', model: 'mistral-large-3', role: 'design' },
  // The service seat: no model BY KIND (pure code, nothing to attest) — distinct from Dev's
  // null-model agent, which is a seat that merely has nothing to report.
  Jib: { surface: 'cli', model: null, role: 'platform' },
};

// A looping choreography script (ms offset → event), so the room is always alive on the preview.
const SCRIPT: { at: number; ev: OfficeEvent }[] = [
  { at: 200, ev: { kind: 'walk-help', from: 'Ada', to: ['Bo'], tier: 'needs-attn' } },
  {
    at: 300,
    ev: {
      kind: 'speech',
      who: 'Cy',
      text: 'anyone seen the flaky seating test? it fails ~1 in 5 for me',
      tone: 'accent',
      // An addressed bubble early in the loop, so the chip is visible when someone is WATCHING the
      // room. It is not the one the gate measures: Cy speaks again at 6700, and one bubble per member
      // means this one is superseded long before the sweep's shutter — Bo's at 7500 is the survivor.
      // An ADR 254 eligible set, deliberately: this is the shape /live carries most (28 of the 35
      // in the live corpus are review routing), and the design tool must be able to draw the state
      // the room actually receives — a chip naming the set, and a trace to each desk.
      addressee: { names: ['Hana', 'Bo'], label: 'Hana or Bo', tether: true },
    },
  },
  { at: 500, ev: { kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' } },
  // Cy's bubble at 200ms names an eligible set ("Hana or Bo"), and the walk it describes visits
  // BOTH desks in turn — the design tool draws the multi-stop trip /live actually receives. Both
  // names are members who are ON the floor by default: `Fen` is in the default `offline` set above,
  // so a leg to Fen never plays and the tool would show a one-stop trip while claiming two.
  { at: 1100, ev: { kind: 'walk-help', from: 'Cy', to: ['Hana', 'Bo'], tier: 'urgent' } },
  { at: 1800, ev: { kind: 'megaphone', from: 'Ivy' } },
  {
    at: 2000,
    ev: {
      kind: 'speech',
      who: 'Ivy',
      text: 'shipping the character rig — hair variety is in review',
      tone: 'status',
    },
  },
  { at: 2400, ev: { kind: 'screen-pulse', who: 'Hana', tone: 'status' } },
  {
    at: 2500,
    ev: { kind: 'speech', who: 'Hana', text: 'profiling the render loop', tone: 'status' },
  },
  { at: 3000, ev: { kind: 'walk-handoff', from: 'Bo', to: 'Ivy', label: 'render.ts' } },
  // The acceptance celebration (liveliness inc 1): Eli's work accepted by Ada — confetti over Eli,
  // a green thread from Ada, the desk neighbors glancing over. Directed, so `of` carries the celebrant.
  { at: 3400, ev: { kind: 'accept', who: 'Ada', of: 'Eli' } },
  { at: 3600, ev: { kind: 'resolve', who: 'Fen' } },
  {
    at: 3700,
    ev: {
      kind: 'speech',
      who: 'Fen',
      text: 'fixed — resolving the thread',
      tone: 'success',
      marking: { mark: 'done', holds: false }, // DONE — badge only (✓)
    },
  },
  // `decline` and `wait` complete the set: every other kind `actToEvent` can produce from a real
  // envelope was already scripted here, but these two were not — so two states a viewer of /live can
  // genuinely hit had never been drawn on the one route the office is reviewed and contrast-swept on
  // (miley, 2026-08-20). Declining and pausing are ordinary things for a seat to do.
  { at: 7400, ev: { kind: 'decline', who: 'Bo' } },
  {
    at: 7500,
    ev: {
      kind: 'speech',
      who: 'Bo',
      text: "not taking this one — it needs the seating fix first, and that's not mine",
      // The tones mirror what actTone() would really return for these acts on /live: decline is
      // `danger`, wait is `info`. A fixture that invents its own tone teaches the wrong room.
      tone: 'danger',
      // THE MEASURED CHIP. Bo speaks exactly once in the script, so this bubble is still standing at
      // the sweep's shutter — verified 2026-08-20, the sweep emits an `lc-speech__to` row keyed
      // `rgb(90,78,63)` over its own 9% tone wash, and /office-preview stays 0 below AA. A declined
      // handoff is also the honest place for a recipient chip: "not taking this one" needs a "from
      // whom" or it is unreadable.
      addressee: { names: ['Eli'], label: 'Eli', tether: true },
    },
  },
  /* THE TOP OF THE MARK AXIS, and it had no fixture at all until now: a `blocking` to-human ask
     (ADR 147). Every other act family in this script was reachable here and this one — the single
     loudest thing the room can show, and the only bubble that pulses — could only be seen by
     waiting for a real seat to raise one on /live. Same argument that put `decline` and `wait` in
     this script on 2026-08-20: a state the design tool cannot reach is a state nobody has looked at.
     `holds: true` is what `askTierHolds('blocking')` returns — the seat has stopped until a person
     answers, which is what earns the pulse over the heavy ring an ordinary ask gets. */
  { at: 8400, ev: { kind: 'walk-help', from: 'Hana', to: ['Ada'], tier: 'urgent' } },
  {
    at: 8500,
    ev: {
      kind: 'speech',
      who: 'Hana',
      text: 'this drops the production index — I am holding until a human says go',
      tone: 'accent',
      marking: { mark: 'needs-human', holds: true },
      addressee: { names: ['Ada'], label: 'Ada', tether: true },
    },
  },
  /* And its quiet sibling, so the two are comparable side by side rather than one at a time: an
     acceptance request is also an ask, also needs a person, and does NOT hold anyone — `approve`
     species, so it reads as REVIEW (a badge, no heavy ring). Getting these two the same volume is
     the mistake the tier split exists to prevent. */
  {
    at: 8900,
    ev: {
      kind: 'speech',
      who: 'Eli',
      text: 'lane 01M1J4XV6D is ready — judge the landed outcome when you get a minute',
      tone: 'accent',
      marking: { mark: 'review', holds: false },
      addressee: { names: ['Cy', 'Dev'], label: 'Cy or Dev', tether: true },
    },
  },
  { at: 8000, ev: { kind: 'wait', who: 'Ivy' } },
  {
    at: 8100,
    ev: {
      kind: 'speech',
      who: 'Ivy',
      text: 'holding until the rig review lands',
      tone: 'info',
    },
  },
  { at: 4200, ev: { kind: 'note', from: 'Ada', to: ['Cy'], tone: 'info' } },
  // Steering trio (ADR 103): a challenge questions a direction, an interrupt-class steer redirects it,
  // and a defer pushes a Goal later — a board-wide pulse.
  { at: 4700, ev: { kind: 'challenge', from: 'Dev', to: ['Bo'], urgent: false } },
  {
    at: 4800,
    ev: {
      kind: 'speech',
      who: 'Dev',
      text: 'why render.ts before the seating fix? can you justify the order?',
      tone: 'challenge',
      marking: { mark: 'interrupt', holds: false }, // INTERRUPT — heavy ring + ↪
    },
  },
  { at: 5600, ev: { kind: 'steer', from: 'Ada', to: 'Hana', urgent: true } },
  {
    at: 5700,
    ev: {
      kind: 'speech',
      who: 'Ada',
      text: 'change of plan — drop the profiling, the deploy is what matters now',
      tone: 'steer',
      // INTERRUPT — heavy ring + ↪. The fixture has to carry the marks or nobody ever looks at
      // them: this route is the design loop AND the surface the contrast sweep measures, and a
      // state it cannot reach is a state that gets reviewed for the first time in production. The
      // markings here are what `speechMark` really returns for these acts — a fixture that invents
      // its own teaches the wrong room, the same rule the `tone` values above already follow.
      marking: { mark: 'interrupt', holds: false },
    },
  },
  { at: 6600, ev: { kind: 'defer', who: 'Cy' } },
  {
    at: 6700,
    ev: {
      kind: 'speech',
      who: 'Cy',
      text: 'deferring the firehose Goal to next wave',
      tone: 'lane',
    },
  },
];
/** A fixture member's kind, for the caption dot's colour — the pool is the roster here. */
const kindOfMock = (name: string): Kind => (POOL.find((m) => m.name === name)?.kind ?? 'agent');

const LOOP = 5600;

/**
 * One narrated moment per act family — the fixture for the caption pill's five tones. Real captions
 * are composed from real envelopes (`captionFor`), which this route never has: it fires scene events
 * directly. Written out here so the pill's colours are reachable in the design loop instead of only
 * when the matching act happens to occur on `/live`.
 */
const CAPTIONS: Caption[] = [
  { text: 'Ada is handing work to Bo', who: 'Ada', tone: 'handoff' },
  { text: "Cy accepted Dev's work — it's done", who: 'Cy', tone: 'accept' },
  { text: 'Eli is asking Fen to approve something', who: 'Eli', tone: 'ask' },
  { text: 'Hana is redirecting the team', who: 'Hana', tone: 'steer' },
  { text: 'Ivy just walked in', who: 'Ivy', tone: 'presence' },
];

/* The overlay's fixture reel — real-shaped titles (long, ADR-numbered, the kind that actually
   truncate) plus the quiet cases, so the card is designed against the worst entry and not a tidy
   one. `?reel=<n>` trims the list; `?reel=0` is the empty room. */
const REEL: RoomEntry[] = [
  {
    name: 'Ivy',
    kind: 'human',
    color: memberColor('Ivy', 'human'),
    posture: 'working',
    title: 'ADR 169 inc 5 — spin-up/spin-down ephemeral cross-family reviewer',
    source: 'lane',
    laneState: 'active',
    moreLanes: 0,
  },
  {
    name: 'Bo',
    kind: 'agent',
    color: memberColor('Bo', 'agent'),
    posture: 'working',
    title: 'MCP RC 2026-07-28 readiness — seam canaries, version truth, ADR',
    source: 'lane',
    laneState: 'claimed',
    moreLanes: 1,
  },
  {
    name: 'Hana',
    kind: 'agent',
    color: memberColor('Hana', 'agent'),
    posture: 'working',
    title: 'Harness residency increment 6 — native backend reference row',
    source: 'lane',
    laneState: 'blocked',
    moreLanes: 0,
  },
  {
    name: 'Cy',
    kind: 'human',
    color: memberColor('Cy', 'human'),
    posture: 'working',
    title: 'wiring the firehose subscribe',
    source: 'status',
    laneState: null,
    moreLanes: 0,
  },
  {
    name: 'Dev',
    kind: 'agent',
    color: memberColor('Dev', 'agent'),
    posture: 'active',
    title: null,
    source: null,
    laneState: null,
    moreLanes: 0,
  },
  {
    name: 'Gus',
    kind: 'human',
    color: memberColor('Gus', 'human'),
    posture: 'away',
    title: null,
    source: null,
    laneState: null,
    moreLanes: 0,
  },
];

// This dev-fixture page reads its scenario from `?n=/?idle=/?stale=` query params, but its
// useState initializers run during SSR prerender too — where `window` is undefined. On the
// server there are no params anyway, so resolve to an empty query there.
const previewSearch = () =>
  new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

function OfficePreviewPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);

  // `?n=<count>` starts with only the first N of the pool present — the sparse-roster case the floor plan
  // has to survive (a real team is ~5 against 12 desks, and that is when empty desks read loudest).
  const [present, setPresent] = useState<Set<string>>(() => {
    const n = Number(previewSearch().get('n'));
    const pool = Number.isFinite(n) && n > 0 ? POOL.slice(0, n) : POOL;
    return new Set(pool.map((m) => m.name));
  });
  const [away, setAway] = useState<Set<string>>(() => new Set(['Gus']));
  // The scene hands the narrated moment out; the chrome renders it (the /live wiring, mirrored here).
  const [caption, setCaption] = useState<Caption | null>(null);

  // `?idle=all` (or a comma list of names) forces members idle on load — the case the leisure furniture
  // exists for, and the one that's tedious to reach by clicking. `?idle=all` empties every desk.
  const [idle, setIdle] = useState<Set<string>>(() => {
    const raw = previewSearch().get('idle');
    if (!raw) return new Set();
    if (raw === 'all') return new Set(POOL.map((m) => m.name));
    return new Set(raw.split(',').map((s) => s.trim()));
  });

  // `?stale=<names>` reproduces a *stale* seat (ADR 135): posture projected to `active` while its last-known
  // `activity` still reads `working`. That split is the only case where the typing animation and placement
  // could disagree, so it's the one worth being able to summon — the live floor reaches it on its own.
  const [stale] = useState<Set<string>>(() => {
    const raw = previewSearch().get('stale');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set();
  });

  // `?offline=<names>` marks members offline (owned desks, presence-honesty §4) — `off=<name>:disconnected`
  // shape is not supported; the first name gets `disconnected` so the amber glint is visible in preview.
  const [offlineSet] = useState<Set<string>>(() => {
    const raw = previewSearch().get('offline');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set(['Fen']);
  });

  // `?dnd=<names>` marks members do-not-disturb (headphones, dnd pill) — default one so the a11y
  // sweep and an eyeball can always reach the state.
  const [dndSet] = useState<Set<string>>(() => {
    const raw = previewSearch().get('dnd');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set(['Ivy']);
  });

  // `?reel=<0..6>` sizes the overlay's reel — 1 is the no-rail/no-nav case, 0 the empty room.
  const [reelCount] = useState(() => {
    const raw = previewSearch().get('reel');
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) ? Math.max(0, Math.min(REEL.length, n)) : REEL.length;
  });

  /* `?team=<slug>` — the ambient seed's key material (E1). The room's idle life is a pure function
     of (team, wall-clock slot), so two tabs on the same team play the SAME beats at the same instants
     and two different teams play independent ones: this param is how that is checked by eye on the
     one route that can render the room without a daemon, and how `scripts/perf/ambient-density.mjs`
     samples several independent rooms at once instead of waiting out one of them. */
  const [teamName] = useState(() => previewSearch().get('team') ?? 'revive');

  const buildData = useCallback(
    (): OfficeData => ({
      teamName,
      teamWorkingHours: {
        timezone: 'America/Los_Angeles',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '11:00',
        end: '15:00',
      },
      nodes: POOL.filter((m) => present.has(m.name)).map((m) => {
        const isOffline = offlineSet.has(m.name);
        const isAway = !isOffline && away.has(m.name);
        const isStale = stale.has(m.name);
        // A stale seat keeps `activity: working` but is placed by its projected `active` posture.
        const activity = isOffline
          ? ('offline' as const)
          : isAway || (idle.has(m.name) && !isStale)
            ? ('active' as const)
            : m.activity;
        const posture = isOffline
          ? ('offline' as const)
          : isAway
            ? ('away' as const)
            : isStale || idle.has(m.name)
              ? ('active' as const)
              : activity;
        return {
          name: m.name,
          kind: m.kind,
          service: m.service === true,
          presence: isOffline ? ('offline' as const) : isAway ? ('away' as const) : ('online' as const),
          activity,
          // The fixture has no availability axis, so posture composes straight off presence + activity —
          // except a `?stale` seat, which pins posture idle while activity lags at working.
          posture,
          state: m.state,
          color: memberColor(m.name, m.kind),
          role: FIXTURE_IDENTITY[m.name]?.role ?? '',
          // Varied identity, so the preview actually exercises the nameplate's provider icon and its
          // expand detail. These were `null` while the plate carried harness · model, which meant the
          // one surface for eyeballing a nameplate could never render one.
          surface: FIXTURE_IDENTITY[m.name]?.surface ?? 'claude-code',
          // Read the entry, not `?? default` — an explicit `model: null` IS the case worth showing
          // (a seat with nothing to report), and a nullish fallback makes it unreachable.
          model: m.name in FIXTURE_IDENTITY ? FIXTURE_IDENTITY[m.name]!.model : 'claude-opus-4-5',
          workTitle: null,
          workSource: null,
          laneState: null,
          moreLanes: 0,
          dnd: dndSet.has(m.name) && !isOffline,
          // The first offline fixture wears the amber `disconnected` glint; the rest read released.
          offline_reason: isOffline
            ? [...offlineSet][0] === m.name
              ? 'disconnected'
              : 'seat_released'
            : null,
          last_seen_at: isOffline ? Date.now() - 20 * 60_000 : null,
        };
      }),
    }),
    [teamName, present, away, idle, stale, offlineSet, dndSet],
  );
  const dataRef = useRef(buildData);
  // Synced in an effect, not during render — see OfficeScene: the mount effect subscribes once and
  // reads the latest builder through this ref, and it is declared after this one so it sees it set.
  useEffect(() => {
    dataRef.current = buildData;
  });

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let loop: ReturnType<typeof setInterval> | undefined;

    import('../live/office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const search =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
        /*
         * `?reduced` — RENDER THE ROOM AS A REDUCED-MOTION VIEWER SEES IT.
         *
         * This route hardcodes `reduced: false` (it is a design tool; a designer with Reduce Motion
         * enabled in their OS would otherwise find it useless, and the a11y gate leans on it moving).
         * The cost of that default is a blind spot: `prefers-reduced-motion` takes the office
         * somewhere quite far from here — the rAF loop never starts, walkers snap between desks
         * instead of walking, ambient life and the pet and the door pulse all stand down, and bubbles
         * appear whole with no typewriter. **No one had ever looked at that room**, because the one
         * tool used to review the office structurally could not render it (miley/nick, 2026-08-20).
         *
         * Presence, not value, like `?still` and `?quiet` beside it — inert unless explicitly asked
         * for, so the route's animated day job is unchanged. Opt-in rather than honouring the media
         * query directly, deliberately: honouring it would make the preview useless to exactly the
         * designer who has the setting turned on.
         */
        const reduced = search.has('reduced');
        const handle = mountOffice(host, labelHost, reduced, {
          interactiveLabels: true,
          // The narration is chrome now, so the scene only says what the moment is and the fixture's
          // own overlay renders it — the same wiring `/live` and `/broadcast` use.
          onCaption: (next) => setCaption(next),
        });
        handle.update(dataRef.current());
        handleRef.current = handle;
        (window as unknown as { __office?: OfficeHandle }).__office = handle; // dev-fixture debug handle
        // `?quiet` skips the looping choreography — a still room of seated members, so an on-demand
        // gesture (pokeGesture / the 🙆👀 buttons) is the only motion. Used to verify gestures in isolation.
        const quiet = search.has('quiet');
        /*
         * `?still` — the MEASUREMENT mode: the same script, played ONCE and immediately, with no
         * loop behind it. The room fills and then stops.
         *
         * This exists because the a11y contrast gate was measuring a moving room and losing. The
         * sweep freezes rAF, samples a screenshot and pairs each text row with the pixel beneath it,
         * and every part of that is a race against choreography: bubbles are born on timers, walks
         * reposition them, and `LOOP` restarts the whole script every cycle. Six exclusion guards
         * (moved, born, unsettled, invisible, clipped, covered) were added to contrast-sweep.mjs one
         * incident at a time, and /office-preview still flipped red about 1 run in 3 — always
         * `lc-speech__text`, over whatever scene paint happened to be under a bubble at shutter time.
         *
         * `?quiet` cannot be that mode: it skips the choreography entirely, so there are no bubbles
         * to measure, and the speech rows are exactly where the real failures have been found
         * (wanderer's below-AA report on this route was an lc-speech__text row). A gate that goes
         * green by removing its subject is worse than a flaky one.
         *
         * So: keep the subject, remove the motion. Every event fires at mount, the scene animates to
         * its end state once, and the sweep's settle detector — which already waits for the page to
         * STOP CHANGING rather than for a number of seconds — then has something that actually stops.
         *
         * Same shape as `?light=HH` above: a dev aid, inert unless explicitly present.
         */
        /* Via the shared reader, so this route and the three components that also honour the flag
           (the scene's ambient scheduler, the overlay reel, the asks-strip) cannot drift apart on
           what `?still` means — ADR 285. `search` above still serves `?quiet` and `?light`. */
        const still = isStill(window.location.search);
        if (still) {
          /* Every event at mount, as #880 wrote it. TESTED AND KEPT, 2026-08-19: the alternative —
             the script's own 6.7s timeline, played once with no loop — was measured on the theory
             that seven simultaneous walks contend for the floor and take longer to drain. They do
             not. Quiescence was 21.6s bursting and 22.5s staggered, i.e. the room takes ~22s to
             finish its choreography either way and the burst is not what makes it long. Recorded so
             the next person does not re-run the experiment. */
          for (const step of SCRIPT) handleRef.current?.emit(step.ev);
        } else if (!quiet) {
          const run = () => {
            for (const step of SCRIPT)
              timers.push(setTimeout(() => handleRef.current?.emit(step.ev), step.at));
          };
          run();
          loop = setInterval(run, LOOP);
        }
        // `?beat=fridge|water|coffee|phone|<gesture number>` fires that beat right after mount (and again every
        // 30s) — the only way to verify a ~25s errand headlessly, where clicking the poke buttons isn't
        // an option and waiting out the ambient scheduler isn't either.
        const beat = search.get('beat');
        if (beat) {
          const poke = () => {
            const h = handleRef.current;
            if (!h) return;
            if (beat === 'fridge' || beat === 'water' || beat === 'coffee' || beat === 'phone')
              h.pokeErrand(beat);
            else h.pokeGesture(Number(beat) || 1);
          };
          timers.push(setTimeout(poke, 600));
          loop ??= setInterval(poke, 30000);
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      if (loop) clearInterval(loop);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  // Push roster changes into the scene → arrivals walk in, departures walk out, away drifts to the nook.
  useEffect(() => {
    handleRef.current?.update(buildData());
  }, [buildData]);

  const fire = (ev: OfficeEvent) => handleRef.current?.emit(ev);
  const captionAt = useRef(0);
  const toggle = (set: Set<string>, name: string): Set<string> => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  };
  const present2 = (n: string) => setPresent((s) => toggle(s, n));
  const away2 = (n: string) => setAway((s) => toggle(s, n));
  const idle2 = (n: string) => setIdle((s) => toggle(s, n));

  return (
    <main className="lc">
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ office preview</span>
        <span className="lc__spacer" />
        <button
          className="lc__pbtn"
          title="request help (walk-over)"
          onClick={() => fire({ kind: 'walk-help', from: 'Ada', to: ['Bo'], tier: 'needs-attn' })}
        >
          ?
        </button>
        <button
          className="lc__pbtn"
          title="urgent help (run)"
          onClick={() => fire({ kind: 'walk-help', from: 'Cy', to: ['Fen'], tier: 'urgent' })}
        >
          !
        </button>
        <button
          className="lc__pbtn"
          title="handoff (carry box)"
          onClick={() => fire({ kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' })}
        >
          ↦
        </button>
        <button
          className="lc__pbtn"
          title="broadcast (megaphone)"
          onClick={() => fire({ kind: 'megaphone', from: 'Ivy' })}
        >
          📣
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="steer (interrupt-class redirect)"
          onClick={() => fire({ kind: 'steer', from: 'Ada', to: 'Dev', urgent: true })}
        >
          ↪
        </button>
        <button
          className="lc__pbtn"
          title="challenge (justify?)"
          onClick={() => fire({ kind: 'challenge', from: 'Cy', to: ['Bo'], urgent: false })}
        >
          🤔
        </button>
        <button
          className="lc__pbtn"
          title="defer (plan mutation → board pulse)"
          onClick={() => fire({ kind: 'defer', who: 'Fen' })}
        >
          »
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="narration: cycle the caption tones"
          onClick={() => {
            // One of each act family, in order, so the pill's five tones are all reachable from the
            // fixture. Without this the caption was only observable by waiting for the right real act
            // to happen on /live, which is not a design loop.
            const next = CAPTIONS[captionAt.current % CAPTIONS.length]!;
            captionAt.current += 1;
            fire({ kind: 'caption', caption: next });
          }}
        >
          💬
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: stretch"
          onClick={() => handleRef.current?.pokeGesture(1)}
        >
          🙆
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: glance"
          onClick={() => handleRef.current?.pokeGesture(2)}
        >
          👀
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: sip"
          onClick={() => handleRef.current?.pokeGesture(6)}
        >
          🍵
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: swivel"
          onClick={() => handleRef.current?.pokeGesture(7)}
        >
          🪑
        </button>
        <button
          className="lc__pbtn"
          title="errand: fridge meal"
          onClick={() => handleRef.current?.pokeErrand('fridge')}
        >
          🍽
        </button>
        <button
          className="lc__pbtn"
          title="errand: water refill"
          onClick={() => handleRef.current?.pokeErrand('water')}
        >
          💧
        </button>
        <button
          className="lc__pbtn"
          title="errand: coffee run"
          onClick={() => handleRef.current?.pokeErrand('coffee')}
        >
          ☕
        </button>
        <button
          className="lc__pbtn"
          title="errand: phone call (stand, pace, return)"
          onClick={() => handleRef.current?.pokeErrand('phone')}
        >
          📞
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="Dev join / leave (walk in / out)"
          onClick={() => present2('Dev')}
        >
          D
        </button>
        <button
          className="lc__pbtn"
          title="Hana join / leave (walk in / out)"
          onClick={() => present2('Hana')}
        >
          H
        </button>
        <button
          className="lc__pbtn"
          title="Ivy away / back (drift to nook)"
          onClick={() => away2('Ivy')}
        >
          z
        </button>
        <button
          className="lc__pbtn"
          title="Bo idle / working (walk to the lounge)"
          onClick={() => idle2('Bo')}
        >
          ☕
        </button>
        <span className="lc__status lc__status--live">design preview</span>
      </header>
      <div className="lc__canvas lc__canvas--companion">
        <section className="lc-office">
          <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
          <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
          {/* The real shared chrome, not a mock of it — the overlay is scene furniture, so the design
              fixture is where its cycle, truncation and empty state get looked at. */}
          <OfficeOverlay
            teamName="revive"
            present={present.size}
            entries={REEL.slice(0, reelCount)}
            status="live"
            caption={caption}
            captionColor={caption ? memberColor(caption.who, kindOfMock(caption.who)) : undefined}
            interactive
          />
          <p className="lc-office__caption">office choreography preview</p>
        </section>
      </div>
    </main>
  );
}
