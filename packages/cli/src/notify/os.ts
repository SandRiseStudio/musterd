import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/** A single OS notification: a short title and a body line. */
export interface NotifyItem {
  /**
   * Envelope id this notification stands for.
   *
   * De-dupes only on the INBOX path, where {@link pollOnce} holds a `seen` set keyed on it (ADR 035).
   * Nothing here reads it: `buildNotifyCommand` never passes it to `osascript` or `notify-send`, and
   * neither platform notifier de-dupes on its own. A caller outside `pollOnce` that supplies a
   * constant id therefore gets NO suppression — which is how the auto-refresh failure path came to
   * fire 16 identical alarms in 3h12m while looking, in source, as though it were de-duped
   * (lane 01M2RRQJDA, 2026-08-19). Such callers must debounce for themselves; see
   * `blockedFailureNotice` in commands/service.ts for the shape.
   */
  id: string;
  title: string;
  body: string;
}

/**
 * The platform notifier invocation for `n`, or `null` on an unsupported platform. Pure, so the
 * argv-building (and its injection-safety) is testable without spawning a process (ADR 035 §1).
 *
 * macOS: the dynamic strings are passed to AppleScript as `on run argv` arguments, never
 * interpolated into the script source — a teammate's message body cannot inject AppleScript. Linux:
 * `notify-send` takes title/body as separate argv, so there is nothing to escape.
 */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  n: NotifyItem,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') {
    const script = [
      'on run argv',
      'display notification (item 1 of argv) with title (item 2 of argv)',
      'end run',
    ];
    const eArgs = script.flatMap((line) => ['-e', line]);
    return { cmd: 'osascript', args: [...eArgs, n.body || `(${n.title})`, n.title] };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: [n.title, n.body] };
  }
  return null;
}

/**
 * Fire an OS notification, best-effort. Shells out to the platform notifier (`osascript` /
 * `notify-send`) — no runtime dependency (ADR 035 / hard rule #6). All failures (missing binary,
 * unsupported platform) are swallowed: the ADR 024 comeback summary still serves that human, so a
 * notifier that can't fire must never crash the loop or surface an error.
 */
export function osNotify(n: NotifyItem): void {
  const command = buildNotifyCommand(osPlatform(), n);
  if (!command) return;
  execFile(command.cmd, command.args, () => {
    // best-effort: ignore spawn/exec errors (binary absent, etc.)
  });
}
