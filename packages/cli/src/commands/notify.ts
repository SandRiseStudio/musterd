import { z } from 'zod';
import type { Parsed } from '../args.js';
import { osNotify, type NotifyItem } from '../notify/os.js';
import { pollOnce, type NotifyDeps } from '../notify/select.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `--interval` is seconds (human-facing); clamped to a sane floor so a typo can't hammer the daemon,
 * and a ceiling so it stays a notifier, not a forgotten cron. Parsed through zod (hard rule #4).
 */
const NotifyOptionsSchema = z.object({
  intervalMs: z.number().int().min(2_000).max(3_600_000).default(10_000),
  once: z.boolean().default(false),
});

function parseOptions(
  flags: Record<string, string | boolean>,
): z.infer<typeof NotifyOptionsSchema> {
  const raw = flags['interval'];
  const seconds = typeof raw === 'string' ? Number(raw) : undefined;
  return NotifyOptionsSchema.parse({
    intervalMs:
      seconds != null && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
    once: flags['once'] === true,
  });
}

/**
 * `musterd notify` — the localhost notification down-payment (ADR 035). A headless, client-side
 * notifier the human leaves running: it polls the durable inbox cursor and fires an OS notification
 * for a directed act (`request_help` / `handoff`/`accept`/`decline`/@mention to them) that lands
 * while they aren't watching. Closes the (B′) "away with nothing open" hole ADR 024 named. The
 * notify sink is injectable so the loop is testable without spawning the OS notifier.
 */
export async function notifyCommand(
  parsed: Parsed,
  deps: { notify?: (n: NotifyItem) => void } = {},
): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);
  const opts = parseOptions(parsed.flags);
  const seen = new Set<string>();

  const notifyDeps: NotifyDeps = {
    me: identity.name,
    inbox: async () => (await http.inbox(team, { unread: true })).messages,
    // Reachable in-stream = a live watch/app presence (roster `presence !== 'offline'`). When the
    // human is watching, the bell/banner already reached them (ADR 024); `notify` owns only the
    // not-watching case (ADR 035 §3). No availability state is invented.
    isReachable: async () => {
      const roster = await http.roster(team).catch(() => ({ members: [] }));
      const me = roster.members.find((m) => m.name === identity.name);
      return me != null && me.presence !== 'offline';
    },
    notify: deps.notify ?? osNotify,
  };

  if (opts.once) {
    await pollOnce(notifyDeps, seen).catch(() => undefined);
    return 0;
  }

  process.stdout.write(`${theme.accent('notify')} — ${team}  ${theme.ok('◉ notifying')}\n`);
  process.stdout.write(
    theme.meta(`watching for directed acts while you're away — Ctrl-C to stop`) + '\n',
  );
  return new Promise<number>((resolveP) => {
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      // Best-effort: a transient inbox/roster read failure must not kill the resident loop.
      await pollOnce(notifyDeps, seen).catch(() => undefined);
      timer = setTimeout(tick, opts.intervalMs);
      timer.unref?.();
    };
    void tick();
    process.on('SIGINT', () => {
      if (timer) clearTimeout(timer);
      process.stdout.write('\n');
      resolveP(0);
    });
  });
}
