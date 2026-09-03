import { makeEnvelope, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit, listAudit } from './audit.js';
import { openLane, updateLane } from './lanes.js';
import { addMember, getMemberByName } from './members.js';
import { insertMessage } from './messages.js';
import { attach } from './presence.js';
import {
  WAKE_DEFER_SNOOZE_MS,
  WAKE_LEASE_TTL_MS,
  WAKE_POLICY_DEFAULTS,
  WORK_ORDER_CONTINUATION_SUCCESS_CAP,
  buildWakeContext,
  claimWakeLeases,
  effectiveWakePolicy,
  enrollResidency,
  expireWakeLeases,
  getResidency,
  listWakeableMemberIds,
  parsePolicyOverride,
  recordSessionAttestation,
  revokeResidency,
  settleWakeLease,
  markWakeSpawned,
} from './residency.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam, getPolicy, setPolicy } from './teams.js';

const WAKE_COOLDOWN_MS = WAKE_POLICY_DEFAULTS.cooldown_ms;
const WAKE_HOURLY_CAP = WAKE_POLICY_DEFAULTS.hourly_cap;
const WAKE_ATTEMPT_CAP = WAKE_POLICY_DEFAULTS.attempt_cap;

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

function enroll(
  db: Database,
  team: TeamRow,
  member: MemberRow,
  host = HOST,
  policy?: Record<string, unknown>,
) {
  return enrollResidency(db, team.id, {
    member_id: member.id,
    harness: 'claude-code',
    host,
    grant_id: 'g1',
    authorized_by: 'nick',
    ...(policy !== undefined ? { policy } : {}),
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

describe('buildWakeContext (ADR 209)', () => {
  it('derives a body-free reply packet only for the directed recipient', () => {
    const { db, team, nick, ada, bob } = seed();
    msg(db, team, nick, ada, 'message', 'm1', 1_000, { thread: 't1' });

    expect(buildWakeContext(db, team, ada, { act_id: 'm1' })).toMatchObject({
      wake: { kind: 'reply', act_id: 'm1' },
      objective: { action: 'reply' },
      fetch: ['inbox_thread', 'seat_memory'],
      delivery: { requirement: 'portable', intended: 'fresh' },
    });
    expect(() => buildWakeContext(db, team, bob, { act_id: 'm1' })).toThrow(/forbidden/i);
  });

  it('derives handoff, review, and owned work-order packets without stored bodies', () => {
    const { db, team, nick, ada } = seed();
    const lane = openLane(db, team.id, team.slug, ada.name, {
      title: 'Portable context',
      branch: 'feat/context',
      claim: true,
    });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id } },
    });
    msg(db, team, nick, ada, 'ask', 'r1', 1_001, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });

    expect(buildWakeContext(db, team, ada, { act_id: 'h1' })).toMatchObject({
      wake: { kind: 'handoff' },
      objective: { action: 'continue_lane' },
      state: { lane: { id: lane.id, branch: 'feat/context' } },
      fetch: ['inbox_thread', 'lane_detail', 'git_artifact', 'seat_memory'],
    });
    expect(buildWakeContext(db, team, ada, { act_id: 'r1' })).toMatchObject({
      wake: { kind: 'review' },
      objective: { action: 'review' },
    });
    expect(buildWakeContext(db, team, ada, { lane_id: lane.id })).toMatchObject({
      wake: { kind: 'work_order', lane_id: lane.id },
      objective: { action: 'begin_lane' },
    });
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
    expect(order.composed_line).toContain('team_wake_context');
    expect(order.expires_at).toBeGreaterThan(Date.now());

    // The lease decision is audited (actor null — a machine decision).
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(leased).toHaveLength(1);
    expect(leased[0]!.target).toBe('Ada');
  });

  it("ignores a peer machine's wake rows: the hourly cap counts what this daemon minted", () => {
    // ADR 365 §3. The six wake verbs replicate now, so a peer's rows land in THIS `audit`. They
    // must not decide here: folding them into the rate cap would make wake caps team-wide, which
    // is a decision crossing the wire (residence 3) and not ADR 365's to make.
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    const now = Date.now();
    for (let i = 0; i < WAKE_HOURLY_CAP + 3; i += 1) {
      db.prepare(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
         VALUES (?, ?, ?, NULL, 'residency.woke', ?, 'allow', ?, ?, 'peer-node', ?)`,
      ).run(
        `peer-${i}`,
        team.id,
        now - 60_000,
        'Ada',
        JSON.stringify({ act: `p${i}` }),
        now,
        i + 1,
      );
    }
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });

    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
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

  // ADR 090's `answered` predicate is an accept/decline naming the act, or a resolve on its thread.
  // A HANDOFF is not discharged that way in practice — it is discharged by DOING THE WORK. Measured
  // on the live ledger 2026-08-06: miley handed ryder lane 01KZ9W0R29, he shipped it (ADR 246,
  // #716/#722, lane submitted 18:19:57), and no accept ever named the handoff and no resolve ever
  // landed on its thread. So the candidate query never learned it was done and kept spawning
  // sessions three hours later — three per envelope, and her one handoff was TWO envelopes, so six
  // paid wakes for work already merged.
  // A fresh db per assertion, deliberately: `claimWakeLeases` CLAIMS a lease, so a second call on
  // the same db is suppressed by the live lease and by the cooldown — which made the first draft of
  // this test pass before the fix existed, for entirely the wrong reason. (The file's db2/db3 idiom
  // is here for the same hazard.)
  const handoffOfLane = (laneState?: 'awaiting_acceptance' | 'done' | 'abandoned' | 'active') => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    const lane = openLane(db, team.id, team.slug, 'nick', {
      title: 'the handed work',
      claim: false,
    });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id, branch: null } },
    });
    if (laneState) {
      updateLane(db, team.id, lane.id, team.slug, { state: laneState, owner_seat: 'Ada' });
    }
    return claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
  };

  it('skips a lane handoff whose lane the recipient already discharged', () => {
    // Still owed while the lane is live work — the control.
    expect(handoffOfLane()).toHaveLength(1);
    // Submitted for acceptance: shipped and merged. Waking to redo it is the defect.
    expect(handoffOfLane('awaiting_acceptance')).toHaveLength(0);
    expect(handoffOfLane('done')).toHaveLength(0);
    expect(handoffOfLane('abandoned')).toHaveLength(0);
  });

  // The property that makes DERIVING this (rather than storing a flag) the right shape: a rejected
  // acceptance sends the lane back to active and the handoff becomes owed again by itself.
  it('re-owes the handoff when acceptance sends the lane back to active', () => {
    expect(handoffOfLane('active')).toHaveLength(1);
  });

  // Narrow on purpose: only a handoff that NAMES a live lane is discharged this way. A bare handoff,
  // or one naming a lane that no longer exists, keeps the old behaviour rather than going quiet.
  it('leaves a handoff that names no lane exactly as it was', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);

    const { db: db2, team: team2, nick: nick2, ada: ada2 } = seed();
    enroll(db2, team2, ada2);
    msg(db2, team2, nick2, ada2, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: '01NOSUCHLANE0000000000000', branch: null } },
    });
    expect(claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
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

describe('claimWakeLeases — a deferred act is not a wake reason (ADR 211 §4)', () => {
  it('does not wake a seat for an act it deferred', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    // Ada says "not now" — the act stays durably unread, but it stops being a reason to spawn her.
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });

    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('does not wake for a RAISED deferral either — increment 2 turns that on deliberately', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });
    // The condition fires: the act is pending again in the inbox, but wake eligibility for raised
    // deferrals is withheld until its own increment, so nothing is leased here.
    msg(db, team, nick, null, 'message', 'l1', 3_000, {
      meta: { lane_state: { lane: 'L1', state: 'done' } },
    });

    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('still wakes for a NON-deferred act alongside a deferred one', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'deferred one' },
    });
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });
    msg(db, team, nick, ada, 'message', 'u2', 3_000, {
      meta: { urgent: true, urgent_reason: 'this one still counts' },
    });

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.act_id).toBe('u2');
  });

  it('wakes again once the deferral is withdrawn by a newer wait naming a fired condition', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);

    // A deferral by a seat OTHER than the recipient must not suppress anything.
    msg(db, team, nick, null, 'wait', 'w2', 2_500, {
      meta: { defer_ref: 'u1', until: { reply: true } },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });
});

describe('claimWakeLeases — raised deferrals as wake candidates (ADR 211 increment 2)', () => {
  /** Ada defers an urgent directed act until lane L1, then L1 moves. */
  function deferredThenRaised(policy?: Record<string, unknown>) {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, policy);
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });
    msg(db, team, nick, null, 'message', 'l1', 3_000, {
      meta: { lane_state: { lane: 'L1', state: 'done' } },
    });
    return { db, team };
  }

  it('stays suppressed while the knob is off — the launch default', () => {
    const { db, team } = deferredThenRaised();
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('wakes once the knob is on', () => {
    const { db, team } = deferredThenRaised({ raised_deferral_wakes: true });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.act_id).toBe('u1');
  });

  it('takes the BATCHED lane even though the act was urgent — a deferral must not jump the line', () => {
    const { db, team } = deferredThenRaised({ raised_deferral_wakes: true });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders[0]!.lane).toBe('batched');
    expect(orders[0]!.derivation).toBe('batched');
  });

  it('does not wake a deferral whose condition has NOT fired, knob on', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { raised_deferral_wakes: true });
    msg(db, team, nick, ada, 'message', 'u1', 1_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });
    msg(db, team, ada, null, 'wait', 'w1', 2_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L1' } },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('respects a seat pinned to the interrupt lane: batched is closed, so nothing is ordered', () => {
    const { db, team } = deferredThenRaised({ raised_deferral_wakes: true, lane: 'interrupt' });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('re-deferring after a raise suppresses it again', () => {
    const { db, team } = deferredThenRaised({ raised_deferral_wakes: true });
    const ada = getMemberByName(db, team.id, 'Ada')!;
    const nick = getMemberByName(db, team.id, 'nick')!;
    msg(db, team, ada, null, 'wait', 'w2', 4_000, {
      meta: { defer_ref: 'u1', until: { lane: 'L2' } },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    // ...and raises again when the NEW condition fires.
    msg(db, team, nick, null, 'message', 'l2', 5_000, {
      meta: { lane_state: { lane: 'L2', state: 'done' } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.map((o) => o.act_id)).toEqual(['u1']);
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

describe('wake policy (ADR 131 inc 5): defaults ⊕ team ⊕ seat', () => {
  it('effectiveWakePolicy layers a sparse override; unparseable/unknown input degrades honestly', () => {
    const defaults = WAKE_POLICY_DEFAULTS;
    expect(effectiveWakePolicy(defaults, null)).toEqual(defaults);
    const merged = effectiveWakePolicy(defaults, JSON.stringify({ cooldown_ms: 900_000 }));
    expect(merged.cooldown_ms).toBe(900_000);
    expect(merged.hourly_cap).toBe(defaults.hourly_cap); // unset keys flow through
    // Drift (hand-edit, downgrade): unreadable ⇒ no override, never a throwing wake pipeline.
    expect(effectiveWakePolicy(defaults, 'not json')).toEqual(defaults);
    expect(parsePolicyOverride('{"unknown_knob": 5}')).toEqual({}); // zod strips unknowns
  });

  it('team defaults govern the derivation (cooldown via setPolicy, no per-seat override)', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    // Shrink the team cooldown to 5 minutes; a wake 10 minutes ago no longer blocks batched.
    setPolicy(db, team.id, {
      ...getPolicy(db, team.id),
      residency: { ...WAKE_POLICY_DEFAULTS, cooldown_ms: 5 * 60_000 },
    });
    wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', Date.now() - 10 * 60_000);
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
  });

  it('a seat override tightens the hourly cap below the team default', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { hourly_cap: 1 });
    wakeOutcomeRow(db, team, 'Ada', 'past-0', 'residency.woke', Date.now() - 45 * 60_000);
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    // One wake this hour ≥ the seat's cap of 1 — nothing derives (default cap of 2 would allow).
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('lane=interrupt never leases batched candidates; lane=batched never leases a steer', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { lane: 'interrupt' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    msg(db, team, nick, ada, 'steer', 's1', 2_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lane).toBe('immediate');

    const { db: db2, team: team2, nick: nick2, ada: ada2 } = seed();
    enroll(db2, team2, ada2, HOST, { lane: 'batched' });
    msg(db2, team2, nick2, ada2, 'steer', 's1', 1_000);
    expect(claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    msg(db2, team2, nick2, ada2, 'handoff', 'h1', 2_000);
    const orders2 = claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders2).toHaveLength(1);
    expect(orders2[0]!.lane).toBe('batched');
  });

  it('a seat attempt_cap override exhausts at the effective cap and audits it', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { attempt_cap: 2 });
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    const old = Date.now() - 2 * 3_600_000;
    for (let i = 0; i < 2; i++) wakeOutcomeRow(db, team, 'Ada', 's1', 'residency.wake_failed', old);
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    const exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(JSON.parse(exhausted[0]!.detail!)['attempts']).toBe(2);
  });

  it('the emitted order carries the effective actuation knobs for the host', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, {
      tool_policy: 'seat-policy',
      timeout_ms: 120_000,
      max_turns: 12,
      budget_usd: 2,
      transcript_max_bytes: 2_097_152,
    });
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(order!.tool_policy).toBe('seat-policy');
    expect(order!.bounds).toEqual({ timeout_ms: 120_000, max_turns: 12, budget_usd: 2 });
    expect(order!.transcript_max_bytes).toBe(2_097_152);
  });

  it('re-enroll without a policy preserves the override; {} clears it', () => {
    const { db, team, ada } = seed();
    enroll(db, team, ada, HOST, { hourly_cap: 5 });
    expect(getResidency(db, team.id, ada.id)?.policy).toBe('{"hourly_cap":5}');
    enroll(db, team, ada); // drift-fixing re-enroll, no policy — tuning survives
    expect(getResidency(db, team.id, ada.id)?.policy).toBe('{"hourly_cap":5}');
    enroll(db, team, ada, HOST, {}); // explicit clear
    expect(getResidency(db, team.id, ada.id)?.policy).toBeNull();
  });
});

describe('ping-pong demotion (ADR 131 §4, landed inc 5)', () => {
  /** A steer sent while the SENDER's live presence attests provenance `wake` — the machine chain. */
  function steerFromWakeOccupancy(
    db: Database,
    team: TeamRow,
    sender: MemberRow,
    recipient: MemberRow,
    id: string,
    ts: number,
  ) {
    attach(db, sender.id, 'claude-code', `conn-${id}`, { provenance: 'wake' });
    msg(db, team, sender, recipient, 'steer', id, ts);
  }

  it('an interrupt-class act sent from a wake occupancy is demoted to the batched lane', () => {
    const { db, team, ada, bob } = seed();
    enroll(db, team, ada);
    steerFromWakeOccupancy(db, team, bob, ada, 's1', 1_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lane).toBe('batched'); // still reachable — at cooldown cadence, not instantly
  });

  it('the demoted act respects the batched cooldown (chains run at cooldown cadence)', () => {
    const { db, team, ada, bob } = seed();
    enroll(db, team, ada);
    wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', Date.now() - 5 * 60_000);
    steerFromWakeOccupancy(db, team, bob, ada, 's1', 1_000);
    // Inside the 30-minute cooldown a human steer would wake immediately; the machine steer waits.
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('a human-sent steer still wakes immediately (nothing over-demotes)', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    attach(db, nick.id, 'cli', 'conn-nick'); // provenance null — a human session
    msg(db, team, nick, ada, 'steer', 's1', 1_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.lane).toBe('immediate');
  });
});

describe('claimWakeLeases — work_order derivation (ADR 191 review loop)', () => {
  it('leases a seat-policy work_order for an unanswered lane_review ask when loops.review + flow:auto', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: {
        species: 'approve',
        tier: 'standard',
        lane_review: {
          lane: lane.id,
          title: lane.title,
          route: 'cross_family',
          grade: 'cross_model',
        },
      },
    });

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      seat: 'Ada',
      act_id: 'ask1',
      derivation: 'work_order',
      lane_id: lane.id,
      tool_policy: 'seat-policy',
      continuity_requirement: 'portable',
      intended_delivery: 'fresh',
    });
    expect(orders[0]!.bounds?.timeout_ms).toBe(WAKE_POLICY_DEFAULTS.work_timeout_ms);
    expect(orders[0]!.composed_line).toContain(lane.id);
    expect(orders[0]!.composed_line).not.toContain(lane.title);
    expect(orders[0]!.composed_line).toContain('team_wake_context');
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
      derivation: 'work_order',
      lane_id: lane.id,
      continuity_requirement: 'portable',
      intended_delivery: 'fresh',
    });
  });

  it('does not derive work_order when loops.review is off (launch default)', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: {
        species: 'approve',
        tier: 'standard',
        lane_review: { lane: lane.id },
      },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('does not derive work_order when the seat is flow:manual', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'manual' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: {
        species: 'approve',
        tier: 'standard',
        lane_review: { lane: lane.id },
      },
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });
});

describe('claimWakeLeases — work_order derivation (ADR 199 dispatch loop)', () => {
  it('handoff with lane_handoff becomes seat-policy work_order when loops.dispatch + flow:auto', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'secret title',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
    });

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      seat: 'Ada',
      act_id: 'h1',
      act: 'handoff',
      derivation: 'work_order',
      lane_id: lane.id,
      tool_policy: 'seat-policy',
    });
    expect(orders[0]!.bounds?.timeout_ms).toBe(WAKE_POLICY_DEFAULTS.work_timeout_ms);
    expect(orders[0]!.composed_line).toContain(lane.id);
    expect(orders[0]!.composed_line).toContain('is yours');
    expect(orders[0]!.composed_line).not.toContain('secret title');
    expect(orders[0]!.composed_line).toContain('team_wake_context');
  });

  it('does not promote handoff to work_order when loops.dispatch is off (reply doorbell remains)', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.derivation).toBe('batched');
    expect(orders[0]!.tool_policy).not.toBe('seat-policy');
    expect(orders[0]).toMatchObject({
      continuity_requirement: 'portable',
      intended_delivery: 'fresh',
    });
  });

  it('does not derive dispatch work_order when the seat is flow:manual', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'manual' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'a change',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.derivation).toBe('batched');
    expect(orders[0]).toMatchObject({
      continuity_requirement: 'portable',
      intended_delivery: 'fresh',
    });
  });

  // ADR 325 prereq: the "last failure on this edge" pick tie-broke on local `rowid`, an ordering
  // that exists only on this machine's file. Today appendAudit's ULIDs land in rowid order, so the
  // two agree — but a replicated log has no shared rowid, and the ULID id is the ordering the
  // schema actually promises. The tie is constructed raw (same ts, ids opposed to insertion
  // order): id-order says the still-true failure was superseded; rowid-order says it stands.
  it("breaks a same-ts tie on the ULID id, not on this file's rowid (ADR 325 prereq)", async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    // The continuation edge: Ada owns a claimed lane and there is no triggering act, so the ONLY
    // candidate is (lane, 'dispatch_continuation') — the injected failures decide everything.
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'tied', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });

    const failRow = (id: string, wakeability: string) =>
      db
        .prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
           VALUES (?, ?, 1000, NULL, 'residency.wake_failed', 'Ada', 'deny', ?, 1000)`,
        )
        .run(
          id,
          team.id,
          JSON.stringify({ lane_id: lane.id, edge: 'dispatch_continuation', wakeability }),
        );
    // Later-by-id row first: the failure that SUPERSEDED the still-true one (not in the closed set).
    failRow('01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'host_asleep');
    // Earlier-by-id row second, so rowid points at it: the stale still-true failure.
    failRow('01AAAAAAAAAAAAAAAAAAAAAAAA', 'not_enrolled');

    // The latest failure by the schema's ordering is not still-true, so the edge leases again.
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ seat: 'Ada', derivation: 'work_order', lane_id: lane.id });
  });

  it('keeps ordinary inbox wakes on the legacy ladder until the portable reply cohort is enabled', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'steer', 'm1', 1_000);

    const [legacy] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, 10_000);
    expect(legacy).not.toHaveProperty('intended_delivery');

    db.prepare('DELETE FROM wake_leases WHERE team_id = ?').run(team.id);
    setPolicy(db, team.id, { residency: { portable_inbox_replies: true } });
    expect(getPolicy(db, team.id).residency.portable_inbox_replies).toBe(true);
    const [portable] = claimWakeLeases(
      db,
      team.id,
      team.slug,
      HOST,
      PRESENCE_TIMEOUT_MS,
      2_000_000,
    );
    expect(portable).toMatchObject({
      continuity_requirement: 'portable',
      intended_delivery: 'fresh',
    });
  });

  it('continuation: owned claimed lane with no act → work_order with null act_id', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, {
      title: 'keep going',
      claim: true,
    });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });

    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      seat: 'Ada',
      derivation: 'work_order',
      lane_id: lane.id,
      tool_policy: 'seat-policy',
    });
    expect(orders[0]!.act_id).toBeUndefined();
    expect(orders[0]!.composed_line).toContain(lane.id);
    expect(orders[0]!.composed_line).not.toContain('keep going');
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
      act: `lane:${lane.id}`,
      derivation: 'work_order',
      lane_id: lane.id,
    });
  });

  it('continuation does not auto-pick unowned open lanes', async () => {
    const { openLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    openLane(db, team.id, team.slug, nick.name, { title: 'unowned work', claim: false });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('continuation skips blocked and awaiting_acceptance lanes', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const blocked = openLane(db, team.id, team.slug, nick.name, {
      title: 'blocked',
      claim: true,
    });
    updateLane(db, team.id, blocked.id, team.slug, {
      owner_seat: ada.name,
      state: 'blocked',
    });
    const awaiting = openLane(db, team.id, team.slug, nick.name, {
      title: 'awaiting',
      claim: true,
    });
    updateLane(db, team.id, awaiting.id, team.slug, {
      owner_seat: ada.name,
      state: 'awaiting_acceptance',
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });
});

describe('claimWakeLeases — resume eligibility (ADR 210 exact-match continuity)', () => {
  // The daemon may only MARK a wake resume_eligible. That mark is permission to consider a local
  // resume, never an instruction to perform one — the host still has to prove an exact match.
  const REPLY_TS = 1_000_000;
  const soon = REPLY_TS + 30_000;

  function threadedReply(over: { ts?: number; thread?: string } = {}) {
    const seeded = seed();
    const { db, team, nick, ada } = seeded;
    enroll(db, team, ada);
    setPolicy(db, team.id, {
      residency: { portable_inbox_replies: true, exact_match_resume: true },
    });
    msg(db, team, nick, ada, 'steer', 'm1', over.ts ?? REPLY_TS, {
      thread: over.thread ?? 'T1',
    });
    return seeded;
  }

  it('marks a recent directed threaded reply resume_eligible', () => {
    const { db, team } = threadedReply();
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    expect(order).toMatchObject({ resume_eligible: true, intended_delivery: 'fresh' });
  });

  // The mark alone is unusable: the local registry is keyed by thread, so a host that is told
  // "you may consider a resume" but not WHICH thread has nothing to match against. The thread id
  // travels daemon→host only; the reverse direction (session id, transcript path, workspace) is
  // what ADR 210's privacy invariant forbids, and it stays forbidden.
  it('carries the thread id the host needs to find its local binding, only when eligible', () => {
    const { db, team } = threadedReply();
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    expect(order).toMatchObject({ resume_eligible: true, thread_id: 'T1' });

    // Past the horizon the wake is not eligible — so the thread id is not sent either.
    const late = REPLY_TS + WAKE_POLICY_DEFAULTS.resume_eligible_ms + 1;
    const [stale] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, late);
    expect(stale).not.toHaveProperty('thread_id');
  });

  it('does not mark a reply older than the eligibility horizon', () => {
    const { db, team } = threadedReply();
    const late = REPLY_TS + WAKE_POLICY_DEFAULTS.resume_eligible_ms + 1;
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, late);
    expect(order).not.toHaveProperty('resume_eligible');
  });

  it('does not mark an un-threaded directed reply — there is no join key to prove a match', () => {
    const seeded = seed();
    const { db, team, nick, ada } = seeded;
    enroll(db, team, ada);
    setPolicy(db, team.id, {
      residency: { portable_inbox_replies: true, exact_match_resume: true },
    });
    msg(db, team, nick, ada, 'steer', 'm1', REPLY_TS);
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    // A message with no explicit thread still has a canonical thread of its own id, but it is the
    // FIRST act in it — there is no prior dialogue to resume into.
    expect(order).not.toHaveProperty('resume_eligible');
  });

  it('never marks a handoff, even inside a live thread — the derivation wins', () => {
    const seeded = seed();
    const { db, team, nick, ada } = seeded;
    enroll(db, team, ada);
    setPolicy(db, team.id, {
      residency: { portable_inbox_replies: true, exact_match_resume: true },
    });
    msg(db, team, nick, ada, 'message', 'root', REPLY_TS - 1_000, { thread: 'T1' });
    msg(db, team, nick, ada, 'handoff', 'h1', REPLY_TS, { thread: 'T1' });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    for (const o of orders) expect(o).not.toHaveProperty('resume_eligible');
  });

  it('never marks a work_order wake', async () => {
    const { openLane, updateLane } = await import('./lanes.js');
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true }, residency: { exact_match_resume: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: {
        species: 'approve',
        tier: 'standard',
        lane_review: {
          lane: lane.id,
          title: lane.title,
          route: 'cross_family',
          grade: 'cross_model',
        },
      },
    });
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(order!.derivation).toBe('work_order');
    expect(order).not.toHaveProperty('resume_eligible');
  });

  it('marks nothing while the exact_match_resume switch is off (the launch default)', () => {
    const seeded = seed();
    const { db, team, nick, ada } = seeded;
    enroll(db, team, ada);
    setPolicy(db, team.id, { residency: { portable_inbox_replies: true } });
    expect(getPolicy(db, team.id).residency.exact_match_resume).toBe(false);
    msg(db, team, nick, ada, 'message', 'root', REPLY_TS - 1_000, { thread: 'T1' });
    msg(db, team, nick, ada, 'steer', 'm1', REPLY_TS, { thread: 'T1' });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    for (const o of orders) expect(o).not.toHaveProperty('resume_eligible');
  });

  it('records the eligibility bit in the wake_leased audit row and no local identity', () => {
    const { db, team } = threadedReply();
    claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    const detail = JSON.parse(leased[0]!.detail as string);
    expect(detail).toMatchObject({ resume_eligible: true });
    expect(detail).not.toHaveProperty('session_id');
    expect(detail).not.toHaveProperty('transcript_path');
    expect(detail).not.toHaveProperty('thread_id');
  });
});

