import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ASK_TIER_DEFAULTS, type Envelope, type MemberSummary } from '@musterd/protocol';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { AsksStrip } from '../live/AsksStrip';
import type { LiveConfig } from '../live/client';

export const Route = createFileRoute('/asks-preview')({
  head: () => ({
    meta: [{ title: 'musterd — asks rail preview' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: AsksPreviewPage,
});

/* Synthetic fixtures — no live daemon needed, and no waiting on a real teammate to raise an ask.
   Deadlines are relative to "now" so the tier clocks are always meaningful when you open the page. */
const NOW = Date.now();

const ROSTER: MemberSummary[] = [
  { name: 'nick', kind: 'human' },
  { name: 'izzo', kind: 'agent' },
  { name: 'ryder', kind: 'agent' },
  { name: 'stanley', kind: 'agent' },
] as MemberSummary[];

let seq = 0;
/** `deriveAsks` computes the deadline as `ts + ASK_TIER_DEFAULTS[tier].timeout_ms` — the protocol
 *  constant the asking agent's own clock reads. So a fixture picks its *remaining* time and back-dates
 *  `ts` to match; setting a `deadline` in meta would be ignored. */
function ask(
  from: string,
  species: 'consult' | 'escalate' | 'approve',
  tier: 'advisory' | 'standard' | 'blocking',
  body: string,
  remainingMs: number,
): Envelope {
  seq += 1;
  return {
    id: `01KYPREVIEW${String(seq).padStart(14, '0')}`,
    team: 'revive',
    from,
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body,
    thread: null,
    ts: NOW - (ASK_TIER_DEFAULTS[tier].timeout_ms - remainingMs),
    meta: { species, tier },
  } as unknown as Envelope;
}

const SCENES: Record<string, Envelope[]> = {
  'one blocking ask': [
    ask(
      'izzo',
      'approve',
      'blocking',
      'The fixture remote still has the solution pushed over origin/main. Reset it to pristine before the next cell runs?',
      4 * 60_000 + 12_000,
    ),
  ],
  'three open': [
    ask(
      'izzo',
      'approve',
      'blocking',
      'The fixture remote still has the solution pushed over origin/main. Reset it to pristine before the next cell runs?',
      4 * 60_000 + 12_000,
    ),
    ask(
      'ryder',
      'consult',
      'standard',
      'Model-family posture: should a single-family team read as a warning, or just as a fact on the roster?',
      2 * 60_000 + 40_000,
    ),
    ask(
      'stanley',
      'escalate',
      'advisory',
      'SDK 1.30.0 widens the hono pin. I can take it, but it moves a dependency nobody asked me to move.',
      55_000,
    ),
  ],
  'twenty open (scale)': Array.from({ length: 20 }, (_, i) => {
    const seats = ['izzo', 'ryder', 'stanley'] as const;
    const tiers = ['blocking', 'standard', 'advisory'] as const;
    const species = ['approve', 'consult', 'escalate'] as const;
    return ask(
      seats[i % 3]!,
      species[i % 3]!,
      tiers[i % 3]!,
      `Ask #${i + 1} — a ${tiers[i % 3]} ${species[i % 3]} that exists to prove twenty of these stay navigable.`,
      (i + 1) * 45_000,
    );
  }),
  'one deciding (deferred)': ((): Envelope[] => {
    // The `wait` has to point at the ask's real id, which `ask()` mints — so build it, then refer to it.
    const pending = ask(
      'ryder',
      'consult',
      'standard',
      'Should the roster show model family at all?',
      3 * 60_000,
    );
    const deciding = {
      id: '01KYPREVIEWWAIT00000000001',
      team: 'revive',
      from: 'nick',
      to: { kind: 'member', name: 'ryder' },
      act: 'wait',
      body: 'deciding — check back in 1h',
      thread: null,
      ts: NOW - 30_000,
      meta: { ask_ref: pending.id, until: '1h' },
    } as unknown as Envelope;
    return [pending, deciding];
  })(),
  'timed out — agent holding': [
    ask(
      'izzo',
      'approve',
      'blocking',
      'Gate B denied the push. I am holding rather than routing around it — this needs a human.',
      -30_000,
    ),
  ],
  'nothing loud (all settled)': [
    (() => {
      const e = ask('stanley', 'consult', 'advisory', 'Dependabot: seven alerts, one root.', -60_000);
      return e;
    })(),
  ],
};

const CFG = { base: '', team: 'revive', as: 'nick' } as unknown as LiveConfig;

function AsksPreviewPage() {
  const [scene, setScene] = useState<keyof typeof SCENES>('three open');
  const [asObserver, setObserver] = useState(false);

  return (
    <div className="lc" style={{ height: '100dvh' }}>
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__topbar-spacer" style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
          {Object.keys(SCENES).map((k) => (
            <button
              key={k}
              type="button"
              className="lc-ask__btn"
              style={k === scene ? { borderColor: 'var(--lc-accent)', color: 'var(--lc-accent)' } : undefined}
              onClick={() => setScene(k)}
            >
              {k}
            </button>
          ))}
          <button
            type="button"
            className="lc-ask__btn"
            style={asObserver ? { borderColor: 'var(--lc-accent)', color: 'var(--lc-accent)' } : undefined}
            onClick={() => setObserver((v) => !v)}
            title="Observers are hidden from the roster (ADR 063), so the rail renders read-only"
          >
            {asObserver ? 'watch-link (read-only)' : 'signed in as nick'}
          </button>
        </div>
      </header>

      <AsksStrip
        envelopes={SCENES[scene] ?? []}
        roster={asObserver ? ROSTER.filter((m) => m.name !== 'nick') : ROSTER}
        cfg={CFG}
        // The scene is labelled "watch-link", so it must render as one: a viewer the team handed a
        // read-only link gets no sign-in invitation at all (ADR 221). Without this the preview shows
        // the off-machine `paste` state under a watch-link label — the wrong state for its own name.
        watchLink={asObserver}
      />

      {/* Stand-in for the canvas: the whole point is that the sheet floats OVER this and never
          pushes it down. If this box moves when you expand the rail, the design has failed. */}
      <div
        style={{
          flex: 1,
          margin: 'var(--lc-4) var(--lc-6) var(--lc-6)',
          border: '1px dashed var(--lc-border-2)',
          borderRadius: 'var(--lc-r-lg)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--lc-faint)',
          fontSize: 12,
        }}
      >
        the canvas (office · roster · stream) — this must not move
      </div>
    </div>
  );
}
