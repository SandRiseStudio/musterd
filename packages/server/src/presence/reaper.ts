import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { getMemberById, reapStaleObservers } from '../store/members.js';
import { hasLivePresence, reapStale } from '../store/presence.js';
import { expireRequests } from '../store/requests.js';
import type { RequestRow } from '../store/requests.js';
import { expireWakeLeases } from '../store/residency.js';

/** Periodically remove stale presence rows and emit offline events for members who lost all presence. */
export function startReaper(ctx: Ctx): () => void {
  const tick = () => {
    const now = Date.now();

    // P3.2: expire claim requests past their deadline (ADR 077 spec-gap 3). Fetch pending+expired
    // rows BEFORE updating so we have from_session connIds to push refused frames.
    const expiredRows = ctx.db
      .prepare<
        [number],
        RequestRow
      >("SELECT * FROM requests WHERE status = 'pending' AND expires_at < ?")
      .all(now);
    if (expiredRows.length > 0) {
      expireRequests(ctx.db, now);
      for (const row of expiredRows) {
        ctx.hub.deliverClaimDecision(row.from_session, {
          type: 'refused',
          code: 'expired_grant',
          message: 'your claim request expired — please re-claim',
          claimable: [],
          hint: 'musterd claim <seat> --key <mskey_...>',
        });
        appendAudit(ctx.db, row.team_id, {
          actor: null,
          action: 'request.expired',
          target: row.target,
          result: 'deny',
          detail: { request_id: row.id },
        });
      }
      log.info({ msg: 'reap_requests_expired', count: expiredRows.length });
    }

    // ADR 131: expire wake leases the host never reported (a crash mid-spawn, a hung headless
    // harness past the watchdog). Each expiry writes `residency.wake_failed` so the attempt still
    // consumes rate budget — a host that dies mid-spawn can never retry forever — and the wake
    // re-becomes due on the next poll, bounded by the derived cooldown/caps.
    const expiredLeases = expireWakeLeases(ctx.db, now);
    for (const lease of expiredLeases) {
      const seat = getMemberById(ctx.db, lease.member_id);
      appendAudit(ctx.db, lease.team_id, {
        actor: null,
        action: 'residency.wake_failed',
        target: seat?.name ?? '?',
        result: 'deny',
        detail: {
          act: lease.act_id,
          lease_id: lease.id,
          lane: lease.lane,
          reason: 'lease_expired',
        },
      });
    }
    if (expiredLeases.length > 0) {
      log.info({ msg: 'reap_wake_leases_expired', count: expiredLeases.length });
    }

    // Reap idle observer seats (ADR 064) so the auto-provisioned `web-xxxx` seats don't accumulate.
    const reapedObservers = reapStaleObservers(
      ctx.db,
      now - ctx.config.observerTtlMs,
      now - ctx.config.presenceTimeoutMs,
    );
    if (reapedObservers.length > 0) {
      log.info({ msg: 'reap_observers', count: reapedObservers.length });
    }

    const removed = reapStale(ctx.db, ctx.config.presenceTimeoutMs);
    if (removed.length === 0) return;
    const seen = new Set<string>();
    for (const row of removed) {
      if (seen.has(row.member_id)) continue;
      seen.add(row.member_id);
      // A pure grace-hold expiring is not a state change: the member already went offline when its
      // connection dropped. Only a stale *live* row (a zombie that never released) reverts to offline.
      if (row.held_until !== null) continue;
      if (hasLivePresence(ctx.db, row.member_id, ctx.config.presenceTimeoutMs)) continue;
      const member = getMemberById(ctx.db, row.member_id);
      if (!member) continue;
      ctx.hub.broadcastTeam(member.team_id, {
        type: 'presence',
        member: member.name,
        status: 'offline',
      });
      log.info({ msg: 'reap_offline', member: member.name });
    }
  };
  const handle = setInterval(tick, ctx.config.reaperIntervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
