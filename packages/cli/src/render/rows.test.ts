import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  isActionNeeded,
  openActionNeeded,
  renderBanner,
  renderMessageRow,
  renderPendingSummary,
  renderReachabilityNudge,
  renderStatusHeader,
  renderStatusTable,
} from './rows.js';

// picocolors auto-disables color when stdout is not a TTY (vitest), so output is plain & deterministic.

const kindOf = (name: string) => (name === 'nick' ? 'human' : 'agent') as 'human' | 'agent';

function env(partial: Partial<Envelope>): Envelope {
  return {
    id: 'm1',
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: 'Ada',
    to: { kind: 'team' },
    act: 'status_update',
    body: 'scaffolded auth',
    ts: Date.UTC(2026, 5, 9, 14, 30),
    ...partial,
  } as Envelope;
}

describe('renderMessageRow', () => {
  it('renders a team status_update', () => {
    const out = renderMessageRow(env({}), kindOf);
    expect(out).toContain('Ada');
    expect(out).toContain('[status_update]');
    expect(out).toContain('→ @team');
    expect(out).toContain('scaffolded auth');
  });

  it('marks unread rows with a leading bar', () => {
    const out = renderMessageRow(
      env({ act: 'request_help', body: 'help', to: { kind: 'member', name: 'nick' } }),
      kindOf,
      { unread: true },
    );
    expect(out.startsWith('▌')).toBe(true);
    expect(out).toContain('[request_help]');
    expect(out).toContain('→ nick');
  });

  it('renders a header-only row when body is empty', () => {
    const out = renderMessageRow(env({ act: 'wait', body: '' }), kindOf);
    expect(out).toContain('[wait]');
    expect(out.split('\n')).toHaveLength(1);
  });
});

