import type { McpServer } from '@modelcontextprotocol/server';
import {
  type Act,
  ACTS,
  type AskTier,
  AskTierSchema,
  askContract,
  askContractText,
  chooseAutoTarget,
  type Envelope,
  makeEnvelope,
  MAX_ELIGIBLE,
  type Recipient,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { withTraceContext } from '../otel.js';
import { errorResult, notReadyMessage, textResult } from './format.js';

// ADR 316: keep the Act vocabulary and ask's conditionally-required fields in standing context;
// examples, rationale, and plan-epoch mechanics are retrievable from the musterd skill.
const DESCRIPTION =
  'Send a coordination Act. Use status_update for progress, request_help when blocked, handoff to ' +
  'transfer work, accept/decline to answer, wait to pause, resolve to close a thread, steer to ' +
  'redirect, challenge for justification, defer to shelve a Goal, or ask a human. ask requires ' +
  'meta.species and meta.tier; 2–4 to names mean any may answer.';

function recipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  return { kind: 'member', name: to };
}

/**
 * ADR 254: `to` normalised by ARITY.
 *
 * | `to`                    | result                            |
 * | ----------------------- | --------------------------------- |
 * | `[]`                    | `@team`                           |
 * | `'x'` / `['x']`         | directed act                      |
 * | `['x','y']` (2-4)       | team act + `meta.eligible`        |
 * | 5+                      | rejected                          |
 *
 * The first two rows are exactly what `coerce.ts` already repaired (`to:[]→default`,
 * `to:[one]→string`), so this is additive: the only behaviour that changes is that its 2+ bounce
 * becomes a real path.
 *
 * The array is SURFACE SUGAR. A multi-name send is persisted and audited as a team act carrying
 * `meta.eligible`, never as an array-shaped recipient, so nothing below `routeEnvelope` learns a new
 * wire shape.
 */
export function normalizeTo(to: string | string[]): {
  to: Recipient;
  eligible: string[] | null;
} {
  const names = (Array.isArray(to) ? to : [to]).map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return { to: { kind: 'team' }, eligible: null };
  if (names.length === 1) return { to: recipient(names[0]!), eligible: null };
  if (names.length > MAX_ELIGIBLE) {
    throw new Error(
      `too many recipients (${names.length}) — name at most ${MAX_ELIGIBLE} seats, or use @team`,
    );
  }
  // `@team`/`@broadcast` are whole-audience aliases, not seats: a set is named seats or it is not a
  // set. Silently dropping the alias would send to a narrower audience than the caller asked for.
  const alias = names.find((n) => n.startsWith('@'));
  if (alias) {
    throw new Error(`"${alias}" cannot appear in a list of seats — send to ${alias} on its own`);
  }
  return { to: { kind: 'team' }, eligible: names };
}

/** Acts an `accept`/`decline` can answer: a call for help, a handoff, a `challenge` (ADR 103), or a
 *  to-human `ask` (ADR 147 — an admin accepts/declines the latest open ask without naming it). */
const ANSWERABLE = new Set<Act>(['request_help', 'handoff', 'challenge', 'ask']);

/**
 * Still-open request_help/handoff/challenge/ask waiting for `me` — the acts an `accept`/`decline`
 * answers when the caller didn't name one (ADR 067, parity with the CLI's `send`). A `request_help`
 * (anyone can answer) or an act directed at `me`, whose thread carries no `resolve`, newest first.
 * Best-effort: a read failure → empty.
 */
