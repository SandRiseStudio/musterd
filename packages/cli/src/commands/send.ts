import { withTraceContext } from '@musterd/mcp';
import {
  type Act,
  askContract,
  askContractText,
  AskTierSchema,
  chooseAutoTarget,
  CLI_REPLY_TO_STYLE,
  type BlockedBy,
  type Envelope,
  makeEnvelope,
  MAX_ELIGIBLE,
  type Recipient,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, parseMeta, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { readBindingAt } from '../config.js';
import { CliError } from '../errors.js';
import { dischargedIds, openActionNeeded, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { bindThread } from '../session/continuity.js';
import { findWorkspaceDir, kindLookup, resolve } from './helpers.js';

/**
 * The act `accept`/`decline` answers, when the caller didn't name one (ADR 067). Auto-targets the
 * **latest still-open request_help/handoff** waiting for this member — so answering is one command,
 * not `inbox --json | parse the id | --reply-to <id>`. Returns the envelope to reply to, or undefined
 * if nothing is open (then the caller errors with guidance). Best-effort: a read failure → undefined.
 */
async function openRequests(http: HttpClient, team: string, me: string): Promise<Envelope[]> {
  try {
    const res = await http.inbox(team, { unread: false });
    const open = openActionNeeded(res.messages, me, res.answered ?? [], dischargedIds(res)).filter(
      (m) =>
        m.act === 'request_help' || m.act === 'handoff' || m.act === 'challenge' || m.act === 'ask',
    );
    return open.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

function parseRecipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  if (to.startsWith('@'))
    throw new CliError(`unknown recipient "${to}" (use @team or @broadcast)`, 2);
  return { kind: 'member', name: to };
}

/**
 * ADR 254: `--to a,b` names an eligible set — 2–MAX_ELIGIBLE seats, any one of whom can answer.
 *
 * Mirrors the MCP surface's arity rules on purpose (empty → `@team`, one name → a directed act,
 * 2–4 → a team act carrying `meta.eligible`, 5+ → refused), each package keeping its own error
 * convention. A single value keeps its EXACT existing behaviour, including the `@alias` rejection,
 * so nothing a seat types today changes meaning.
 */
export function parseRecipients(to: string): { to: Recipient; eligible: string[] | null } {
  const names = to
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  // A trailing comma or a stray space is a typo, not an intent to address nobody — so a list that
  // collapses to one name is a directed act, and one that collapses to none is `@team`.
  if (names.length <= 1) return { to: parseRecipient(names[0] ?? '@team'), eligible: null };
  if (names.length > MAX_ELIGIBLE) {
    throw new CliError(
      `too many recipients (${names.length}) — name at most ${MAX_ELIGIBLE} seats, or use @team`,
      2,
    );
  }
  // `@team`/`@broadcast` are whole-audience aliases, not seats. Dropping one silently would send to
  // a narrower audience than was asked for, so it is refused.
  const alias = names.find((n) => n.startsWith('@'));
  if (alias) {
    throw new CliError(`"${alias}" cannot appear in a list of seats — send to it on its own`, 2);
  }
  return { to: { kind: 'team' }, eligible: names };
}

/**
 * Incident convergence increment 2 — the CLI half of the report contract.
 *
 * Increment 1 shipped `meta.blocked_by` and measured zero reports. One reason is mechanical: a CLI
 * seat could not express the report at all. `--meta` coerces every value to a string, number, or
 * boolean (`args.ts` `coerce`), so `--meta blocked_by.gate=…` lands as a FLAT key and never becomes
 * the nested object the daemon clusters on. This flag is that missing path, and it deliberately
 * spells the whole report — a seat should be able to file one from the line the failing gate printed,
 * without knowing what envelope meta is.
 *
 * The report rides `status_update` (spec §1 — no new act), so a bare `--blocked-by` supplies the act
 * and any other act is refused rather than silently filed somewhere the clustering never looks.
 */
export function blockedByFlags(
  flags: Record<string, string | boolean>,
  act: Act | undefined,
): { act: Act; report: BlockedBy } | null {
  if (flags['blocked-by'] === undefined) return null;
  const gate = flagStr(flags, 'blocked-by')?.trim();
  if (!gate) {
    throw new CliError(
      '--blocked-by wants the gate — the exact check name, e.g. --blocked-by "ci:gates/A11y contrast"',
      2,
    );
  }
  if (act !== undefined && act !== 'status_update') {
    throw new CliError(
      `--blocked-by files a shared-blocker report, which rides status_update — not --act ${act}. Drop --act (it is implied) or send the report separately.`,
      2,
    );
  }
  // Empty --ref/--sig are dropped rather than passed through: the protocol requires min(1) on both,
  // so a shell variable that expanded to nothing would turn a good report into a rejected envelope.
  const ref = flagStr(flags, 'ref')?.trim();
  const sig = flagStr(flags, 'sig')?.trim();
  return {
    act: 'status_update',
    report: { gate, ...(ref ? { ref } : {}), ...(sig ? { sig } : {}) },
  };
}

export async function sendCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);
  const to = flagStr(parsed.flags, 'to') ?? '@team';
  // A shared-blocker report supplies its own act (status_update, spec §1), so `--blocked-by` alone is
  // a complete command — which is the whole point: the failing gate prints one line a seat can paste.
  const blocked = blockedByFlags(parsed.flags, flagStr(parsed.flags, 'act') as Act | undefined);
  const act = blocked?.act ?? (flagStr(parsed.flags, 'act') as Act | undefined);
  if (!act)
    throw new CliError('usage: musterd send --to <name|a,b|@team> --act <act> <body...>', 2);
  // A pasted `--blocked-by` one-liner may carry no prose at all. The envelope allows an empty body,
  // but a blank status_update reads as noise on every surface that renders one, so the report speaks
  // for itself when the seat did not.
  const body =
    parsed.positionals.join(' ') ||
    (blocked ? `blocked by ${blocked.report.gate} — parked, not debugging it` : '');
  const replyTo = flagStr(parsed.flags, 'reply-to');

  const meta = parseMeta(parsed.metaPairs) ?? {};
  if (blocked) meta['blocked_by'] = blocked.report;
  if (replyTo) meta['in_reply_to'] = replyTo;

  // accept/decline auto-targeting (ADR 067): when answering without an explicit reply target, point at
  // the latest open request_help/handoff for this member and inherit its thread, so closing the loop is
  // one command. An explicit --reply-to / --meta in_reply_to / --thread always wins.
  let thread = flagStr(parsed.flags, 'thread');
  if ((act === 'accept' || act === 'decline') && !replyTo && !meta['in_reply_to']) {
    const open = await openRequests(http, team, identity.name);
    // One rule, in `@musterd/protocol`, shared with the MCP adapter — see `chooseAutoTarget` for
    // why having written it twice is what let it be wrong in both places for so long.
    const decision = chooseAutoTarget(open, act, CLI_REPLY_TO_STYLE);
    if (decision.kind !== 'target') throw new CliError(decision.message, 2);
    const target = decision.target as Envelope;
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

  // ADR 254: resolve `--to` before composing. This can REFUSE (too many names, an alias inside a
  // list), and it must do so outside the try below — that catch relabels everything as
  // "invalid message", which would bury a precise, actionable recipient error.
  const { to: recipientTo, eligible } = parseRecipients(to);
  if (eligible) meta['eligible'] = eligible;

  let envelope;
  try {
    envelope = makeEnvelope({
      id: ulid(),
      team,
      from: identity.name,
      to: recipientTo,
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

  const ackBody = await http.send(team, envelope);

  // ADR 210: a successful threaded send means this session IS the dialogue on that thread, which is
  // exactly the causal fact a later wake needs and the daemon can never learn. Bind it locally.
  // Deliberately after the send and deliberately swallowing failure: the registry is an
  // optimization, and a send that succeeded must never report failure because a local cache write
  // did. The worst case is a fresh wake, which is always correct.
  if (envelope.thread) {
    try {
      const dir = findWorkspaceDir();
      const binding = dir ? readBindingAt(dir) : null;
      if (dir && binding?.session) {
        bindThread(dir, {
          team,
          seat: identity.name,
          thread_id: envelope.thread,
          capture: binding.session,
          now: Date.now(),
        });
      }
    } catch {
      // never fatal — see above
    }
  }

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
    // Prefer the daemon-derived contract (carries `unblocker_reachable`, ADR 153); the pure local
    // contract stands when an older daemon omits it.
    const payload = askTier
      ? { ...envelope, ask_contract: ackBody?.ask_contract ?? askContract(askTier) }
      : envelope;
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
  if (askTier)
    process.stdout.write(
      theme.dim(askContractText(envelope.id, askTier, ackBody?.ask_contract?.unblocker_reachable)) +
        '\n',
    );
  return 0;
}