describe('wake_leases edge + spawned_at (ADR 262)', () => {
  it('migration adds nullable edge and spawned_at', () => {
    const { db } = seed();
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('wake_leases')")
      .pluck()
      .all() as string[];
    expect(cols).toContain('edge');
    expect(cols).toContain('spawned_at');
  });
});

describe('claimWakeLeases — stamps loop edge (ADR 262)', () => {
  it('review work_order stamps edge=review on the lease and the audit', () => {
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders).toHaveLength(1);
    const row = db
      .prepare('SELECT edge, spawned_at FROM wake_leases WHERE id = ?')
      .get(orders[0]!.lease_id) as { edge: string | null; spawned_at: number | null };
    expect(row.edge).toBe('review');
    expect(row.spawned_at).toBeNull();
    const leased = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_leased');
    expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
      edge: 'review',
      lane_id: lane.id,
    });
  });

  it('dispatch handoff stamps dispatch_handoff; continuation stamps dispatch_continuation', () => {
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const handed = openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
    updateLane(db, team.id, handed.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: handed.id, branch: 'feat/x' } },
    });
    const handoffOrders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const handoffRow = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(handoffOrders[0]!.lease_id) as { edge: string };
    expect(handoffRow.edge).toBe('dispatch_handoff');

    // settle the lease and park the handed lane so it is no longer a handoff or
    // continuation candidate — otherwise Ada's still-claimed handoff lane wins the
    // single per-seat lease and the new continuation never appears.
    db.prepare("UPDATE wake_leases SET status = 'reported' WHERE id = ?").run(
      handoffOrders[0]!.lease_id,
    );
    msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
    updateLane(db, team.id, handed.id, team.slug, { state: 'awaiting_acceptance' });
    const cont = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    const contOrders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const contLease = contOrders.find((o) => o.lane_id === cont.id);
    expect(contLease).toBeTruthy();
    const contRow = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(contLease!.lease_id) as { edge: string };
    expect(contRow.edge).toBe('dispatch_continuation');
  });

  it('inbox wakes leave edge NULL', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada);
    msg(db, team, nick, ada, 'request_help', 'r1', 1_000);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.length).toBeGreaterThan(0);
    const row = db
      .prepare('SELECT edge FROM wake_leases WHERE id = ?')
      .get(orders[0]!.lease_id) as { edge: string | null };
    expect(row.edge).toBeNull();
  });
});

