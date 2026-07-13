import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  isActionNeeded,
  openActionNeeded,
  renderBanner,
  renderInbox,
  renderMessageRow,
  renderPendingSummary,
  renderReachabilityNudge,
  renderStatusHeader,
  renderRoster,
} from './rows.js';
import { dayLabel } from './theme.js';

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

describe('dayLabel (smart inbox dates)', () => {
  // A fixed "now": Tuesday, 2026-07-07 15:00 local.
  const now = new Date(2026, 6, 7, 15, 0).getTime();
  const at = (y: number, m: number, d: number, h = 10) => new Date(y, m, d, h).getTime();

  it('labels today, yesterday, within-week weekday, this-year, and prior-year', () => {
    expect(dayLabel(at(2026, 6, 7), now)).toBe('Today');
    expect(dayLabel(at(2026, 6, 6), now)).toBe('Yesterday');
    // 2 days ago (Sunday Jul 5) → weekday · month day
    expect(dayLabel(at(2026, 6, 5), now)).toBe('Sunday · Jul 5');
    // earlier this year, beyond a week → month day
    expect(dayLabel(at(2026, 0, 3), now)).toBe('Jan 3');
    // prior year → M/D/YY
    expect(dayLabel(at(2025, 11, 25), now)).toBe('12/25/25');
  });
});

