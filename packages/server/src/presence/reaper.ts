import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { getMemberById } from '../store/members.js';
import { hasLivePresence, reapStale } from '../store/presence.js';

/** Periodically remove stale presence rows and emit offline events for members who lost all presence. */
export function startReaper(ctx: Ctx): () => void {
  const tick = () => {
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
