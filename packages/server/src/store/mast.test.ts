import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  circularHandoffs,
  deriveMast,
  diversityFlags,
  stalledThreads,
  timeToUnblock,
} from './mast.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 40 * DAY;

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  const bob = addMember(db, team, { name: 'bob', kind: 'agent' }).row;
  return { db, team, nick, ada, bob };
}

function msg(
  db: Database,
  team: TeamRow,
  from: MemberRow,
  to: MemberRow | null,
  act: Act,
  id: string,
  ts: number,
  opts: { thread?: string; meta?: Record<string, unknown> } = {},
) {
  insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act,
      body: 'x',
      thread: opts.thread ?? null,
      meta: opts.meta ?? null,
      ts,
    }),
  );
}

describe('timeToUnblock (ADR 091)', () => {
  it('measures open→close for accept-by-reply and resolve-on-thread; empty-safe', () => {
    const { db, team, nick, ada } = seed();
    expect(timeToUnblock(db, team.id, NOW)).toEqual({ closed: 0, median_ms: null, p95_ms: null });

    // accept names the handoff → 5m loop.
    msg(db, team, nick, ada, 'handoff', 'h1', NOW - HOUR);
    msg(db, team, ada, nick, 'accept', 'a1', NOW - HOUR + 5 * 60_000, {
      meta: { in_reply_to: 'h1' },
    });
    // resolve closes the request_help's thread → 30m loop.
    msg(db, team, nick, null, 'request_help', 'r1', NOW - HOUR, { thread: 't1' });
    msg(db, team, ada, null, 'resolve', 'v1', NOW - HOUR + 30 * 60_000, { thread: 't1' });

    const t = timeToUnblock(db, team.id, NOW);
    expect(t.closed).toBe(2);
    expect(t.median_ms).toBe(30 * 60_000);
    expect(t.p95_ms).toBe(30 * 60_000);
  });

  it('ignores loops closed outside the 7d window', () => {
    const { db, team, nick, ada } = seed();
    msg(db, team, nick, ada, 'handoff', 'h1', NOW - 20 * DAY);
    msg(db, team, ada, nick, 'accept', 'a1', NOW - 19 * DAY, { meta: { in_reply_to: 'h1' } });
    expect(timeToUnblock(db, team.id, NOW).closed).toBe(0);
  });
});

describe('stalledThreads (ADR 091)', () => {
  it('flags a multi-act unresolved thread quiet past 24h; resolve or activity clears it', () => {
    const { db, team, nick, ada } = seed();
    // Stalled: two acts, quiet 2 days, no resolve.
    msg(db, team, nick, ada, 'handoff', 'h1', NOW - 3 * DAY, { thread: 'stall' });
    msg(db, team, ada, nick, 'accept', 'a1', NOW - 2 * DAY, {
      thread: 'stall',
      meta: { in_reply_to: 'h1' },
    });
    // Not stalled: resolved.
    msg(db, team, nick, null, 'request_help', 'r1', NOW - 3 * DAY, { thread: 'done' });
    msg(db, team, ada, null, 'resolve', 'v1', NOW - 2 * DAY, { thread: 'done' });
    // Not stalled: still active.
    msg(db, team, nick, ada, 'message', 'm1', NOW - 3 * DAY, { thread: 'live' });
    msg(db, team, ada, nick, 'message', 'm2', NOW - HOUR, { thread: 'live' });
    // Not stalled: single act.
    msg(db, team, nick, ada, 'message', 'm3', NOW - 3 * DAY, { thread: 'solo' });

    const stalled = stalledThreads(db, team.id, NOW);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({
      thread: 'stall',
      acts: 2,
      participants: 2,
      last_act: 'accept',
    });
    expect(stalled[0]!.quiet_ms).toBe(2 * DAY);
  });
});