describe('renderInbox (day-grouped)', () => {
  const now = new Date(2026, 6, 7, 15, 0).getTime();
  const at = (m: number, d: number, h: number) => new Date(2026, m, d, h).getTime();

  it('groups by day with one header per day, newest last, unread marked', () => {
    const msgs = [
      env({ id: 'a', from: 'miley', body: 'old', ts: at(6, 5, 9) }), // Sunday
      env({ id: 'b', from: 'izzo', body: 'y1', ts: at(6, 6, 11) }), // Yesterday
      env({ id: 'c', from: 'izzo', body: 'y2', ts: at(6, 6, 17) }), // Yesterday
      env({ id: 'd', from: 'miley', body: 'new', ts: at(6, 7, 10) }), // Today
    ];
    const cursorTs = at(6, 6, 12); // read through yesterday noon → y2 + today are unread
    const out = renderInbox(msgs, kindOf, { cursorTs, now });

    // One header per distinct day, in order.
    expect(out.indexOf('Sunday · Jul 5')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Yesterday')).toBeGreaterThan(out.indexOf('Sunday · Jul 5'));
    expect(out.indexOf('Today')).toBeGreaterThan(out.indexOf('Yesterday'));
    // Yesterday header appears exactly once though it has two messages.
    expect(out.split('Yesterday').length - 1).toBe(1);
    // Newest message renders last (terminal-friendly).
    expect(out.trimEnd().endsWith('new')).toBe(true);
    // The unread head rows (y2 @17:00 yesterday, today @10:00) carry the ▌ bar; the read one (y1
    // @11:00 yesterday, before the cursor) does not.
    expect(out).toContain('▌ 17:00');
    expect(out).toContain('▌ 10:00');
    expect(out).toContain('  11:00'); // read → two-space marker, no bar
    expect(out).not.toContain('▌ 11:00');
  });
});

describe('renderRoster', () => {
  const base = {
    team: 'dawn',
    lifecycle: 'forever' as const,
    created_at: 0,
  };

  it('groups the roster by working / here / out, with counts', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'nick',
        kind: 'human',
        role: 'lead',
        presence: 'online',
        activity: 'online',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
      },
      {
        ...base,
        id: '2',
        name: 'Ada',
        kind: 'agent',
        role: '',
        presence: 'online',
        activity: 'working',
        state: 'scaffolding tests',
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
      },
      {
        ...base,
        id: '3',
        name: 'Lin',
        kind: 'agent',
        role: '',
        presence: 'offline',
        activity: 'offline',
        presences: [],
      },
    ];
    const out = renderRoster(members);
    expect(out).toContain('WORKING');
    expect(out).toContain('HERE');
    expect(out).toContain('OUT');
    // the working member's reported status is the payload — it reads in full
    expect(out).toContain('scaffolding tests');
    expect(out).toContain('nick');
    expect(out).toContain('Lin');
  });

  it('omits a group entirely when nobody is in it (an empty group is not a fact)', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'Lin',
        kind: 'agent',
        role: '',
        presence: 'offline',
        activity: 'offline',
        presences: [],
      },
    ];
    const out = renderRoster(members);
    expect(out).toContain('OUT');
    expect(out).not.toContain('WORKING');
    expect(out).not.toContain('HERE');
  });

  it('drops the lifecycle facet when it is the `forever` default, keeps it when it is not', () => {
    const forever: MemberSummary = {
      ...base,
      id: '1',
      name: 'Ada',
      kind: 'agent',
      role: '',
      presence: 'online',
      activity: 'online',
      presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
    };
    expect(renderRoster([forever])).not.toContain('forever');
    // a `session` seat is a real signal — it says so
    expect(renderRoster([{ ...forever, lifecycle: 'session' }])).toContain('session');
    const until = Date.UTC(2026, 5, 24, 17, 0);
    expect(renderRoster([{ ...forever, lifecycle: 'until', lifecycle_until: until }])).toContain(
      'until 2026-06-24',
    );
  });

  it('shows role and model only when they carry information (no `—` / `unknown` columns)', () => {
    const bare: MemberSummary = {
      ...base,
      id: '1',
      name: 'Ada',
      kind: 'agent',
      role: '',
      presence: 'online',
      activity: 'online',
      presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
    };
    const out = renderRoster([bare]);
    expect(out).not.toContain('—');
    expect(out).not.toContain('unknown');
    // kind survives, because color may be off (NO_COLOR / piped) and it is the only text that encodes it
    expect(out).toContain('agent');
  });

  it('renders the occupancy-attested model in full, never clipped to a column (ADR 101)', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'tinybot',
        kind: 'agent',
        role: 'probe',
        presence: 'online',
        activity: 'online',
        presences: [
          {
            surface: 'cli',
            status: 'online',
            last_seen_at: 0,
            model: 'qwen2.5:3b-instruct-extra-long-id',
          },
        ],
      },
    ];
    const out = renderRoster(members);
    // the old table clipped this to fit a fixed column; a facet has no column to fit
    expect(out).toContain('qwen2.5:3b-instruct-extra-long-id');
    expect(out).toContain('probe');
  });

  it('groups a self-declared-away member under AWAY, overriding the live activity (ADR 044)', () => {
    const until = Date.UTC(2026, 5, 24, 17, 0);
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'nick',
        kind: 'human',
        role: 'lead',
        presence: 'online',
        activity: 'online',
        presences: [{ surface: 'cli', status: 'online', last_seen_at: 0 }],
        availability: { status: 'away', until },
      },
      {
        ...base,
        id: '2',
        name: 'Ada',
        kind: 'agent',
        role: '',
        presence: 'online',
        activity: 'online',
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
        availability: { status: 'dnd' },
      },
    ];
    const out = renderRoster(members);
    expect(out).toContain('AWAY');
    expect(out).toContain('off until 2026-06-24');
    expect(out).toContain('dnd');
    // availability outranks presence: neither lands in HERE despite being attached
    expect(out).not.toContain('HERE');
  });

  it('adds the age to a working member only once the status is stale (>=5m)', () => {
    const now = Date.UTC(2026, 5, 9, 15, 0);
    const working = {
      ...base,
      kind: 'agent' as const,
      role: '',
      presence: 'online' as const,
      activity: 'working' as const,
      presences: [
        { surface: 'claude-code' as const, status: 'online' as const, last_seen_at: now },
      ],
    };
    const fresh = renderRoster(
      [
        {
          ...working,
          id: '1',
          name: 'Ada',
          state: 'scaffolding tests',
          last_status_at: now - 2 * 60_000,
        },
      ],
      now,
    );
    expect(fresh).toContain('scaffolding tests');
    expect(fresh).not.toMatch(/\d+m$/m); // fresh → no age

    const stale = renderRoster(
      [
        {
          ...working,
          id: '2',
          name: 'Lin',
          state: 'refactoring auth',
          last_status_at: now - 18 * 60_000,
        },
      ],
      now,
    );
    expect(stale).toContain('refactoring auth');
    expect(stale).toContain('18m');
  });

  it('wraps a long multi-line status instead of clipping it to one line, and never overflows', () => {
    const longState =
      'Working on FindMyMoney scan/pricing.\nDone: bounded the URL-inference pass with per-file dedupe and caps; now implementing /api/scan blocking on codegen so the gap list settles server-side.';
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'Mike',
        kind: 'agent',
        role: '',
        presence: 'online',
        activity: 'working',
        state: longState,
        presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0 }],
      },
    ];
    const width = 72;
    const out = renderRoster(members, Date.now(), width);
    expect(out).toContain('Working on FindMyMoney');
    expect(out).not.toContain('\nDone:'); // the raw newline is collapsed, never spilled
    expect(out).toContain('Done:'); // ...but the text after it is still readable — it wraps
    // responsive: nothing overflows the given width
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(width);
  });

  it('shows the workspace (where) and driver (who), and stays quiet about a `session` provenance', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'Ada',
        kind: 'agent',
        role: '',
        presence: 'online',
        activity: 'working',
        state: 'wiring auth',
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
    const out = renderRoster(members);
    expect(out).toContain('movetrail@feat/login');
    expect(out).toContain('driven by nick');
    // `session` is the boring default — printing it on every row is what made the old table a dump
    expect(out).not.toContain('session');
  });

  it('surfaces a non-default provenance — a woken seat says so (ADR 131)', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'Ada',
        kind: 'agent',
        role: '',
        presence: 'online',
        activity: 'working',
        state: 'picking up the handoff',
        presences: [
          { surface: 'claude-code', status: 'online', last_seen_at: 0, provenance: 'wake' },
        ],
      },
    ];
    expect(renderRoster(members)).toContain('wake');
  });

  it('marks a residency-enrolled offline seat as wakeable — offline is not unreachable (ADR 131)', () => {
    const members: MemberSummary[] = [
      {
        ...base,
        id: '1',
        name: 'ryder',
        kind: 'agent',
        role: '',
        presence: 'offline',
        activity: 'offline',
        presences: [],
        wakeable: true,
      },
    ];
    expect(renderRoster(members)).toContain('wakeable');
  });

  it('keeps the office voice when the team is empty', () => {
    const out = renderRoster([]);
    expect(out).toContain("nobody's on the team yet");
    expect(out).toContain('musterd team add');
  });
});