describe('markWakeSpawned (ADR 262)', () => {
  function reviewDue() {
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto' });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    return { db, team };
  }

  it('stamps spawned_at, does not settle, is idempotent, null on unknown', () => {
    const { db, team } = reviewDue();
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const first = markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_000);
    expect(first!.status).toBe('leased');
    expect(first!.spawned_at).toBe(1_700_000_000_000);
    const second = markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_999);
    expect(second!.spawned_at).toBe(1_700_000_000_000); // first stamp wins
    expect(markWakeSpawned(db, team.id, 'nope')).toBeNull();

    settleWakeLease(db, team.id, order!.lease_id);
    const afterSettle = markWakeSpawned(db, team.id, order!.lease_id, 1_800_000_000_000);
    expect(afterSettle!.status).toBe('reported');
    expect(afterSettle!.spawned_at).toBe(1_700_000_000_000); // already set; settle-then-progress is a no-op stamp
  });

  it('after settle with null spawned_at, progress still stamps', () => {
    const { db, team } = reviewDue();
    const [order] = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    settleWakeLease(db, team.id, order!.lease_id);
    const stamped = markWakeSpawned(db, team.id, order!.lease_id, 42);
    expect(stamped!.status).toBe('reported');
    expect(stamped!.spawned_at).toBe(42);
  });
});

