import type { Envelope, MemberKind } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { wsBase } from '../config.js';
import { watch } from '../client.js';
import { theme } from '../render/theme.js';
import { renderMessageRow } from '../render/rows.js';
import { kindLookup, resolve } from './helpers.js';

export async function inboxCommand(parsed: Parsed): Promise<number> {
  const { config, team, identity, http } = resolve(parsed.flags);
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);

  if (parsed.flags['watch']) {
    return watchInbox(parsed, config.server, team, identity, kindOf);
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

function watchInbox(
  parsed: Parsed,
  server: string,
  team: string,
  identity: { name: string; token: string; surface: string },
  kindOf: (name: string) => MemberKind,
): Promise<number> {
  return new Promise((resolveP) => {
    process.stdout.write(`${theme.accent('inbox')} — ${team}  ${theme.ok('◉ watching')}\n`);
    const session = watch({
      wsUrl: wsBase(server) + '/ws',
      team,
      as: identity.name,
      token: identity.token,
      surface: identity.surface || 'cli',
      onDeliver: (env) => process.stdout.write(renderMessageRow(env, kindOf) + '\n'),
      onPresence: (member, status, surface) =>
        process.stdout.write(theme.meta(`· ${member} ${status}${surface ? ` (${surface})` : ''}`) + '\n'),
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
