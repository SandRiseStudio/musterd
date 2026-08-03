import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit } from './audit.js';
import { addMember } from './members.js';
import { attach } from './presence.js';
import { resolveQuiescence, quietestBusyMs } from './quiescence.js';
import { createTeam } from './teams.js';

/**
 * The quiescence derivation (2026-08-03 design, spec in docs/superpowers/specs). Split from
 * `activity` because the display signal cannot answer the decision question: for agents `working`
 * is sticky forever once a status posts, and `connections > 0` measured as "busy" would have
 * deferred 95% of daemon refreshes (184/192, measured on the dogfood log). Meanwhile the audit
 * trail shows the team genuinely quiet most of the time — 44 lulls ≥ 2 min in 6 busy hours — so
 * "time since the newest audited action" is a signal with actual discriminating power.
 */

describe('resolveQuiescence (pure)', () => {
  const NOW = 10_000_000;

  it("is busy under the threshold, quiet at and beyond it — the line is the CALLER's", () => {
    expect(resolveQuiescence(NOW - 30_000, NOW, 120_000)).toEqual({
      state: 'busy',
      quiet_for_ms: 30_000,
      source: 'audit',
    });
    expect(resolveQuiescence(NOW - 120_000, NOW, 120_000).state).toBe('quiet');
    expect(resolveQuiescence(NOW - 300_000, NOW, 120_000)).toEqual({
      state: 'quiet',
      quiet_for_ms: 300_000,
      source: 'audit',
    });
    // Same instant, different threshold, different verdict — thresholds live in the consumer.
    expect(resolveQuiescence(NOW - 30_000, NOW, 10_000).state).toBe('quiet');
  });

  it('is unknown when there is no observed action — never quiet-by-absence', () => {
    expect(resolveQuiescence(null, NOW, 120_000)).toEqual({
      state: 'unknown',
      quiet_for_ms: null,
      source: 'audit',
    });
  });

  it('clamps a clock-skewed future action to busy-now rather than a negative age', () => {
    const q = resolveQuiescence(NOW + 5_000, NOW, 120_000);
    expect(q.state).toBe('busy');
    expect(q.quiet_for_ms).toBe(0);
  });
});

describe('quietestBusyMs (db read for /health)', () => {
  function seed() {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'revive' });
    const ada = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    const lin = addMember(db, team, { name: 'lin', kind: 'agent' }).row;
    const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    return { db, team, ada, lin, nick };
  }
  const act = (db: any, teamId: string, actor: string, at: number) => {
    vi.setSystemTime(at);
    appendAudit(db, teamId, { actor, action: 'x.did', target: null, result: 'allow' });
  };

  it('returns the age of the most recent action across LIVE agent seats', () => {
    vi.useFakeTimers();
    try {
      const { db, team, ada, lin } = seed();
      const now = 10_000_000;
      vi.setSystemTime(now);
      attach(db, ada.id, 'claude-code', 'c1');
      attach(db, lin.id, 'claude-code', 'c2');
      act(db, team.id, 'ada', now - 300_000); // quiet 5m
      act(db, team.id, 'lin', now - 40_000); // quiet 40s ← the minimum
      vi.setSystemTime(now);
      expect(quietestBusyMs(db, { now, presenceTimeoutMs: 60_000 })).toBe(40_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores actions by seats that are no longer live, and by humans', () => {
    vi.useFakeTimers();
    try {
      const { db, team, ada } = seed();
      const now = 10_000_000;
      vi.setSystemTime(now);
      attach(db, ada.id, 'claude-code', 'c1');
      act(db, team.id, 'ada', now - 300_000);
      // lin acted 5s ago but holds no live presence; nick is live but human. Neither may win.
      act(db, team.id, 'lin', now - 5_000);
      act(db, team.id, 'nick', now - 1_000);
      vi.setSystemTime(now);
      expect(quietestBusyMs(db, { now, presenceTimeoutMs: 60_000 })).toBe(300_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is null when no live agent seat has any action in the lookback — unknown, not zero', () => {
    vi.useFakeTimers();
    try {
      const { db, team, ada } = seed();
      const now = 10_000_000;
      vi.setSystemTime(now);
      attach(db, ada.id, 'claude-code', 'c1');
      // One action, but far outside the lookback window: stale evidence is no evidence.
      act(db, team.id, 'ada', now - 3 * 60 * 60_000);
      vi.setSystemTime(now);
      expect(
        quietestBusyMs(db, { now, presenceTimeoutMs: 60_000, lookbackMs: 60 * 60_000 }),
      ).toBeNull();
      // And with no live seats at all it is also null.
      const empty = openDb(':memory:');
      createTeam(empty, { slug: 't' });
      expect(quietestBusyMs(empty, { now, presenceTimeoutMs: 60_000 })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
