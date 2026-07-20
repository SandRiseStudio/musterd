import { withTraceContext } from '@musterd/mcp';
import {
  type Act,
  askContract,
  askContractText,
  AskTierSchema,
  type Envelope,
  makeEnvelope,
  type Recipient,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, parseMeta, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { openActionNeeded, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { kindLookup, resolve } from './helpers.js';

/**
 * The act `accept`/`decline` answers, when the caller didn't name one (ADR 067). Auto-targets the
 * **latest still-open request_help/handoff** waiting for this member — so answering is one command,
 * not `inbox --json | parse the id | --reply-to <id>`. Returns the envelope to reply to, or undefined
 * if nothing is open (then the caller errors with guidance). Best-effort: a read failure → undefined.
 */
async function latestOpenRequest(
  http: HttpClient,
  team: string,
  me: string,
): Promise<Envelope | undefined> {
  try {
    const res = await http.inbox(team, { unread: false });
    const open = openActionNeeded(res.messages, me).filter(
      (m) =>
        m.act === 'request_help' || m.act === 'handoff' || m.act === 'challenge' || m.act === 'ask',
    );
    return open.sort((a, b) => b.ts - a.ts)[0];
  } catch {
    return undefined;
  }
}

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
  const replyTo = flagStr(parsed.flags, 'reply-to');

  const meta = parseMeta(parsed.metaPairs) ?? {};
  if (replyTo) meta['in_reply_to'] = replyTo;

  // accept/decline auto-targeting (ADR 067): when answering without an explicit reply target, point at
  // the latest open request_help/handoff for this member and inherit its thread, so closing the loop is
  // one command. An explicit --reply-to / --meta in_reply_to / --thread always wins.
  let thread = flagStr(parsed.flags, 'thread');
  if ((act === 'accept' || act === 'decline') && !replyTo && !meta['in_reply_to']) {
    const target = await latestOpenRequest(http, team, identity.name);
    if (!target) {
      throw new CliError(
        `no open request to ${act} — name one with --reply-to <id> (see musterd inbox --json)`,
        2,
      );
    }
    meta['in_reply_to'] = target.id;
    thread ??= target.thread ?? target.id;
  }
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
      // Attach the active trace context as meta.otel (ADR 011 sender SHOULD) — live whenever the
      // CLI telemetry SDK wrapped this command in a span (ADR 089), inert otherwise.
      meta: withTraceContext(Object.keys(meta).length ? meta : null),
    });
  } catch (err) {
    throw new CliError(`invalid message: ${(err as Error).message}`, 3);
  }

  await http.send(team, envelope);

  // The ask's tier contract (ADR 147 §2), at parity with the MCP `team_send` response: when an agent
  // raises an `ask` from the CLI it gets the same marching orders — how long to wait, and what to do on
  // silence — via the shared `askContractText`, so the CLI is no longer the one ask surface that stays
  // silent about the wait/hold contract (finding 006 item 3). A valid `ask` always carries a tier
  // (enforced by makeEnvelope above), so the narrowing here only guards a malformed meta.
  const tier = envelope.meta?.['tier'];
  const askTier =
    act === 'ask' && AskTierSchema.safeParse(tier).success ? AskTierSchema.parse(tier) : null;

  if (parsed.flags['json']) {
    // Additive, id-preserving: programmatic callers still read `.id`, and now get the derived contract
    // (mirrors the MCP structured `ask_contract`) without a second round-trip to the tier table.
    const payload = askTier ? { ...envelope, ask_contract: askContract(askTier) } : envelope;
    process.stdout.write(JSON.stringify(payload) + '\n');
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
  if (askTier) process.stdout.write(theme.dim(askContractText(envelope.id, askTier)) + '\n');
  return 0;
}