describe('circularHandoffs (ADR 091)', () => {
  it('flags a handoff returning to a prior participant; a linear chain stays clean', () => {
    const { db, team, nick, ada, bob } = seed();
    // Circular: nick→ada→bob→nick on one thread.
    msg(db, team, nick, ada, 'handoff', 'c1', NOW - 3 * HOUR, { thread: 'circle' });
    msg(db, team, ada, bob, 'handoff', 'c2', NOW - 2 * HOUR, { thread: 'circle' });
    msg(db, team, bob, nick, 'handoff', 'c3', NOW - HOUR, { thread: 'circle' });
    // Linear: nick→ada, then ada→bob on another thread.
    msg(db, team, nick, ada, 'handoff', 'l1', NOW - 3 * HOUR, { thread: 'line' });
    msg(db, team, ada, bob, 'handoff', 'l2', NOW - 2 * HOUR, { thread: 'line' });

    const circles = circularHandoffs(db, team.id, NOW);
    expect(circles).toHaveLength(1);
    expect(circles[0]).toMatchObject({ thread: 'circle', hops: 3 });
  });
});

describe('diversityFlags (ADR 101)', () => {
  it('flags a single-family approval chain; a cross-family chain stays silent', () => {
    const { db, team, nick, ada, bob } = seed();
    // Single-family: both acts stamped claude-* → flagged.
    msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
      thread: 'same',
      meta: { model: 'claude-sonnet-5' },
    });
    msg(db, team, bob, ada, 'accept', 'a1', NOW - HOUR, {
      thread: 'same',
      meta: { in_reply_to: 'h1', model: 'claude-opus-4-8' },
    });
    // Cross-family: claude vs gpt → diverse, silent.
    msg(db, team, ada, bob, 'request_help', 'r1', NOW - 2 * HOUR, {
      thread: 'cross',
      meta: { model: 'claude-opus-4-8' },
    });
    msg(db, team, bob, ada, 'accept', 'a2', NOW - HOUR, {
      thread: 'cross',
      meta: { in_reply_to: 'r1', model: 'gpt-5.2-codex' },
    });

    const flags = diversityFlags(db, team.id, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      thread: 'same',
      kind: 'handoff',
      participants: 2,
      families: ['claude'],
      verdict: 'flagged',
    });
    // nick unused in this test — keep the seed signature.
    void nick;
  });

  it('marks a chain with an unattested link unverifiable — never presumed diverse', () => {
    const { db, team, ada, bob } = seed();
    msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
      thread: 't',
      meta: { model: 'claude-opus-4-8' },
    });
    msg(db, team, bob, ada, 'accept', 'a1', NOW - HOUR, {
      thread: 't',
      meta: { in_reply_to: 'h1' },
    });

    const flags = diversityFlags(db, team.id, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ thread: 't', verdict: 'unverifiable' });
  });

  it('ignores self-answered chains and closures outside the window', () => {
    const { db, team, ada, bob } = seed();
    // Self-answer: same seat opens and closes — not an agreement between actors.
    msg(db, team, ada, bob, 'handoff', 'h1', NOW - 2 * HOUR, {
      thread: 'self',
      meta: { model: 'claude-opus-4-8' },
    });
    msg(db, team, ada, bob, 'accept', 'a1', NOW - HOUR, {
      thread: 'self',
      meta: { in_reply_to: 'h1', model: 'claude-opus-4-8' },
    });
    // Out of window.
    msg(db, team, ada, bob, 'handoff', 'h2', NOW - 20 * DAY, {
      thread: 'old',
      meta: { model: 'claude-opus-4-8' },
    });
    msg(db, team, bob, ada, 'accept', 'a2', NOW - 19 * DAY, {
      thread: 'old',
      meta: { in_reply_to: 'h2', model: 'claude-opus-4-8' },
    });

    expect(diversityFlags(db, team.id, NOW)).toEqual([]);
  });
});

describe('deriveMast (the report block)', () => {
  it('composes the views and filters ignored_help off the ADR 090 ledger by age', () => {
    const { db, team, nick } = seed();
    msg(db, team, nick, null, 'request_help', 'old', NOW - 2 * HOUR); // ignored (> 1h)
    msg(db, team, nick, null, 'request_help', 'new', NOW - 10 * 60_000); // fresh — not ignored yet

    const m = deriveMast(db, team.id, NOW);
    expect(m.window_days).toBe(7);
    expect(m.ignored_help.map((d) => d.id)).toEqual(['old']);
    expect(m.stalled_threads).toEqual([]);
    expect(m.circular_handoffs).toEqual([]);
    expect(m.diversity).toEqual([]);
  });
});