async function openAnswerable(client: MusterdClient, me: string): Promise<Envelope[]> {
  try {
    const { messages, answered } = await client.fetchInbox(false);
    const resolved = new Set<string>();
    for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
    // An act I already replied to is not open, and only the server can tell me so: the inbox
    // excludes my own sends, so the reply that answers it never appears in `messages`. Reading
    // closure from `resolve` alone left every answered ask open forever — 199 accepts against 9
    // resolves on the live ledger — which silted up the lane-acceptance candidate list with dead
    // asks and could push the live one out of the six it shows. Absent on an older daemon ⇒ empty ⇒
    // exactly the previous behaviour.
    const alreadyAnswered = new Set(answered ?? []);
    const open = messages.filter((m) => {
      if (!ANSWERABLE.has(m.act)) return false;
      const directed =
        m.act === 'request_help' || m.act === 'ask' || (m.to.kind === 'member' && m.to.name === me);
      return directed && !resolved.has(m.thread ?? m.id) && !alreadyAnswered.has(m.id);
    });
    return open.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Narrow an unknown meta.tier to a valid `AskTier` (validation already enforced it on `ask`). */
function isAskTier(tier: unknown): tier is AskTier {
  return AskTierSchema.safeParse(tier).success;
}

export function registerSend(server: McpServer, client: MusterdClient, config: McpConfig): void {
  server.registerTool(
    'team_send',
    {
      description: DESCRIPTION,
      inputSchema: {
        // ADR 254: an array is accepted because agents were already sending one — `coerce.ts`
        // repaired the 0- and 1-element cases and bounced 2+. Now 2-4 names mean "either of you".
        to: z
          .union([z.string(), z.array(z.string())])
          .default('@team')
          .describe("member name, '@team', '@broadcast', or 2-4 names (either may answer)"),
        // Derived from ACTS (the protocol's single source of truth) so the MCP surface can never drift
        // from the enum — a new act lands here the moment it's appended (ADR 103). Rebuilt with this
        // package's zod (4) rather than importing ActSchema: the protocol package is still on zod 3,
        // and a zod-3 schema object is not a zod-4 type at the registerTool boundary.
        act: z.enum(ACTS),
        body: z.string(),
        thread: z.string().optional().describe('thread id to reply within'),
        reply_to: z
          .string()
          .optional()
          .describe('message id this accepts/declines; omit to answer the latest open ask'),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('act-specific fields, e.g. {progress:0.5}'),
      },
    },
    async (args) => {
      if (!client.holdsSeat || !config.member) {
        return textResult(notReadyMessage(client, 'send'));
      }
      const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
      if (args.reply_to) meta['in_reply_to'] = args.reply_to;

      // accept/decline auto-targeting (ADR 067, parity with the CLI): when answering without an explicit
      // reply target, point at the latest open request_help/handoff for this member and inherit its
      // thread, so closing the loop is one tool call. An explicit reply_to / meta.in_reply_to wins.
      let thread = args.thread;
      if (
        (args.act === 'accept' || args.act === 'decline') &&
        !args.reply_to &&
        !meta['in_reply_to']
      ) {
        const open = await openAnswerable(client, config.member);
        // One rule, in `@musterd/protocol`, because this refusal used to be written here and again
        // in the CLI and tested in neither — and both copies asked whether the GUESS was a lane
        // acceptance instead of whether the ACT was a verdict. See `chooseAutoTarget` for the
        // measured failure that distinction cost.
        const decision = chooseAutoTarget(open, args.act);
        if (decision.kind !== 'target') return textResult(decision.message);
        const target = decision.target as Envelope;
        meta['in_reply_to'] = target.id;
        thread ??= target.thread ?? target.id;
      }

      // Ride the adapter's active trace context along as meta.otel (ADR 011) so a handoff links the
      // sender's and receiver's traces across runtimes. Inert when there's no active context.
      // ADR 254: resolve `to` before composing. Normalisation can REJECT (too many names, an alias
      // inside a list), and that has to happen before anything is sent — a refusal the caller reads
      // as text is recoverable; a send to the wrong audience is not.
      let addressed: { to: Recipient; eligible: string[] | null };
      try {
        addressed = normalizeTo(args.to);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
      if (addressed.eligible) meta['eligible'] = addressed.eligible;
      /** What to call the audience in prose and structured output — the names, never the raw array. */
      const toLabel = addressed.eligible ? addressed.eligible.join(', ') : String(args.to);

      const metaToSend = withTraceContext(Object.keys(meta).length ? meta : null);
      try {
        const envelope = makeEnvelope({
          id: ulid(),
          team: config.team,
          from: config.member,
          to: addressed.to,
          act: args.act as Act,
          body: args.body,
          thread: thread ?? null,
          meta: metaToSend,
        });
        const ackBody = await client.sendEnvelope(envelope);
        client.markSeen(envelope.id); // don't echo our own send back via inbox
        // The ask's tier contract (ADR 147 §2): the agent owns the clock, so the send response hands it
        // back its marching orders — how long to wait, and the no-answer policy to invoke on silence. The
        // top tier HOLDS (never proceed); below-top PROCEEDS with a recorded risk-acceptance
        // (status_update, meta.ask_ref + meta.ask_outcome:'risk_accepted' + meta.risk + meta.chosen_approach).
        // The daemon's ack may carry the derived contract with `unblocker_reachable` (ADR 153) — prefer
        // it: when provably unreachable, the top-tier orders become STRAND, not hold. Older daemons omit
        // it and the pure local contract stands.
        const serverContract = ackBody?.ask_contract;
        const askGuidance =
          args.act === 'ask' && isAskTier(meta['tier'])
            ? askContractText(envelope.id, meta['tier'], serverContract?.unblocker_reachable)
            : null;
        // The delivery hint (ADR 167): the daemon says the recipient is live on this machine, and the
        // relay is the SENDER's to make (only live desktop sessions hold the harness's session-send
        // tool). Quoted verbatim so the model can relay it unmodified — the fingerprint check on the
        // other end verifies exactly that. Absent hint (older daemon, offline recipient, damped) ⇒
        // this response is byte-identical to before the ADR.
        const hint = ackBody?.delivery_hint;
        const hintGuidance = hint
          ? ` Recipient is live: if you have the ccd session tools, find their session via ` +
            `list_sessions (seat-name label) and send_message this line VERBATIM: "${hint.nudge_text}"`
          : '';
        // The handoff's lane (ADR 231): a `handoff` that named no lane either got one attached —
        // because the sender held exactly one live lane, so there was nothing to choose between —
        // or gets told it holds several and the orientation `why` cannot tell which. Surfaced
        // rather than silent: work was linked to the message on the sender's behalf, and they are
        // the one who can correct it.
        const handoffLane = ackBody?.handoff_lane;
        const handoffGuidance = !handoffLane
          ? ''
          : 'warning' in handoffLane
            ? ` NOTE: ${handoffLane.warning}`
            : ` Lane ${handoffLane.lane} attached (your only live lane` +
              `${handoffLane.branch ? `, branch ${handoffLane.branch}` : ''}) — ` +
              `re-send with meta.lane_handoff.lane if this handoff was about something else.`;
        // Structured-first (ADR 144 inc 3): the id/thread a programmatic caller needs to keep the
        // exchange threaded (reply_to / thread on the next send), without parsing the prose.
        const text =
          (askGuidance
            ? `sent ask to ${toLabel} (id=${envelope.id}). ${askGuidance}`
            : `sent ${args.act} to ${toLabel} (id=${envelope.id})`) +
          hintGuidance +
          handoffGuidance;
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            id: envelope.id,
            act: args.act,
            // Stays a STRING even for a set, so a consumer reading `.to` never has to handle two
            // types; the machine-readable set rides beside it rather than changing this field's shape.
            to: toLabel,
            thread: envelope.thread,
            ...(addressed.eligible ? { eligible: addressed.eligible } : {}),
            ...(args.act === 'ask' && isAskTier(meta['tier'])
              ? { ask_contract: serverContract ?? askContract(meta['tier']) }
              : {}),
            ...(hint ? { delivery_hint: hint } : {}),
            ...(handoffLane ? { handoff_lane: handoffLane } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