describe('renderStatusTable', () => {
  it('renders the dawn roster with columns', () => {
    const members: MemberSummary[] = [
      {
        id: '1',
        team: 'dawn',
        name: 'nick',
        kind: 'human',
        role: 'lead',
        lifecycle: 'forever',
        created_at: 0,
        presence: 'online',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
      },
      {
        id: '2',
        team: 'dawn',
        name: 'Ada',
        kind: 'agent',
        role: 'backend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'online',
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
      },
      {
        id: '3',
        team: 'dawn',
        name: 'Lin',
        kind: 'agent',
        role: 'frontend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'offline',
        presences: [],
      },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain('MEMBER');
    expect(out).toContain('ACTIVITY');
    expect(out).toContain('nick');
    expect(out).toContain('online via cli');
    expect(out).toContain('online via claude-code');
    expect(out).toContain('offline');
  });

  it('renders self-declared availability, overriding the activity label (ADR 044)', () => {
    const until = Date.UTC(2026, 5, 24, 17, 0);
    const members: MemberSummary[] = [
      // away_until: even though present, availability outranks the live activity (off until <ts>).
      {
        id: '1',
        team: 'dawn',
        name: 'nick',
        kind: 'human',
        role: 'lead',
        lifecycle: 'forever',
        created_at: 0,
        presence: 'online',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
        availability: { status: 'away', until },
      },
      // dnd renders plainly.
      {
        id: '2',
        team: 'dawn',
        name: 'Ada',
        kind: 'agent',
        role: 'backend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'online',
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
        availability: { status: 'dnd' },
      },
      // available is the implicit default — never overrides the activity column.
      {
        id: '3',
        team: 'dawn',
        name: 'Lin',
        kind: 'agent',
        role: 'frontend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'online',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
        availability: { status: 'available' },
      },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain('off until 2026-06-24');
    expect(out).toContain('dnd');
    expect(out).toContain('online via cli'); // Lin: available falls through to activity
  });

  it('renders working with state, adding the age only once stale (≥5m)', () => {
    const now = Date.UTC(2026, 5, 9, 15, 0);
    const base = {
      team: 'dawn',
      kind: 'agent' as const,
      role: 'backend',
      lifecycle: 'session' as const,
      created_at: 0,
      presences: [
        { surface: 'claude-code' as const, status: 'online' as const, last_seen_at: now },
      ],
    };
    const members: MemberSummary[] = [
      // fresh status (2 min ago) → no age suffix
      {
        ...base,
        id: '1',
        name: 'Ada',
        presence: 'online',
        activity: 'working',
        state: 'scaffolding tests',
        last_status_at: now - 2 * 60_000,
      },
      // stale status (18 min ago) → age shown
      {
        ...base,
        id: '2',
        name: 'Lin',
        presence: 'online',
        activity: 'working',
        state: 'refactoring auth',
        last_status_at: now - 18 * 60_000,
      },
    ];
    const out = renderStatusTable(members, now);
    expect(out).toContain('working: scaffolding tests');
    expect(out).not.toContain('scaffolding tests ·');
    expect(out).toContain('working: refactoring auth · 18m');
  });

  it('clips a long, multi-line status to one tidy roster line', () => {
    const longState =
      'Working on FindMyMoney scan/pricing.\nDone: bounded the URL-inference pass with per-file dedupe and caps; now implementing /api/scan blocking on codegen so the gap list settles server-side.';
    const members: MemberSummary[] = [
      {
        id: '1',
        team: 'dawn',
        name: 'Mike',
        kind: 'agent',
        role: 'backend',
        lifecycle: 'forever',
        created_at: 0,
        presence: 'online',
        activity: 'working',
        state: longState,
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
      },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain('working: Working on FindMyMoney');
    expect(out).toContain('…'); // clipped
    expect(out).not.toContain('\nDone:'); // newline collapsed, not spilled into the table
    // the working cell stays on one line
    const mikeLine = out.split('\n').find((l) => l.includes('Mike'))!;
    expect(mikeLine.length).toBeLessThan(160);
  });

  it('renders provenance (why) and workspace (where) dim alongside activity (ADR 014)', () => {
    const members: MemberSummary[] = [
      {
        id: '1',
        team: 'dawn',
        name: 'Ada',
        kind: 'agent',
        role: 'backend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'online',
        activity: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: 0,
            provenance: 'session',
            workspace: 'movetrail@feat/login',
          },
        ],
      },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain('online via claude-code (session) · movetrail@feat/login');
  });

  it('names the driving human (driver co-presence, ADR 021)', () => {
    const members: MemberSummary[] = [
      {
        id: '1',
        team: 'dawn',
        name: 'Ada',
        kind: 'agent',
        role: 'backend',
        lifecycle: 'session',
        created_at: 0,
        presence: 'online',
        activity: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: 0,
            provenance: 'session',
            workspace: 'movetrail@feat/login',
            driver: 'nick',
          },
        ],
      },
    ];
    const out = renderStatusTable(members);
    expect(out).toContain(
      'online via claude-code (session) · driven by nick · movetrail@feat/login',
    );
  });
});

describe('renderStatusHeader', () => {
  it('shows team, server, and the db path + schema when health is available', () => {
    const out = renderStatusHeader('dawn', 'http://localhost:4849', {
      db: '/Users/nick/musterd-demo/demo.db',
      schema: 3,
    });
    expect(out).toContain('dawn');
    expect(out).toContain('http://localhost:4849');
    expect(out).toContain('db: /Users/nick/musterd-demo/demo.db (schema 3)');
  });

  it('omits the db segment when health is unavailable (pre-0.2 daemon)', () => {
    const out = renderStatusHeader('dawn', 'http://localhost:4849');
    expect(out).toContain('dawn');
    expect(out).not.toContain('db:');
  });
});