describe('renderStatusHeader (the orientation card)', () => {
  const members: MemberSummary[] = [
    {
      id: '1',
      team: 'dawn',
      name: 'Ada',
      kind: 'agent',
      role: '',
      lifecycle: 'forever',
      created_at: 0,
      presence: 'online',
      activity: 'working',
      state: 'wiring auth',
      presences: [
        {
          surface: 'claude-code',
          status: 'online',
          last_seen_at: 0,
          model: 'claude-opus-4-8',
          workspace: 'movetrail@feat/login',
        },
      ],
    },
  ];

  it('shows team, roll call, and the plumbing (server, db, schema, build)', () => {
    const out = renderStatusHeader({
      team: 'dawn',
      server: 'http://localhost:4849',
      health: { db: '/srv/demo.db', schema: 3, build: 'bfe043c680cb552260b4ad3a9c64452ebb6b4f57' },
      members,
    });
    expect(out).toContain('dawn');
    expect(out).toContain('1 member · 1 present · 1 working');
    expect(out).toContain('localhost:4849');
    // the db path stays: a daemon serving the wrong db reads as "everyone offline" (dogfood finding)
    expect(out).toContain('/srv/demo.db');
    expect(out).toContain('schema 3');
    // the daemon build is shown short (ADR 130) — a stale daemon is visible without digging
    expect(out).toContain('build bfe043c');
    expect(out).not.toContain('bfe043c680cb552260b4ad3a9c64452ebb6b4f57');
  });

  it('answers "which seat is this folder?" — the question the old header never did', () => {
    const out = renderStatusHeader({
      team: 'dawn',
      server: 'http://localhost:4849',
      members,
      me: { name: 'Ada', kind: 'agent' },
    });
    expect(out).toContain('you are ');
    expect(out).toContain('Ada');
    // your own facets, so a wrong-folder mistake is catchable at a glance
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('movetrail@feat/login');
  });

  it('says so — with the fix — when this folder holds no seat', () => {
    const out = renderStatusHeader({
      team: 'dawn',
      server: 'http://localhost:4849',
      members,
    });
    expect(out).toContain('you hold no seat here');
    expect(out).toContain('musterd claim');
  });

  it('carries the waiting-acts banner inside the header, where it outranks everything (ADR 024)', () => {
    const out = renderStatusHeader({
      team: 'dawn',
      server: 'http://localhost:4849',
      members,
      me: { name: 'Ada', kind: 'agent' },
      pending: renderPendingSummary(2, Date.UTC(2026, 5, 9, 14, 32)),
    });
    expect(out).toContain('2 requests waiting for you');
  });

  it('marks the daemon dead when health is unavailable — the roster below is then stale', () => {
    const live = renderStatusHeader({
      team: 'dawn',
      server: 'http://x',
      health: { schema: 3 },
      members,
    });
    const dead = renderStatusHeader({ team: 'dawn', server: 'http://x', members });
    expect(live).toContain('●');
    expect(dead).toContain('○');
    // and with no daemon there is no db to name
    expect(dead).not.toContain('schema');
  });

  it('compresses $HOME to ~ so the db path states its identity, not its prefix', () => {
    const home = process.env['HOME'];
    if (!home) return;
    const out = renderStatusHeader({
      team: 'dawn',
      server: 'http://x',
      health: { db: `${home}/.musterd/musterd.db` },
      members,
    });
    expect(out).toContain('~/.musterd/musterd.db');
    expect(out).not.toContain(`${home}/.musterd`);
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
  it('is a framed nameplate: dots + musterd chip + cursor + tagline', () => {
    const banner = renderBanner();
    expect(banner).toContain('●'); // at least one roll-call presence dot
    expect(banner).toContain('○'); // …including the offline state
    expect(banner).toContain('musterd'); // the wordmark chip (literal word, no letter-art)
    expect(banner).toContain('persistent teams'); // the tagline
    expect(banner).toContain('╭'); // the rounded nameplate frame
    // Top border + two content rows + bottom border.
    expect(banner.split('\n')).toHaveLength(4);
  });

  it('aligns the nameplate: every rendered line is the same visible width', () => {
    // With color pinned off (NO_COLOR), visible width == string length. The frame must be a rectangle.
    const lines = renderBanner().split('\n');
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});