describe('claimWakeLeases — spend breaker + still-true (ADR 262)', () => {
  function reviewDue() {
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', attempt_cap: 10, hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'a change', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
    msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
    });
    return { db, team, ada, lane };
  }

  function failEdge(
    db: Database,
    teamId: string,
    detail: Record<string, unknown>,
    ts = Date.now() - WAKE_COOLDOWN_MS - 1,
  ) {
    appendAudit(db, teamId, {
      actor: null,
      action: 'residency.wake_failed',
      target: 'Ada',
      result: 'deny',
      detail,
    });
    db.prepare(
      'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
    ).run(ts);
  }

  /** A reported successful wake on one (lane, edge) — the rows the ADR 306 bounds derive from. */
  function wokeEdge(
    db: Database,
    teamId: string,
    laneId: string,
    edge: string,
    ts = Date.now() - WAKE_COOLDOWN_MS - 1,
  ) {
    appendAudit(db, teamId, {
      actor: null,
      action: 'residency.woke',
      target: 'Ada',
      result: 'allow',
      detail: { act: `lane:${laneId}`, lane_id: laneId, edge },
    });
    db.prepare(
      'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
    ).run(ts);
  }

  /** Move the lane's own clock — the ADR 306 progress signal, without going through a state patch. */
  function laneTouched(db: Database, laneId: string, ts: number) {
    db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(ts, laneId);
  }

  it('skips when last wake_failed wakeability is enrolled_dead_workspace', () => {
    const { db, team, lane } = reviewDue();
    failEdge(db, team.id, {
      act: 'ask1',
      lane_id: lane.id,
      edge: 'review',
      wakeability: 'enrolled_dead_workspace',
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
  });

  it('retries when last failure is lease_expired or enrolled_seat_busy', () => {
    const { db, team, lane } = reviewDue();
    failEdge(db, team.id, {
      act: 'ask1',
      lane_id: lane.id,
      edge: 'review',
      reason: 'lease_expired',
    });
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(1);
  });

  it('trips after 3 wake_failed on the same edge, not after 3 woke, and not across edges', () => {
    const { db, team, lane } = reviewDue();
    for (let i = 0; i < 3; i++) {
      failEdge(db, team.id, {
        act: `ask${i}`,
        lane_id: lane.id,
        edge: 'review',
        reason: 'lease_expired',
      });
    }
    expect(claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(0);
    const exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(JSON.parse(exhausted.at(-1)!.detail as string)).toMatchObject({
      breaker: true,
      edge: 'review',
    });
  });

  /**
   * ADR 306. This test previously passed only because it enrolled with `attempt_cap: 10`.
   * Production runs the ADR 131 default of 3, and at 3 the ADR 262 §4.1 guarantee is FALSE:
   * `attemptsForAct` counts `residency.woke` as well as `wake_failed`, so three SUCCESSFUL
   * continuations exhaust the lane-keyed cap and the edge never derives again. Measured on the
   * live ledger 2026-08-21: lanes `01M040DH9X…` and `01KZ4QH585…`, 3 wokes / 0 failures each,
   * both permanently exhausted. The override configured the defect out of the test that existed
   * to catch it — so the enrollment here is deliberately left at the default.
   *
   * The guarantee is also NARROWED by the ADR 306 progress precondition: three successful
   * continuations still derive, but only if each one moved the lane. A wake that changed nothing
   * does not buy the next one (ADR 247, ADR 250 §2).
   */
  it('three woke on dispatch_continuation still derive at the DEFAULT attempt cap', () => {
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    for (let i = 0; i < 3; i++) {
      const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
      wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
      // the seat woke and did work: the lane moves after the wake it answered
      laneTouched(db, lane.id, wokeTs + 1);
    }
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.lane_id === lane.id)).toBe(true);
  });

  it('a success does not write a terminal exhaustion row for an edge-bearing work order', () => {
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    for (let i = 0; i < 3; i++) {
      const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
      wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
      laneTouched(db, lane.id, wokeTs + 1);
    }
    claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    const exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(exhausted).toHaveLength(0);
  });

  /** ADR 306 §2 — no heartbeat that burns spend while nothing changed (ADR 250 §2). */
  it('continuation does not re-derive when the lane has not moved since the last woke', () => {
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
    laneTouched(db, lane.id, wokeTs - 1_000);
    wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.lane_id === lane.id)).toBe(false);
  });

  it('continuation derives again once the lane moves after the last woke', () => {
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
    wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
    laneTouched(db, lane.id, wokeTs + 1);
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.lane_id === lane.id)).toBe(true);
  });

  /**
   * The ceiling is a recorded judgment (ADR 306 §3), not an implementation detail: the test that
   * exercises it seeds its chain FROM the constant, so it cannot notice the number changing. This
   * pins the number itself — moving it must be a deliberate edit with an ADR behind it.
   */
  it('the continuation ceiling is the number ADR 306 recorded', () => {
    expect(WORK_ORDER_CONTINUATION_SUCCESS_CAP).toBe(8);
  });

  /** ADR 306 §3 — a succeeding chain is bounded too; nick rejected indefinite chaining. */
  it('trips the continuation success cap and records it as a counted event', () => {
    const { db, team, ada } = seed();
    setPolicy(db, team.id, { loops: { dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 20 });
    const lane = openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
    // The chain must sit OUTSIDE the hourly window, or the hourly cap — not the ADR 306 ceiling —
    // is what stops the ninth wake, and the test would pass for the wrong reason.
    for (let i = 0; i < WORK_ORDER_CONTINUATION_SUCCESS_CAP; i++) {
      const wokeTs = Date.now() - 2 * 3_600_000 + i;
      wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
      laneTouched(db, lane.id, wokeTs + 1);
    }
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.lane_id === lane.id)).toBe(false);
    const exhausted = listAudit(db, team.id).filter((r) => r.action === 'residency.wake_exhausted');
    expect(JSON.parse(exhausted.at(-1)!.detail as string)).toMatchObject({
      reason: 'continuation_cap',
      edge: 'dispatch_continuation',
      lane_id: lane.id,
    });
  });

  /**
   * Scope guard for ADR 306 §1: the success-blind counting is restricted to edge-bearing work
   * orders. An inbox wake (edge NULL) must keep today's semantics exactly — a successful wake
   * still retires its act, or a delivered doorbell would ring forever.
   */
  it('inbox wakes still count successes toward the attempt cap', () => {
    const { db, team, nick, ada } = seed();
    enroll(db, team, ada, HOST, { flow: 'auto' });
    msg(db, team, nick, ada, 'request_help', 'rh1', 1_000);
    for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) {
      appendAudit(db, team.id, {
        actor: null,
        action: 'residency.woke',
        target: 'Ada',
        result: 'allow',
        detail: { act: 'rh1' },
      });
      db.prepare(
        'UPDATE audit SET ts = ? WHERE rowid = (SELECT rowid FROM audit ORDER BY rowid DESC LIMIT 1)',
      ).run(Date.now() - WAKE_COOLDOWN_MS - 1);
    }
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.act_id === 'rh1')).toBe(false);
  });

  it('review failures do not trip dispatch_handoff on the same lane', () => {
    const { db, team, nick, ada } = seed();
    setPolicy(db, team.id, { loops: { review: true, dispatch: true } });
    enroll(db, team, ada, HOST, { flow: 'auto', attempt_cap: 10, hourly_cap: 10 });
    const lane = openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
    updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
    for (let i = 0; i < 3; i++) {
      failEdge(db, team.id, {
        lane_id: lane.id,
        edge: 'review',
        reason: 'lease_expired',
      });
    }
    msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
      meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
    });
    const orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    expect(orders.some((o) => o.act_id === 'h1')).toBe(true);
  });
});

