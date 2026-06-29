import { resolveWorkspace } from '@musterd/mcp';
import type { Envelope, MemberKind } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { watch } from '../client.js';
import { wsBase } from '../config.js';
import { isActionNeeded, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { kindLookup, resolve } from './helpers.js';

/** Block-until-message exit code on timeout — mirrors coreutils `timeout(1)` so shell loops can tell
 *  "no message yet" from a real failure. Zero is reserved for "a directed act woke me". */
export const WAIT_TIMEOUT_EXIT = 124;
/** Default `--wait` bound (seconds): long enough to be a real event-wait, short enough that a dropped
 *  socket can't hang a `/loop` re-invoker forever (ADR 054). `--timeout 0` waits unbounded. */
const DEFAULT_WAIT_TIMEOUT_S = 300;

export async function inboxCommand(parsed: Parsed): Promise<number> {
  const { config, team, identity, http } = resolve(parsed.flags);
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);
  // --all = the whole-team firehose (ADR 061): every envelope, not just my inbox.
  const all = Boolean(parsed.flags['all']);

  // --wait (ADR 054): block on the watch socket until the next directed act for this seat arrives,
  // then print it and exit 0 — the efficient, no-poll form of the wake-on-message pattern. Pairs with
  // a harness re-invoker (`/loop`): `musterd inbox --wait && <do the work>`.
  if (parsed.flags['wait']) {
    return waitInbox(parsed, http, config.server, team, identity, kindOf);
  }

  if (parsed.flags['watch']) {
    return watchInbox(parsed, http, config.server, team, identity, kindOf, all);
  }

  if (all) {
    const res = await http.messages(team, { limit: 200 });
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(res.messages) + '\n');
      return 0;
    }
    process.stdout.write(
      `${theme.accent('firehose')} — ${team} (${res.messages.length} message${res.messages.length === 1 ? '' : 's'})\n`,
    );
    if (res.messages.length === 0) {
      process.stdout.write(theme.meta('no communication yet') + '\n');
      return 0;
    }
    for (const m of res.messages) process.stdout.write(renderMessageRow(m, kindOf) + '\n');
    process.stdout.write(
      theme.meta('musterd inbox --watch --all to follow the firehose live') + '\n',
    );
    return 0;
  }

  const unread = Boolean(parsed.flags['unread']);
  const res = await http.inbox(team, { unread });
  const messages = res.messages;

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(messages) + '\n');
    return 0;
  }

  const unreadCount = countUnread(messages, res.cursor.last_read_ts, identity.name);
  process.stdout.write(`${theme.accent('inbox')} — ${team} (${unreadCount} unread)\n`);
  if (messages.length === 0) {
    process.stdout.write(theme.meta("inbox empty — nobody's mustered anything yet") + '\n');
    return 0;
  }
  for (const m of messages) {
    const isUnread = m.ts > res.cursor.last_read_ts;
    process.stdout.write(renderMessageRow(m, kindOf, { unread: isUnread }) + '\n');
  }
  // Advance the read cursor unless peeking.
  if (!parsed.flags['peek'] && messages.length > 0) {
    const last = messages[messages.length - 1]!;
    await http.markRead(team, last.id).catch(() => undefined);
  }
  process.stdout.write(theme.meta('musterd inbox --watch to follow live') + '\n');
  return 0;
}

function countUnread(messages: Envelope[], cursorTs: number, _self: string): number {
  return messages.filter((m) => m.ts > cursorTs).length;
}

async function watchInbox(
  parsed: Parsed,
  http: ReturnType<typeof resolve>['http'],
  server: string,
  team: string,
  identity: { name: string; token: string; surface: string },
  kindOf: (name: string) => MemberKind,
  all: boolean,
): Promise<number> {
  // Ring the terminal bell on an action-needed act, but only on a real TTY and unless --no-bell.
  // The bell is the cheapest true "push" we have for the watching-but-distracted human (ADR 024).
  const bell = process.stdout.isTTY === true && parsed.flags['no-bell'] !== true;
  const seen = new Set<string>();

  process.stdout.write(
    all
      ? `${theme.accent('firehose')} — ${team}  ${theme.ok('◉ watching all')}\n`
      : `${theme.accent('inbox')} — ${team}  ${theme.ok('◉ watching')}\n`,
  );
  // Firehose: backfill recent team history before live-tailing, deduped by id against the live stream.
  if (all) {
    const hist = await http
      .messages(team, { limit: 30 })
      .catch(() => ({ messages: [] as Envelope[] }));
    for (const m of hist.messages) {
      seen.add(m.id);
      process.stdout.write(renderMessageRow(m, kindOf) + '\n');
    }
    if (hist.messages.length > 0) process.stdout.write(theme.meta('— live —') + '\n');
  }

  return new Promise((resolveP) => {
    const session = watch({
      wsUrl: wsBase(server) + '/ws',
      team,
      as: identity.name,
      token: identity.token,
      surface: identity.surface || 'cli',
      // A human running `inbox --watch` is explicitly here (the supervising posture) — `session`.
      provenance: 'session',
      workspace: resolveWorkspace(),
      scope: all ? 'team-all' : 'team',
      onDeliver: (env) => {
        if (seen.has(env.id)) return; // a backfilled message that also arrives live
        seen.add(env.id);
        // Surface request_help / @you-directed acts above the status_update stream so they can't be
        // missed; everything else streams plainly (piece A of the human-reachability nudge, ADR 024).
        const flagged = isActionNeeded(env, identity.name);
        if (flagged && bell) process.stdout.write('\u0007');
        const banner = flagged ? theme.actionNeeded() + '\n' : '';
        process.stdout.write(banner + renderMessageRow(env, kindOf) + '\n');
      },
      onPresence: (member, status, surface) =>
        process.stdout.write(
          theme.meta(`· ${member} ${status}${surface ? ` (${surface})` : ''}`) + '\n',
        ),
      onError: (msg) => {
        process.stderr.write(`${theme.err('✗')} ${msg}\n`);
      },
    });
    const stop = () => {
      session.close();
      process.stdout.write('\n');
      resolveP(0);
    };
    process.on('SIGINT', stop);
  });
}

