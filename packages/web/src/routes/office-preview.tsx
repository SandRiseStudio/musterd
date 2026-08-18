import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { memberColor } from '../live/format';
import { OfficeOverlay } from '../live/OfficeOverlay';
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
  activity: OfficeData['nodes'][number]['activity'];
  state: string | null;
};

const POOL: Mock[] = [
  { name: 'Ada', kind: 'human', activity: 'working', state: 'reviewing the isometric office' },
  { name: 'Bo', kind: 'agent', activity: 'working', state: 'porting the floor renderer' },
  { name: 'Cy', kind: 'human', activity: 'working', state: 'wiring the firehose subscribe' },
  { name: 'Dev', kind: 'agent', activity: 'idle', state: null },
  { name: 'Eli', kind: 'human', activity: 'working', state: 'writing the seating tests' },
  { name: 'Fen', kind: 'agent', activity: 'working', state: 'watching the deploy' },
  { name: 'Gus', kind: 'human', activity: 'idle', state: null },
  { name: 'Hana', kind: 'agent', activity: 'working', state: 'profiling the render loop' },
  { name: 'Ivy', kind: 'human', activity: 'working', state: 'designing the character rig' },
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
  Hana: { surface: 'claude-code', model: 'deepseek-v4-pro' },
  Ivy: { surface: 'cursor', model: 'mistral-large-3', role: 'design' },
};

// A looping choreography script (ms offset → event), so the room is always alive on the preview.
const SCRIPT: { at: number; ev: OfficeEvent }[] = [
  { at: 200, ev: { kind: 'walk-help', from: 'Ada', to: 'Bo', tier: 'needs-attn' } },
  {
    at: 300,
    ev: {
      kind: 'speech',
      who: 'Cy',
      text: 'anyone seen the flaky seating test? it fails ~1 in 5 for me',
      tone: 'accent',
    },
  },
  { at: 500, ev: { kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' } },
  { at: 1100, ev: { kind: 'walk-help', from: 'Cy', to: 'Fen', tier: 'urgent' } },
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
  { at: 3600, ev: { kind: 'resolve', who: 'Fen' } },
  {
    at: 3700,
    ev: { kind: 'speech', who: 'Fen', text: 'fixed — resolving the thread', tone: 'success' },
  },
  { at: 4200, ev: { kind: 'note', from: 'Ada', to: 'Cy', tone: 'info' } },
  // Steering trio (ADR 103): a challenge questions a direction, an interrupt-class steer redirects it,
  // and a defer pushes a Goal later — a board-wide pulse.
  { at: 4700, ev: { kind: 'challenge', from: 'Dev', to: 'Bo', urgent: false } },
  {
    at: 4800,
    ev: {
      kind: 'speech',
      who: 'Dev',
      text: 'why render.ts before the seating fix? can you justify the order?',
      tone: 'challenge',
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
const LOOP = 5600;

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
    posture: 'idle',
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

  // `?idle=all` (or a comma list of names) forces members idle on load — the case the leisure furniture
  // exists for, and the one that's tedious to reach by clicking. `?idle=all` empties every desk.
  const [idle, setIdle] = useState<Set<string>>(() => {
    const raw = previewSearch().get('idle');
    if (!raw) return new Set();
    if (raw === 'all') return new Set(POOL.map((m) => m.name));
    return new Set(raw.split(',').map((s) => s.trim()));
  });

  // `?stale=<names>` reproduces a *stale* seat (ADR 135): posture projected to `idle` while its last-known
  // `activity` still reads `working`. That split is the only case where the typing animation and placement
  // could disagree, so it's the one worth being able to summon — the live floor reaches it on its own.
  const [stale] = useState<Set<string>>(() => {
    const raw = previewSearch().get('stale');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set();
  });

  // `?reel=<0..6>` sizes the overlay's reel — 1 is the no-rail/no-nav case, 0 the empty room.
  const [reelCount] = useState(() => {
    const raw = previewSearch().get('reel');
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) ? Math.max(0, Math.min(REEL.length, n)) : REEL.length;
  });

  const buildData = useCallback(
    (): OfficeData => ({
      teamWorkingHours: {
        timezone: 'America/Los_Angeles',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '11:00',
        end: '15:00',
      },
      nodes: POOL.filter((m) => present.has(m.name)).map((m) => {
        const isAway = away.has(m.name);
        const isStale = stale.has(m.name);
        // A stale seat keeps `activity: working` but is placed by its projected `idle` posture.
        const activity = isAway || (idle.has(m.name) && !isStale) ? 'idle' : m.activity;
        const posture = isAway
          ? ('away' as const)
          : isStale || idle.has(m.name)
            ? ('idle' as const)
            : activity;
        return {
          name: m.name,
          kind: m.kind,
          presence: isAway ? 'away' : 'online',
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
        };
      }),
    }),
    [present, away, idle, stale],
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
        const handle = mountOffice(host, labelHost, false, { interactiveLabels: true });
        handle.update(dataRef.current());
        handleRef.current = handle;
        (window as unknown as { __office?: OfficeHandle }).__office = handle; // dev-fixture debug handle
        // `?quiet` skips the looping choreography — a still room of seated members, so an on-demand
        // gesture (pokeGesture / the 🙆👀 buttons) is the only motion. Used to verify gestures in isolation.
        const search =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
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
        const still = search.has('still');
        if (still) {
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
          onClick={() => fire({ kind: 'walk-help', from: 'Ada', to: 'Bo', tier: 'needs-attn' })}
        >
          ?
        </button>
        <button
          className="lc__pbtn"
          title="urgent help (run)"
          onClick={() => fire({ kind: 'walk-help', from: 'Cy', to: 'Fen', tier: 'urgent' })}
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
          onClick={() => fire({ kind: 'challenge', from: 'Cy', to: 'Bo', urgent: false })}
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
            interactive
          />
          <p className="lc-office__caption">office choreography preview</p>
        </section>
      </div>
    </main>
  );
}
