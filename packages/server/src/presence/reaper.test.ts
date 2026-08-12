import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { appendAudit, listAudit } from '../store/audit.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { attach, release } from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import {
  HOST_SUSPEND_GAP_MS,
  WAKE_LEASE_TTL_MS,
  WAKE_UNREACHABLE_CEILING_MS,
  claimWakeLeases,
  enrollResidency,
} from '../store/residency.js';
import { createTeam } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { startReaper } from './reaper.js';

/**
 * The reaper is a `setInterval` tick, so drive it with fake timers: seed a stale row, advance one
 * `reaperIntervalMs`, and assert the tick's side effects (offline broadcast, request expiry, audit).
 */
describe('startReaper', () => {
  let db: Database;
  let hub: Hub;
  let config: ResolvedConfig;
  let ctx: Ctx;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    db = openDb(':memory:');
    hub = new Hub();
    config = resolveConfig();
    ctx = { db, hub, config, rosterRoots: [] };
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    db.close();
  });

  function seatWithPresence(name: string): { memberId: string; presenceId: string } {
    const team = createTeam(db, { slug: 'dawn' });
    const { row } = addMember(db, team, { name, kind: 'agent' });
    const presence = attach(db, row.id, 'cli', 'conn-1');
    return { memberId: row.id, presenceId: presence.id };
  }

  it('reaps a stale live presence and broadcasts the member offline', () => {
    const { presenceId } = seatWithPresence('Ada');
    // Backdate the row so it is already stale, then let one tick sweep it.
    db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(
      Date.now() - config.presenceTimeoutMs - 1,
      presenceId,
    );
    const broadcast = vi.spyOn(hub, 'broadcastTeam');

    stop = startReaper(ctx);
    vi.advanceTimersByTime(config.reaperIntervalMs);

    expect(broadcast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'presence', member: 'Ada', status: 'offline' }),
    );
  });

  it('does not broadcast offline when only a grace-held row expires', () => {
    const { presenceId } = seatWithPresence('Bo');
    // A released (held) presence expiring is not a state change — the member already went offline.
    release(db, presenceId, config.reclaimGraceMs);
    db.prepare('UPDATE presence SET held_until = ?, last_seen_at = ? WHERE id = ?').run(
      Date.now() - 1,
      Date.now() - config.presenceTimeoutMs - 1,
      presenceId,
    );
    const broadcast = vi.spyOn(hub, 'broadcastTeam');

    stop = startReaper(ctx);
    vi.advanceTimersByTime(config.reaperIntervalMs);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('expires a pending claim request past its deadline and refuses the session', () => {
    const team = createTeam(db, { slug: 'dawn' });
    const req = createRequest(db, team.id, {
      kind: 'claim',
      from_session: 'sess-9',
      target: 'seat:Ada',
    });
    db.prepare('UPDATE requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1, req.id);
    const deliver = vi.spyOn(hub, 'deliverClaimDecision').mockReturnValue(true);

    stop = startReaper(ctx);
    vi.advanceTimersByTime(config.reaperIntervalMs);

    expect(deliver).toHaveBeenCalledWith(
      'sess-9',
      expect.objectContaining({ type: 'refused', code: 'expired_grant' }),
    );
    const audit = listAudit(db, team.id).find((a) => a.action === 'request.expired');
    expect(audit).toBeDefined();
  });

  it('is a no-op tick when nothing is stale, and stop() clears the interval', () => {
    seatWithPresence('Fresh');
    const broadcast = vi.spyOn(hub, 'broadcastTeam');

    stop = startReaper(ctx);
    vi.advanceTimersByTime(config.reaperIntervalMs * 2);
    expect(broadcast).not.toHaveBeenCalled();

    stop();
    stop = undefined;
    // After stopping, further time must not trigger any more work.
    vi.advanceTimersByTime(config.reaperIntervalMs * 5);
    expect(broadcast).not.toHaveBeenCalled();
  });

  /**
   * ADR 236: an expired lease means one of two opposite things — the host tried and failed (burn the
   * attempt budget, or a crash-looping host retries forever) or the host was not there at all (burn
   * nothing, or the act is retired before anyone could answer it). The discriminator is the reaper's
   * own cadence: a 15-second loop that did not fire for a quarter hour was suspended, not late.
   *
   * The suspension is simulated the way macOS causes it — the wall clock jumps while the timer queue
   * does not fire — via `setSystemTime` followed by a single interval.
   */
  describe('a lease that expired while the host was unreachable (ADR 236)', () => {
    const HOST = 'laptop.local';

    /** A real due wake, leased through `claimWakeLeases` — same rows production writes. */
    function leaseDueWake(): { teamId: string; seat: string } {
      const team = createTeam(db, { slug: 'revive' });
      const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;
      const ada = addMember(db, team, { name: 'Ada', kind: 'agent' }).row;
      enrollResidency(db, team.id, {
        member_id: ada.id,
        harness: 'claude-code',
        host: HOST,
        grant_id: 'g1',
        authorized_by: 'nick',
      });
      insertMessage(
        db,
        team.id,
        nick.id,
        ada.id,
        makeEnvelope({
          id: 'u1',
          team: team.slug,
          from: nick.name,
          to: { kind: 'member', name: ada.name },
          act: 'message',
          body: 'x',
          thread: null,
          meta: { urgent: true, urgent_reason: 'wake me' },
          ts: Date.now(),
        }),
      );
      const orders = claimWakeLeases(db, team.id, team.slug, HOST, config.presenceTimeoutMs);
      expect(orders).toHaveLength(1);
      return { teamId: team.id, seat: ada.name };
    }

    const rows = (teamId: string, action: string) =>
      listAudit(db, teamId).filter((a) => a.action === action);
    const detailOf = (row: { detail: unknown }) =>
      JSON.parse(row.detail as string) as Record<string, unknown>;

    /** Sleep the host: the clock jumps, the timer queue does not fire, then one tick catches up —
     *  so the tick that follows observes exactly `gapMs` since the previous one. */
    function suspendThenTick(gapMs: number) {
      vi.setSystemTime(Date.now() + gapMs - config.reaperIntervalMs);
      vi.advanceTimersByTime(config.reaperIntervalMs);
    }

    it('burns the attempt budget when the loop ran on schedule (a host-reported failure)', () => {
      const { teamId } = leaseDueWake();
      stop = startReaper(ctx);
      // Ticks fire every interval throughout: the daemon was demonstrably alive the whole time.
      vi.advanceTimersByTime(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

      expect(rows(teamId, 'residency.wake_failed')).toHaveLength(1);
      expect(detailOf(rows(teamId, 'residency.wake_failed')[0]!).reason).toBe('lease_expired');
      expect(rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
    });

    // ADR 252: `residency.wake_cost` is written only when a host REPORTS, so a wake that spawned a
    // session and then died on its lease is paid for and invisible. The session's own attested
    // token is the evidence — the expiry row carries the fact, and deliberately no dollar figure:
    // no cost source exists on this path, and a made-up number is worse than an honest gap.
    it('stamps session_captured on an expired lease that a session attested (paid, unpriced)', () => {
      const { teamId } = leaseDueWake();
      const leaseId = db
        .prepare<[string], { id: string }>('SELECT id FROM wake_leases WHERE team_id = ?')
        .get(teamId)!.id;
      appendAudit(db, teamId, {
        actor: null,
        action: 'residency.session_captured',
        target: 'Ada',
        result: 'allow',
        detail: { harness: 'claude-code', enrolled: true, wake_lease: leaseId },
      });

      stop = startReaper(ctx);
      vi.advanceTimersByTime(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

      const failed = detailOf(rows(teamId, 'residency.wake_failed')[0]!);
      expect(failed.reason).toBe('lease_expired');
      expect(failed.session_captured).toBe(true);
      expect(failed).not.toHaveProperty('cost_usd');
    });

    it('says nothing when no session claimed the lease — silence, not a denial', () => {
      const { teamId } = leaseDueWake();
      // A session captured under a DIFFERENT lease must not be credited to this one: the join is
      // by identity, never by "a session happened around then" (the ADR 238→241 inference).
      appendAudit(db, teamId, {
        actor: null,
        action: 'residency.session_captured',
        target: 'Ada',
        result: 'allow',
        detail: { harness: 'claude-code', enrolled: true, wake_lease: 'some-other-lease' },
      });

      stop = startReaper(ctx);
      vi.advanceTimersByTime(WAKE_LEASE_TTL_MS + config.reaperIntervalMs);

      expect(detailOf(rows(teamId, 'residency.wake_failed')[0]!)).not.toHaveProperty(
        'session_captured',
      );
    });

    it('defers instead — and records the suspension — when the loop did not run', () => {
      const { teamId, seat } = leaseDueWake();
      stop = startReaper(ctx);
      suspendThenTick(15 * 60_000);

      expect(rows(teamId, 'residency.wake_failed')).toHaveLength(0);
      const deferred = rows(teamId, 'residency.wake_deferred');
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.target).toBe(seat);
      expect(detailOf(deferred[0]!).reason).toBe('host_unreachable');

      const suspended = rows(teamId, 'residency.host_suspended');
      expect(suspended).toHaveLength(1);
      expect(detailOf(suspended[0]!).gap_ms).toBeGreaterThanOrEqual(15 * 60_000);
    });

    it('does not read a minute of scheduler lateness as absence (the threshold has headroom)', () => {
      // Pinned in absolute time, not against the constant: a loaded machine can starve a 15-second
      // loop for a minute, and calling that "the host was gone" would defer every real failure.
      const { teamId } = leaseDueWake();
      stop = startReaper(ctx);
      suspendThenTick(60_000);

      expect(rows(teamId, 'residency.host_suspended')).toHaveLength(0);
    });

    it('treats a gap under the suspend threshold as ordinary lateness, not absence', () => {
      const { teamId } = leaseDueWake();
      stop = startReaper(ctx);
      suspendThenTick(HOST_SUSPEND_GAP_MS - 1_000);
      // ...then keep ticking on schedule until the lease is genuinely past its TTL.
      vi.advanceTimersByTime(WAKE_LEASE_TTL_MS);

      expect(rows(teamId, 'residency.host_suspended')).toHaveLength(0);
      expect(rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
      expect(rows(teamId, 'residency.wake_failed')).toHaveLength(1);
    });

    it('a deferred expiry burns no attempt budget: the act re-leases once the snooze lifts', () => {
      const { teamId } = leaseDueWake();
      const team = { id: teamId };
      stop = startReaper(ctx);
      suspendThenTick(15 * 60_000);

      // Lift the deferral snooze; nothing else about the act has changed.
      db.prepare("UPDATE audit SET ts = ? WHERE action = 'residency.wake_deferred'").run(
        Date.now() - 10 * 60_000,
      );
      const again = claimWakeLeases(db, team.id, 'revive', HOST, config.presenceTimeoutMs);
      expect(again).toHaveLength(1);
      expect(again[0]!.act_id).toBe('u1');
    });

    it('stops deferring once the host has been awake past the ceiling (defer is bounded)', () => {
      const { teamId } = leaseDueWake();
      // Backdate the act's first lease so the host has since been awake well past the ceiling —
      // the sleep below is subtracted from that span, so the margin has to exceed it.
      db.prepare("UPDATE audit SET ts = ? WHERE action = 'residency.wake_leased'").run(
        Date.now() - (WAKE_UNREACHABLE_CEILING_MS + 30 * 60_000),
      );
      stop = startReaper(ctx);
      suspendThenTick(15 * 60_000);

      expect(rows(teamId, 'residency.wake_deferred')).toHaveLength(0);
      expect(rows(teamId, 'residency.wake_failed')).toHaveLength(1);
    });

    it('counts only awake time toward the ceiling: a long sleep does not spend it', () => {
      const { teamId } = leaseDueWake();
      const now = Date.now();
      // The act's first lease is older than the ceiling in WALL-CLOCK time — but the host spent
      // nearly all of that span asleep, in one recorded suspension. Awake time is what rules.
      db.prepare("UPDATE audit SET ts = ? WHERE action = 'residency.wake_leased'").run(
        now - (WAKE_UNREACHABLE_CEILING_MS + 60 * 60_000),
      );
      appendAudit(db, teamId, {
        actor: null,
        action: 'residency.host_suspended',
        target: 'daemon',
        result: 'allow',
        detail: {
          gap_ms: WAKE_UNREACHABLE_CEILING_MS,
          from: now - (WAKE_UNREACHABLE_CEILING_MS + 30 * 60_000),
          to: now - 30 * 60_000,
        },
      });
      stop = startReaper(ctx);
      suspendThenTick(15 * 60_000);

      expect(rows(teamId, 'residency.wake_failed')).toHaveLength(0);
      expect(rows(teamId, 'residency.wake_deferred')).toHaveLength(1);
    });
  });
});