/**
 * Does `env` wake a `--wait`? A **directed act for this seat** by default (broadcast journal traffic
 * shouldn't wake a waiting agent — ADR 054), never the seat's own send, optionally narrowed by
 * `--from`/`--act`. The same directed-to-me notion `isActionNeeded` uses, minus request_help-to-team.
 */
function wakesWait(
  env: Envelope,
  me: string,
  filter: { from?: string | undefined; act?: string | undefined },
): boolean {
  if (env.from === me) return false; // never wake on my own echo
  if (!(env.to.kind === 'member' && env.to.name === me)) return false;
  if (filter.from && env.from !== filter.from) return false;
  if (filter.act && env.act !== filter.act) return false;
  return true;
}

/**
 * `musterd inbox --wait` (ADR 054): a blocking one-shot consumer of the watch socket. Rides the same
 * push `--watch` uses, but exits on the **first directed act** for this seat instead of streaming —
 * exit 0 on a message, {@link WAIT_TIMEOUT_EXIT} on timeout. It first drains the durable inbox so a
 * message that landed *just before* the wait started (the startup race) isn't missed.
 */
async function waitInbox(
  parsed: Parsed,
  http: ReturnType<typeof resolve>['http'],
  server: string,
  team: string,
  identity: { name: string; token: string; surface: string },
  kindOf: (name: string) => MemberKind,
): Promise<number> {
  const json = Boolean(parsed.flags['json']);
  const peek = Boolean(parsed.flags['peek']);
  const filter = { from: flagStr(parsed.flags, 'from'), act: flagStr(parsed.flags, 'act') };
  const timeoutRaw = flagStr(parsed.flags, 'timeout');
  const timeoutS = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_WAIT_TIMEOUT_S;
  if (Number.isNaN(timeoutS) || timeoutS < 0) {
    process.stderr.write(`${theme.err('✗')} --timeout must be a non-negative number of seconds\n`);
    return 2;
  }

  // Emit a matched act and consume it (advance the read cursor unless --peek), then exit 0.
  const deliver = async (env: Envelope): Promise<number> => {
    process.stdout.write((json ? JSON.stringify(env) : renderMessageRow(env, kindOf)) + '\n');
    if (!peek) await http.markRead(team, env.id).catch(() => undefined);
    return 0;
  };

  // Startup-race guard: a directed act may have landed between the last check and this wait. Drain the
  // durable inbox first and wake immediately on the earliest unread match, before opening the socket.
  const pending = await http.inbox(team, { unread: true }).catch(() => undefined);
  if (pending) {
    const hit = pending.messages.find(
      (m) => m.ts > pending.cursor.last_read_ts && wakesWait(m, identity.name, filter),
    );
    if (hit) return deliver(hit);
  }

  return new Promise<number>((resolveP) => {
    let done = false;
    const finish = (code: number, after?: () => Promise<void>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      session.close();
      const tail = after ? after() : Promise.resolve();
      void tail.then(() => resolveP(code));
    };

    const timer =
      timeoutS > 0
        ? setTimeout(() => {
            process.stderr.write(theme.meta(`no directed act within ${timeoutS}s`) + '\n');
            finish(WAIT_TIMEOUT_EXIT);
          }, timeoutS * 1000)
        : undefined;

    const session = watch({
      wsUrl: wsBase(server) + '/ws',
      team,
      as: identity.name,
      token: identity.token,
      surface: identity.surface || 'cli',
      // A waiting agent is genuinely here and reachable — a resident session, like `--watch`.
      provenance: 'session',
      workspace: resolveWorkspace(),
      scope: 'team',
      onDeliver: (env) => {
        if (done || !wakesWait(env, identity.name, filter)) return;
        finish(0, async () => {
          await deliver(env);
        });
      },
      onError: (msg) => {
        // A dropped/refused socket shouldn't hang the wait — surface it and let an outer loop re-enter.
        process.stderr.write(`${theme.err('✗')} ${msg}\n`);
        finish(WAIT_TIMEOUT_EXIT);
      },
    });

    process.on('SIGINT', () => finish(WAIT_TIMEOUT_EXIT));
  });
}
