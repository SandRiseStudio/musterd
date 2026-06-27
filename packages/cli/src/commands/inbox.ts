import { resolveWorkspace } from '@musterd/mcp';
import type { Envelope, MemberKind } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { watch } from '../client.js';
import { wsBase } from '../config.js';
import { isActionNeeded, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { kindLookup, resolve } from './helpers.js';

export async function inboxCommand(parsed: Parsed): Promise<number> {
  const { config, team, identity, http } = resolve(parsed.flags);
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);
  // --all = the whole-team firehose (ADR 061): every envelope, not just my inbox.
  const all = Boolean(parsed.flags['all']);

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
