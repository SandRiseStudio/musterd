import type { Parsed } from '../args.js';
import { isDaemonUnreachable } from '../client.js';
import { renderReachabilityNudge, renderWaitingActs } from '../render/rows.js';
import { theme } from '../render/theme.js';
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
      claimSeatPerRequest: false,
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
  } catch (err) {
    // Best-effort: a blocked approval prompt must never be disturbed by a failing nudge — with one
    // exception, and only for the one caller who can act on it.
    //
    // The silence above means "nothing is waiting". When the daemon is unreachable this command
    // produced the SAME silence, so a down daemon and an empty queue were one picture on the
    // surface whose entire job is to report what is owed. `musterd status`, on the same seat and
    // the same dead port, said so plainly; --waiting and its `nudge` alias said nothing and exited
    // 0 (measured 2026-09-14, lane 01M2H0H2MT).
    //
    // The fix is not to make the probe loud. The hooks run this at the approval-prompt moment,
    // where a line on every failure is worse than no line at all — and they run it with stdout
    // captured and no distinguishing flag to key off (`musterd inbox --waiting 2>/dev/null`,
    // claude-code and grok alike), so the command cannot be told who invoked it by its arguments.
    // A TTY can: a human typing this has a terminal, a hook does not. Same idiom the bell already
    // uses two files over (`inbox.ts`, `process.stdout.isTTY === true`).
    //
    // So: the human at the terminal learns the question could not be asked; every hook stays
    // exactly as silent as before; and every OTHER failure stays silent for everyone, because a
    // refused credential or a 500 does not make this command's silence a lie about the queue.
    if (isDaemonUnreachable(err) && process.stdout.isTTY === true) {
      // `⚠`, not the `✗` bin.ts gives a fatal: the command still exits 0 and still rides hooks —
      // this is an advisory about the ANSWER, not a failed invocation. The second line is the
      // whole point of the change, so it says the distinction outright rather than implying it.
      process.stdout.write(
        `${theme.warn('⚠')} ${err instanceof Error ? err.message : String(err)}\n` +
          `  ${theme.meta('couldn\'t ask — this is not "nothing is waiting"')}\n`,
      );
    }
  }
  return 0;
}
