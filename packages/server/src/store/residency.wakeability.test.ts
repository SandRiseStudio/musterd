import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember } from './members.js';
import {
  enrollResidency,
  HOST_STALE_MS,
  listHostSeen,
  recordHostSeen,
  seatWakeabilityFacts,
} from './residency.js';
import { teamFamilyPosture } from './review.js';
import { createTeam } from './teams.js';

/**
 * Wakeability the roster can stand behind (ADR 357, lane 01M1J1KC6H).
 *
 * Until 2026-09-02 the roster's `wakeable` was `residency.has(member)` — enrolment, labelled as
 * reachability — and `wakeabilityFromFacts` (ADR 189) was called with two of its four facts:
 * nothing ever supplied `host_reachable` or `workspace_readable`, so `enrolled_host_stale` and
 * `enrolled_dead_workspace` could appear on a wake REPORT after the wake had already failed and
 * nowhere else. The host has been polling `POST /residency/wake-leases` every 10 s since ADR 131 —
 * a heartbeat the daemon received and never wrote down.
 */

const TIMEOUT = 60_000;

/** A wake-outcome audit row at an explicit `ts` — appendAudit stamps Date.now(), which cannot order two rows a test writes in the same millisecond. */
function wakeRow(
  db: ReturnType<typeof openDb>,
  teamId: string,
  action: 'residency.wake_failed' | 'residency.woke',
  target: string,
  detail: Record<string, unknown>,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO audit (id, team_id, actor, action, target, result, detail, ts, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `aud-${String(ts)}-${action}`,
    teamId,
    action,
    target,
    action === 'residency.woke' ? 'allow' : 'deny',
    JSON.stringify(detail),
    ts,
    ts,
  );
}
const NOW = 1_800_000_000_000;

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  const agent = (name: string) => addMember(db, team, { kind: 'agent', name, role: '' }).row;
  const enrol = (memberId: string, host = 'mac.lan') =>
    enrollResidency(db, team.id, {
      member_id: memberId,
      harness: 'codex',
      host,
      grant_id: null,
      authorized_by: null,
    });
  return { db, team, agent, enrol };
}

describe('recordHostSeen / listHostSeen — the poll IS the heartbeat', () => {
  it('records the newest sighting per (team, host) and reads it back', () => {
    const { db, team } = seed();
    expect(listHostSeen(db, team.id).size).toBe(0);
    recordHostSeen(db, team.id, 'mac.lan', NOW - 5_000);
    recordHostSeen(db, team.id, 'mac.lan', NOW);
    recordHostSeen(db, team.id, 'fly-1', NOW - 90_000);
    expect(listHostSeen(db, team.id)).toEqual(
      new Map([
        ['mac.lan', NOW],
        ['fly-1', NOW - 90_000],
      ]),
    );
  });

  it('never moves a sighting backwards — a late-arriving old poll must not make a host look stale', () => {
    const { db, team } = seed();
    recordHostSeen(db, team.id, 'mac.lan', NOW);
    recordHostSeen(db, team.id, 'mac.lan', NOW - 30_000);
    expect(listHostSeen(db, team.id).get('mac.lan')).toBe(NOW);
  });
});

describe('seatWakeabilityFacts — the facts wakeabilityFromFacts was always waiting for', () => {
  it('an enrolled seat whose host polled inside HOST_STALE_MS is host_reachable', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', NOW - HOST_STALE_MS + 1);
    const facts = seatWakeabilityFacts(db, team.id, NOW).get(bot.id);
    expect(facts).toMatchObject({ enrolled: true, host_reachable: true, workspace_readable: true });
  });

  it('an enrolled seat whose host has not polled for HOST_STALE_MS is NOT host_reachable', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', NOW - HOST_STALE_MS);
    expect(seatWakeabilityFacts(db, team.id, NOW).get(bot.id)?.host_reachable).toBe(false);
  });

  it('an enrolled seat whose host has NEVER polled is UNKNOWN, not stale — absence is not an assertion (ADR 236)', () => {
    // A fresh install, an older host build, or a registry entry nobody has polled for yet must
    // read exactly as they did before host_liveness existed. Only an observed silence — a host that
    // polled and then stopped — is stale. The first mutation of this rule ("never seen ⇒ stale")
    // turned five existing wake-pool tests red, which is the right thing for them to have done.
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    expect(seatWakeabilityFacts(db, team.id, NOW).get(bot.id)?.host_reachable).toBeUndefined();
  });

  it('the last wake report saying enrolled_dead_workspace makes the seat not workspace_readable — until a later woke', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', NOW);
    wakeRow(
      db,
      team.id,
      'residency.wake_failed',
      'gptbot',
      { lease_id: 'L1', wakeability: 'enrolled_dead_workspace', reason: 'workspace gone' },
      NOW - 60_000,
    );
    expect(seatWakeabilityFacts(db, team.id, NOW).get(bot.id)?.workspace_readable).toBe(false);
    wakeRow(db, team.id, 'residency.woke', 'gptbot', { lease_id: 'L2' }, NOW - 30_000);
    expect(seatWakeabilityFacts(db, team.id, NOW).get(bot.id)?.workspace_readable).toBe(true);
  });

  it('a wake_failed for any OTHER reason leaves workspace_readable true — only the still-true set sticks', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', NOW);
    wakeRow(
      db,
      team.id,
      'residency.wake_failed',
      'gptbot',
      { lease_id: 'L1', wakeability: 'wakeable', reason: 'watchdog timeout' },
      NOW - 60_000,
    );
    expect(seatWakeabilityFacts(db, team.id, NOW).get(bot.id)?.workspace_readable).toBe(true);
  });

  it('an unenrolled seat has no entry', () => {
    const { db, team, agent } = seed();
    const bot = agent('ghost');
    expect(seatWakeabilityFacts(db, team.id, NOW).has(bot.id)).toBe(false);
  });
});

describe('teamFamilyPosture — the ADR 191 wake pool now sees host and workspace', () => {
  it('an enrolled idle seat on a stale host is enrolled_host_stale, not wakeable', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', Date.now() - HOST_STALE_MS - 1);
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('enrolled_host_stale');
  });

  it('an enrolled idle seat on a host this daemon has never heard from is still wakeable — unknown never demotes', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('wakeable');
  });

  it('an enrolled idle seat on a live host with a readable workspace is wakeable', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', Date.now());
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe('wakeable');
  });

  it('a dead workspace outranks a live host — the ADR 189 ladder order', () => {
    const { db, team, agent, enrol } = seed();
    const bot = agent('gptbot');
    enrol(bot.id);
    recordHostSeen(db, team.id, 'mac.lan', Date.now());
    wakeRow(
      db,
      team.id,
      'residency.wake_failed',
      'gptbot',
      { lease_id: 'L1', wakeability: 'enrolled_dead_workspace', reason: 'workspace gone' },
      Date.now() - 1_000,
    );
    const p = teamFamilyPosture(db, team.id, TIMEOUT);
    expect(p.wake_pool.find((c) => c.seat === 'gptbot')?.wakeability).toBe(
      'enrolled_dead_workspace',
    );
  });
});
