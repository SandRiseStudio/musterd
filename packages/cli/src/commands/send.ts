import { makeEnvelope, type Act, type Recipient } from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, parseMeta, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { kindLookup, resolve } from './helpers.js';

function parseRecipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  if (to.startsWith('@'))
    throw new CliError(`unknown recipient "${to}" (use @team or @broadcast)`, 2);
  return { kind: 'member', name: to };
}

export async function sendCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);
  const to = flagStr(parsed.flags, 'to') ?? '@team';
  const act = flagStr(parsed.flags, 'act') as Act | undefined;
  if (!act) throw new CliError('usage: musterd send --to <name|@team> --act <act> <body...>', 2);
  const body = parsed.positionals.join(' ');
  const thread = flagStr(parsed.flags, 'thread');
  const replyTo = flagStr(parsed.flags, 'reply-to');

  const meta = parseMeta(parsed.metaPairs) ?? {};
  if (replyTo) meta['in_reply_to'] = replyTo;
  // Urgency breakthrough (ADR 044): `--urgent` flags the envelope so it pierces an away/dnd
  // recipient's hold; `--urgent-reason` is required (the protocol rejects urgent without it). UNGATED
  // on localhost — the `can_flag_urgent` capability that scopes who may flag is the v0.3 seam.
  if (parsed.flags['urgent'] === true) {
    meta['urgent'] = true;
    const reason = flagStr(parsed.flags, 'urgent-reason');
    if (reason) meta['urgent_reason'] = reason;
  }

  let envelope;
  try {
    envelope = makeEnvelope({
      id: ulid(),
      team,
      from: identity.name,
      to: parseRecipient(to),
      act,
      body,
      thread: thread ?? null,
      meta: Object.keys(meta).length ? meta : null,
    });
  } catch (err) {
    throw new CliError(`invalid message: ${(err as Error).message}`, 3);
  }

  await http.send(team, envelope);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return 0;
  }
  // Echo the sent row; resolve kinds best-effort for coloring.
  let kindOf = (_: string) => 'agent' as const;
  try {
    const roster = await http.roster(team);
    kindOf = kindLookup(roster.members) as typeof kindOf;
  } catch {
    // roster is best-effort for color only
  }
  process.stdout.write(renderMessageRow(envelope, kindOf) + '\n');
  process.stdout.write(`${theme.ok('✓')} sent\n`);
  return 0;
}
