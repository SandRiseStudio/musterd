import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit, listAudit } from './audit.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { attach } from './presence.js';
import {
  WAKE_ATTEMPT_CAP,
  WAKE_COOLDOWN_MS,
  WAKE_DEFER_SNOOZE_MS,
  WAKE_HOURLY_CAP,
  WAKE_LEASE_TTL_MS,
  claimWakeLeases,
  enrollResidency,
  expireWakeLeases,
  getResidency,
  listWakeableMemberIds,
  recordSessionAttestation,
  revokeResidency,
  settleWakeLease,
} from './residency.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

const PRESENCE_TIMEOUT_MS = 45_000;
const HOST = 'laptop.local';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
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

function enroll(db: Database, team: TeamRow, member: MemberRow, host = HOST) {
  return enrollResidency(db, team.id, {
    member_id: member.id,
    harness: 'claude-code',
    host,
    grant_id: 'g1',
    authorized_by: 'nick',
  });
}

/** Simulate a reported actuation outcome — the audit rows the rate policy derives from. */
function wakeOutcomeRow(
  db: Database,
  team: TeamRow,
  seat: string,
  actId: string,
  action: 'residency.woke' | 'residency.wake_failed',
  ts?: number,
) {
  appendAudit(db, team.id, {
    actor: null,
    action,
    target: seat,
    result: action === 'residency.woke' ? 'allow' : 'deny',
    detail: { act: actId, lease_id: 'x' },
  });
  if (ts !== undefined) {
    // Backdate for cooldown/hourly-window tests (appendAudit stamps now). Keyed on rowid — the only
    // strictly monotonic column when several rows land in the same millisecond.
    db.prepare(
      'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
    ).run(ts);
  }
}

describe('residency enrollment (ADR 131)', () => {
  it('enrolls, upserts on re-enroll (last-enrolled-wins), and revokes', () => {
    const { db, team, ada } = seed();
    const first = enroll(db, team, ada, 'host-a');
    expect(first.previous).toBeNull();
    expect(first.row.host).toBe('host-a');
    expect(listWakeableMemberIds(db, team.id).has(ada.id)).toBe(true);

    // Re-enrolling moves the seat to the new host and reports the superseded enrollment.
    const second = enrollResidency(db, team.id, {
      member_id: ada.id,
      harness: 'claude-code',
      host: 'host-b',
      grant_id: 'g2',
      authorized_by: 'nick',
    });
    expect(second.previous?.host).toBe('host-a');
    expect(second.previous?.grant_id).toBe('g1');
    expect(second.row.id).toBe(first.row.id);
    expect(getResidency(db, team.id, ada.id)?.host).toBe('host-b');

    const removed = revokeResidency(db, team.id, ada.id);
    expect(removed?.grant_id).toBe('g2');
    expect(getResidency(db, team.id, ada.id)).toBeNull();
    expect(listWakeableMemberIds(db, team.id).has(ada.id)).toBe(false);
    expect(revokeResidency(db, team.id, ada.id)).toBeNull();
  });
});

describe('claimWakeLeases — the transactional wake derivation', () => {
  it('orders an immediate wake for an urgent directed act to an offline enrolled seat', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.seat).toBe('Ada');
    expect(order.act_id).toBe('u1');
    expect(order.lane).toBe('immediate');
    expect(order.sender).toBe('nick');
    // Composed from structured fields only — never the act body (which is 'x').
    expect(order.composed_line).toContain('"nick"');
    expect(order.composed_line).toContain('"Ada"');
    expect(order.composed_line).not.toContain(' x ');
    expect(order.expires_at).toBeGreaterThan(Date.now());

    // The lease decision is audited (actor null — a machine decision).
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(leased).toHaveLength(1);
    expect(leased[0]!.target).toBe('Ada');
  });

  it('holds mutual exclusion: a live lease blocks a second order for the same seat', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });

    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
    // Re-poll (same host or another poll loop): the live lease means no new order.
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('derives nothing for a host the seat is not enrolled to (last-enrolled-wins)', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, 'host-a');
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    expect(claimWakeLeases(db, team.id, team.slug, 'host-b', PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    expect(claimWakeLeases(db, team.id, team.slug, 'host-a', PRESENCE_TIMEOUT_MS)).toHaveLength(1);
  });

  it('never wakes a seat with live presence', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    attach(db, ada.id, 'claude-code', 'conn1');
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('wakes on the batched lane for an ordinary unanswered handoff, immediate lane first', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lane).toBe('batched');
    expect(orders[0]!.act).toBe('handoff');

    // An urgent act outranks the batched ledger: immediate lane wins the single per-poll lease.
    const { db: db2, team: team2, nick: nick2, ada: ada2 } = seed();
    enroll(db2, team2, ada2);
    msg(db2, team2, nick2, ada2, 'handoff', 'h1', 1_000);
    msg(db2, team2, nick2, ada2, 'steer', 's1', 2_000);
    const orders2 = claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders2).toHaveLength(1);
    expect(orders2[0]!.lane).toBe('immediate');
    expect(orders2[0]!.act_id).toBe('s1');
  });

  it('skips an answered act: an accept naming it closes the loop', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('applies the batched-lane cooldown but lets the immediate lane through', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    const now = Date.now();
    // A wake completed 5 minutes ago — inside the 30-minute batched cooldown.
    wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', now - 5 * 60_000);

    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);

    // An interrupt-class act ignores the cooldown (same scarcity as the live interrupt line).
    msg(db, team, nick, ada, 'steer', 's1', 2_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lane).toBe('immediate');

    // Past the cooldown window the batched lane is due again.
    const { db: db3, team: team3, nick: nick3, ada: ada3 } = seed();
    enroll(db3, team3, ada3);
    wakeOutcomeRow(db3, team3, 'Ada', 'old-act', 'residency.woke', now - WAKE_COOLDOWN_MS - 1_000);
    msg(db3, team3, nick3, ada3, 'handoff', 'h1', 1_000);
    expect(claimWakeLeases(db3, team3.id, team3.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
  });

  it('enforces the hourly cap across both lanes', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    const now = Date.now();
    for (let i = 0; i < WAKE_HOURLY_CAP; i++) {
      wakeOutcomeRow(db, team, 'Ada', `past-${i}`, 'residency.woke', now - 10 * 60_000);
    }
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('writes a terminal wake_exhausted (once) at the per-act attempt cap and stops waking that act', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    // The act already burned its attempts — backdated outside cooldown/hourly windows so only the
    // per-act cap is in play.
    const old = Date.now() - 2 * 3_600_000;
    for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) {
      wakeOutcomeRow(db, team, 'Ada', 's1', 'residency.wake_failed', old);
    }
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    let exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(JSON.parse(exhausted[0]!.detail!)['act']).toBe('s1');
    // A second poll never duplicates the terminal row.
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(exhausted).toHaveLength(1);
  });
});

