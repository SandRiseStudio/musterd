import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { sweepExpiredRequests } from '../store/claims.js';
import { getMemberById, reapStaleObservers } from '../store/members.js';
import { hasLivePresence, reapStale } from '../store/presence.js';

/** Periodically remove stale presence rows and emit offline events for members who lost all presence. */
export function startReaper(ctx: Ctx): () => void {
  const tick = () => {
    // Reap idle observer seats (ADR 064) so the auto-provisioned `web-xxxx` seats don't accumulate.
    const now = Date.now();
    const reapedObservers = reapStaleObservers(
      ctx.db,
      now - ctx.config.observerTtlMs,
      now - ctx.config.presenceTimeoutMs,
    );
    if (reapedObservers.length > 0) {
      log.info({ msg: 'reap_observers', count: reapedObservers.length });
    }

    // P3.2 (ADR 077): sweep pending claim requests that have passed their 1h expiry window.
    // Push `refused {expired_grant}` to any still-open waiting WS connections before releasing.
    const expiredReqs = sweepExpiredRequests(ctx.db);
    for (const req of expiredReqs) {
      appendAudit(ctx.db, req.team_id, {
        actor: null,
        action: 'request.expired',
        target: req.target_seat,
        result: 'deny',
        detail: { request_id: req.id },
      });
      ctx.hub.deliverClaimDecision(req.from_conn_id, {
        type: 'refused',
        code: 'expired_grant',
        message: 'your claim request expired — no admin responded within the time window',
        claimable: [],
        hint: 'reconnect and try again; contact an admin to pre-issue a grant for faster access',
      });
    }
    if (expiredReqs.length > 0) {
      log.info({ msg: 'reap_claim_requests', expired: expiredReqs.length });
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
