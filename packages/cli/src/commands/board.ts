import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { TOKEN_PREFIXES } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd board` (ADR 170) — open the work board signed in as yourself.
 *
 * The friction this removes is not typing: it is that the old flow made a human find, copy, and
 * paste a permanent credential by hand. The CLI already holds that credential, so it stages it with
 * the daemon and carries only a **nonce** to the browser — a handle to a one-time relay, dead after
 * one read or sixty seconds. The nonce rides the URL fragment (never sent to a server, never in an
 * access log), and the URL this command *prints* has no fragment at all, so terminal scrollback
 * stays clean even though the browser got a live link.
 */

/**
 * The two surfaces a human can be signed into (ADR 222). The board is a page you must decide to
 * visit; the office is the one a human leaves open. The record says which of those gets used: the
 * ADR 170 handoff was redeemed once, on release day, and never again.
 */
export type SigninSurface = 'board' | 'live';

/** The plain surface URL — safe to print, carries nothing. */
export function surfaceUrl(server: string, team: string, surface: SigninSurface): string {
  return `${server.replace(/\/$/, '')}/${surface}?team=${encodeURIComponent(team)}`;
}

/** The plain board URL. Kept as its own name because the board's call sites read better for it. */
export function boardUrl(server: string, team: string): string {
  return surfaceUrl(server, team, 'board');
}

/** The signing-in URL: the same surface, plus a one-shot nonce in the fragment. */
export function signinUrl(
  server: string,
  team: string,
  nonce: string,
  surface: SigninSurface = 'board',
): string {
  return `${surfaceUrl(server, team, surface)}#s=${encodeURIComponent(nonce)}`;
}

/**
 * The platform's "open this URL" invocation, argv-shaped so it is testable without spawning
 * anything (the `buildNotifyCommand` pattern). `null` on a platform we have no opener for — the
 * caller prints the link instead of failing.
 */
export function buildOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  // `start` is a cmd builtin, and its first quoted argument is the window title — omitting it makes
  // cmd swallow the URL as the title and open nothing.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return null;
}

/** `musterd board` — ADR 170's original surface. */
export async function boardCommand(parsed: Parsed): Promise<number> {
  return signinCommand(parsed, 'board');
}

/**
 * The shared body of `musterd board` and `musterd live` (ADR 222). One mechanism, two destinations:
 * the surface only changes where the browser lands and what the messages call it. Everything that
 * matters — a nonce rather than a credential, the fragment, the machine-local redemption, the
 * fragment-free URL in scrollback — is identical, because it is the same one-shot relay.
 */
export async function signinCommand(parsed: Parsed, surface: SigninSurface): Promise<number> {
  const { team, server, http, identity } = resolveRead(parsed.flags);
  const place = surface === 'live' ? 'the office' : 'the board';

  if (!identity) {
    throw new CliError(
      `no identity for team "${team}" in this folder — sign in as yourself first: musterd join ${team} --as <you> --key <mscr_…>`,
      2,
    );
  }
  // Only a human credential can sign a human in. An agent seat authenticates with the team agent
  // key, which is a harness fact, not a person — and both surfaces gate their controls on being a
  // real rostered member, so handing an agent key to a browser would buy nothing anyway.
  if (!identity.key.startsWith(TOKEN_PREFIXES.credential)) {
    throw new CliError(
      `${identity.name} authenticates as an agent — ${place} signs in humans. Run this where your ` +
        `own seat is bound, or name it: musterd ${surface} --as <your seat>`,
      2,
    );
  }

  const { nonce, expires_in_ms } = await http.stageSigninHandoff(team, {
    member: identity.name,
    credential: identity.key,
  });
  const url = signinUrl(server, team, nonce, surface);
  const seconds = Math.round(expires_in_ms / 1000);

  if (parsed.flags['print']) {
    // The one place a live link reaches the terminal. Say what it is, so it is never mistaken for a
    // shareable board link: it signs in as you, and only on this machine.
    process.stdout.write(`${url}\n`);
    process.stdout.write(
      theme.meta(
        `  single-use, expires in ${seconds}s, and only redeemable on this machine — it signs in as ${identity.name}\n`,
      ),
    );
    return 0;
  }

  if (parsed.flags['no-open']) {
    process.stdout.write(
      `${theme.meta('staged')} — sign-in link ready for ${seconds}s (use --print to see it)\n`,
    );
    return 0;
  }

  const command = buildOpenCommand(osPlatform(), url);
  if (!command) {
    // No opener on this platform: fall back to the link, with the same warning --print carries.
    process.stdout.write(`${url}\n`);
    process.stdout.write(
      theme.meta(`  single-use, expires in ${seconds}s, only on this machine\n`),
    );
    return 0;
  }
  execFile(command.cmd, command.args, () => {
    // Best-effort, like the OS notifier: a browser that refuses to launch must not fail the command
    // — the board URL is already printed, and the human can finish the job by hand.
  });
  process.stdout.write(
    `${theme.accent(`opening ${place}`)} as ${theme.accent(identity.name)} — ${surfaceUrl(server, team, surface)}\n`,
  );
  return 0;
}