describe('wake-lease settlement + expiry', () => {
  it('settles a lease once; an unknown or already-reported lease returns null', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const lease = settleWakeLease(db, team.id, order!.lease_id);
    expect(lease?.act_id).toBe('u1');
    expect(settleWakeLease(db, team.id, order!.lease_id)).toBeNull();
    expect(settleWakeLease(db, team.id, 'nope')).toBeNull();
  });

  it('expires overdue leases (reaper) so the wake re-becomes due, bounded by rate policy', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(order).toBeDefined();

    expect(expireWakeLeases(db, Date.now())).toHaveLength(0); // not overdue yet
    const expired = expireWakeLeases(db, Date.now() + WAKE_LEASE_TTL_MS + 1);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe(order!.lease_id);

    // With the lease expired (and the reaper's wake_failed row not yet at any cap), it re-leases.
    const again = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(again).toHaveLength(1);
    expect(again[0]!.act_id).toBe('u1');
  });
});

describe('session capture (ADR 131 inc 4): attestation + the wake_deferred snooze', () => {
  /** A host-reported deferral (the local-session guard) — the audit row the snooze derives from. */
  function deferredRow(db: Database, team: TeamRow, seat: string, ts?: number) {
    appendAudit(db, team.id, {
      actor: null,
      action: 'residency.wake_deferred',
      target: seat,
      result: 'allow',
      detail: { act: 'u1', lease_id: 'x', reason: 'local-session-live' },
    });
    if (ts !== undefined) {
      db.prepare(
        'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
      ).run(ts);
    }
  }

  it('recordSessionAttestation stamps the enrolled row (harness class only); unenrolled is false', () => {
    const { db, team, ada, bob } = seed();
    enroll(db, team, ada);
    expect(recordSessionAttestation(db, team.id, ada.id, 'claude-code', 42)).toBe(true);
    const row = getResidency(db, team.id, ada.id)!;
    expect(row.resumable_harness).toBe('claude-code');
    expect(row.resumable_at).toBe(42);
    // bob never enrolled — the capture is honest about it, and nothing is created.
    expect(recordSessionAttestation(db, team.id, bob.id, 'claude-code')).toBe(false);
    expect(getResidency(db, team.id, bob.id)).toBeNull();
  });

  it('a fresh wake_deferred snoozes lease derivation; it lifts after WAKE_DEFER_SNOOZE_MS', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    deferredRow(db, team, ada.name); // just reported — the human is working there
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);

    // Backdate the deferral past the snooze window: the act is still due, full budget intact.
    db.prepare("UPDATE audit SET ts = ? WHERE action = 'residency.wake_deferred'").run(
      Date.now() - WAKE_DEFER_SNOOZE_MS - 1_000,
    );
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.act_id).toBe('u1');
  });

  it('deferrals burn NO attempt or rate budget: many deferrals, then a wake with full caps', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    // A long working session deferred the wake many times over (all past the snooze window now) —
    // more rows than the attempt cap and the hourly cap combined.
    const old = Date.now() - WAKE_DEFER_SNOOZE_MS - 60_000;
    for (let i = 0; i < WAKE_ATTEMPT_CAP + WAKE_HOURLY_CAP + 1; i++) {
      deferredRow(db, team, ada.name, old - i * 1_000);
    }
    // The act still derives a lease (attempt cap untouched), and no wake_exhausted was written.
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(
      listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted'),
    ).toHaveLength(0);
  });
});
