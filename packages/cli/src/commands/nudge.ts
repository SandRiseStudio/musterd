import type { Parsed } from '../args.js';
import { renderReachabilityNudge, renderWaitingActs } from '../render/rows.js';
import { pendingActionSummary, resolveRead } from './helpers.js';

/**
 * `musterd inbox --waiting` (ADR 053; `musterd nudge` until 2026-09-03, kept as a hidden alias for one
 * release) — print the directed acts waiting for this folder's bound seat, the read-only "what's
 * waiting for me" view a Claude Code `Notification` hook runs at the approval-prompt moment. It moved
 * under `inbox` because "nudge" had come to name six things in two directions — this is a PULL (the
 * seat reads its own inbox), while ADR 167's delivery nudge is a PUSH into a teammate's session — and
 * a reader who had just seen `delivery_hint` expected `musterd nudge` to poke someone else
 * (docs/wiki/command-and-tool-surface-map.md). When a single-threaded agent loop is parked on a permission prompt, its loop is frozen, so
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
export async function waitingCommand(parsed: Parsed): Promise<number> {
  return nudgeCommand(parsed);
}

/** The pre-2026-09-03 name. Dispatched by `musterd nudge` only; not in the help catalog. */
export async function nudgeCommand(parsed: Parsed): Promise<number> {
  if (process.env['MUSTERD_NO_NUDGE'] === '1') return 0;
  try {
    // Hook one-shot (Notification hook): never reclaim the seat — see ResolveReadOptions.
    const { http, team, identity, explicit } = resolveRead(parsed.flags, {
      reclaimAgentLease: false,
    });
    // Only an explicit actor (a bound seat / env / `--as`) — never an ambient global-config read
    // (ADR 036) — has an inbox to surface.
    if (!explicit || !identity) return 0;
    const pending = await pendingActionSummary(http, team, identity.name);
    // Silent when nothing waits: this rides an approval-prompt Notification hook, so a "nothing here"
    // line would be noise on every parked prompt. Absence of output IS the empty state here.
    if (!pending) return 0;
    const line = renderReachabilityNudge(pending.count, pending.since, identity.name);
    if (!line) return 0;
    // The acts themselves, not only the count: the human at the prompt can act on a line that
    // names who asked for what; a bare count pointed at an inbox it then had to go and read.
    process.stdout.write([line, ...renderWaitingActs(pending.waiting)].join('\n') + '\n');
  } catch {
    // Best-effort: a blocked approval prompt must never be disturbed by a failing nudge.
  }
  return 0;
}