describe('isActionNeeded (ADR 024 — recipient-side salience)', () => {
  it('flags request_help regardless of recipient', () => {
    expect(isActionNeeded(env({ act: 'request_help', to: { kind: 'team' } }), 'nick')).toBe(true);
    expect(isActionNeeded(env({ act: 'request_help', to: { kind: 'broadcast' } }), 'nick')).toBe(
      true,
    );
  });

  it('flags any act addressed specifically to me', () => {
    expect(
      isActionNeeded(env({ act: 'handoff', to: { kind: 'member', name: 'nick' } }), 'nick'),
    ).toBe(true);
    expect(
      isActionNeeded(env({ act: 'message', to: { kind: 'member', name: 'nick' } }), 'nick'),
    ).toBe(true);
  });

  it('does not flag a team status_update or an act directed at someone else', () => {
    expect(isActionNeeded(env({ act: 'status_update', to: { kind: 'team' } }), 'nick')).toBe(false);
    expect(
      isActionNeeded(env({ act: 'message', to: { kind: 'member', name: 'Ada' } }), 'nick'),
    ).toBe(false);
  });

  it('never flags a resolve — a thread-close is done, not an action (ADR 025)', () => {
    expect(
      isActionNeeded(
        env({ act: 'resolve', to: { kind: 'member', name: 'nick' }, thread: 'r1' }),
        'nick',
      ),
    ).toBe(false);
  });
});

describe('openActionNeeded (ADR 025 — open-vs-done axis)', () => {
  it('drops a request whose thread carries a resolve, even unread', () => {
    const ask = env({
      id: 'r1',
      act: 'request_help',
      from: 'Ada',
      to: { kind: 'team' },
      thread: null,
    });
    const done = env({
      id: 'r2',
      act: 'resolve',
      from: 'Lin',
      to: { kind: 'team' },
      thread: 'r1', // closes the ask's thread (the ask is a root, so its id is the thread id)
    });
    expect(openActionNeeded([ask], 'nick')).toHaveLength(1);
    expect(openActionNeeded([ask, done], 'nick')).toHaveLength(0);
  });

  it('keeps an unresolved request and ignores resolves of other threads', () => {
    const ask = env({ id: 'a1', act: 'request_help', to: { kind: 'team' }, thread: null });
    const otherDone = env({ id: 'x2', act: 'resolve', to: { kind: 'team' }, thread: 'other' });
    expect(openActionNeeded([ask, otherDone], 'nick')).toHaveLength(1);
  });
});

describe('renderPendingSummary (ADR 024 — comeback summary)', () => {
  const since = Date.UTC(2026, 5, 9, 14, 32);

  it('returns empty string when nothing is waiting (no noise on the common path)', () => {
    expect(renderPendingSummary(0, since)).toBe('');
  });

  it('uses the singular for one request', () => {
    const out = renderPendingSummary(1, since);
    expect(out).toContain('1 request waiting for you');
    expect(out).not.toContain('requests');
    expect(out).toContain('musterd inbox to read');
  });

  it('pluralizes and shows the since-time for several', () => {
    const out = renderPendingSummary(3, since);
    expect(out).toContain('3 requests waiting for you');
    expect(out).toMatch(/since \d\d:\d\d/); // local HH:MM — timezone-robust
  });
});

describe('renderReachabilityNudge (ADR 046 — agent-side reachability)', () => {
  const since = Date.UTC(2026, 5, 9, 14, 17);

  it('returns empty string when nothing is waiting (no noise on the common path)', () => {
    expect(renderReachabilityNudge(0, since, 'David')).toBe('');
  });

  it('names the member and uses the singular for one act', () => {
    const out = renderReachabilityNudge(1, since, 'David');
    expect(out).toContain('1 act waiting for David');
    expect(out).not.toContain('acts');
    expect(out).toContain('musterd inbox');
  });

  it('pluralizes and shows the since-time for several', () => {
    const out = renderReachabilityNudge(3, since, 'David');
    expect(out).toContain('3 acts waiting for David');
    expect(out).toMatch(/since \d\d:\d\d/); // local HH:MM — timezone-robust
  });
});

describe('renderBanner', () => {
  it('is a compact lockup: presence dots + the musterd chip + tagline', () => {
    const banner = renderBanner();
    expect(banner).toContain('●'); // at least one roll-call presence dot
    expect(banner).toContain('○'); // …including the offline state
    expect(banner).toContain('musterd'); // the wordmark chip (literal word, no letter-art)
    expect(banner).toContain('persistent teams'); // the tagline
    // Two lines only — no multi-line letter-art.
    expect(banner.split('\n')).toHaveLength(2);
  });
});
