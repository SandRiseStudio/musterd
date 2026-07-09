import type { Parsed } from '../args.js';
import { renderReachabilityNudge } from '../render/rows.js';
import { pendingActionSummary, resolveRead } from './helpers.js';

/**
 * `musterd nudge` (ADR 053) — print the directed acts waiting for this folder's bound seat, the
 * read-only "what's waiting for me" line a Claude Code `Notification` hook runs at the approval-prompt
 * moment. When a single-threaded agent loop is parked on a permission prompt, its loop is frozen, so
 * ADR 046's per-command nudge can't fire and a teammate's `request_help` sits unread until the human
 * hand-relays it. The hook fires *exactly* when the agent parks for input, so the dead-wait moment
 * becomes the delivery moment — the message surfaces in the terminal the human is already staring at.
 *
 * Read-only and best-effort by construction: it never advances the read cursor (self-clearing only
 * once the agent actually reads its inbox), and any failure is swallowed and exits 0 — the hook must
 * never block or fail the approval it rides on. Honours `MUSTERD_NO_NUDGE=1`. As a side effect the
 * authenticated inbox read keeps the seat present (ambient presence, ADR 057), so a blocked agent
 * shows recently-active rather than silently aging to offline.
 */
export async function nudgeCommand(parsed: Parsed): Promise<number> {
  if (process.env['MUSTERD_NO_NUDGE'] === '1') return 0;
  try {
    const { http, team, identity, explicit } = resolveRead(parsed.flags);
    // Only an explicit actor (a bound seat / env / `--as`) — never an ambient global-config read
    // (ADR 036) — has an inbox to surface.
    if (!explicit || !identity) return 0;
    const pending = await pendingActionSummary(http, team, identity.name);
    // Silent when nothing waits: this rides an approval-prompt Notification hook, so a "nothing here"
    // line would be noise on every parked prompt. Absence of output IS the empty state here.
    if (!pending) return 0;
    const line = renderReachabilityNudge(pending.count, pending.since, identity.name);
    if (line) process.stdout.write(line + '\n');
  } catch {
    // Best-effort: a blocked approval prompt must never be disturbed by a failing nudge.
  }
  return 0;
}
