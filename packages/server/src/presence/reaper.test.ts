import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openDb } from '../db/open.js';
import { attach, release } from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import { addMember } from '../store/members.js';
import { listAudit } from '../store/audit.js';
import { createTeam } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { startReaper } from './reaper.js';
import type { Database } from 'better-sqlite3';

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
});
