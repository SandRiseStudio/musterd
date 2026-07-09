import { platform as osPlatform } from 'node:os';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { serviceSupported } from '../service/launchd.js';
import { status } from '../service/manage.js';
import { resolveCtx } from './service.js';

/**
 * `musterd reload` — tell the running service-managed daemon to re-resolve its roster roots and
 * reconcile (ADR 058), by sending it SIGHUP. The convenience wrapper around the signal the daemon
 * already handles; use it after `team export` so a newly file-backed team is picked up without a full
 * restart. For a foreground `musterd serve`, signal it directly (`kill -HUP <pid>`).
 */
export async function reloadCommand(parsed: Parsed): Promise<number> {
  if (!serviceSupported(osPlatform())) {
    throw new CliError(
      'musterd reload drives a launchd service (macOS) — for a foreground `musterd serve`, send SIGHUP directly: kill -HUP <pid>',
      2,
    );
  }
  const st = status(resolveCtx([]));
  if (!st.loaded || !st.pid) {
    throw new CliError(
      'no running musterd service found — start it with `musterd service start`, or SIGHUP a foreground `musterd serve` directly',
      1,
    );
  }
  try {
    process.kill(st.pid, 'SIGHUP');
  } catch (e) {
    throw new CliError(`couldn't signal the daemon (pid ${st.pid}): ${(e as Error).message}`, 1);
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ok: true, pid: st.pid }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`reloaded the musterd daemon (SIGHUP pid ${st.pid})`, { next: 'musterd status' }) +
      '\n',
  );
  process.stdout.write(theme.meta('re-resolved roster roots and reconciled') + '\n');
  return 0;
}