/**
 * The wake poll runs on the daemon's request path, in one transaction, every 30s per enrolled seat.
 * Its cost must therefore be a function of what is DUE, never of how long the team has been talking
 * — otherwise the poll grows without bound against an append-only log and starves the event loop for
 * every other request (measured on the revive team: 840ms at idle, 8000+ member lookups per poll,
 * `/health` timing out behind the queue and tripping guardian `daemon_down` false alarms).
 *
 * The deferral fold is where that bound was lost: `deferrals` reads only the seat's OWN `wait` acts,
 * but the scan hydrated every row in the window into a full Envelope — two member lookups each —
 * before throwing all of them away. This pins the property rather than the fix: a seat that has
 * deferred nothing must not pay for the timeline.
 */
describe('claimWakeLeases — cost is bounded by what is due, not by the timeline (burst starvation)', () => {
  /** Counts executions of the per-row member hydration the deferral scan used to drive. */
  function countMemberLookups(db: Database, run: () => void): number {
    let n = 0;
    const orig = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const stmt = orig(sql);
      if (/FROM members WHERE id = \?/.test(sql)) {
        const get = stmt.get.bind(stmt);
        (stmt as any).get = (...args: unknown[]) => {
          n++;
          return get(...args);
        };
      }
      return stmt;
    };
    try {
      run();
    } finally {
      (db as any).prepare = orig;
    }
    return n;
  }

  it('does not hydrate the team timeline for a seat that has deferred nothing', () => {
    const { db, team, nick, ada, bob } = seed();
    enroll(db, team, ada);
    // A long-running team: chatter Ada is a party to, none of it deferred by her.
    for (let i = 0; i < 400; i++) {
      msg(db, team, nick, bob, 'message', `c${i}`, 1_000 + i);
      msg(db, team, bob, null, 'status_update', `s${i}`, 1_400 + i);
    }
    // One genuine reason to wake her.
    msg(db, team, nick, ada, 'message', 'u1', 900_000, {
      meta: { urgent: true, urgent_reason: 'wake me' },
    });

    let orders: unknown[] = [];
    const lookups = countMemberLookups(db, () => {
      orders = claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    });

    expect(orders).toHaveLength(1);
    // The seat, its sender, and the lease bookkeeping — a handful. NOT one per timeline row.
    expect(lookups).toBeLessThan(50);
  });
});
