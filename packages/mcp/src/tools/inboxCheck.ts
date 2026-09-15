import type { McpServer } from '@modelcontextprotocol/server';
import { envelopePosition, type Envelope } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { linkReceived } from '../otel.js';
import {
  buildSkewWarning,
  syncWedgeWarningFor,
  errorResult,
  formatMessage,
  notReadyMessage,
  textResult,
} from './format.js';
import { renderRoom, roomStructured, roomsFor, type RoomContext } from './huddleRooms.js';

// Length is gated (`pnpm context:check`, standing-context budgets): this string is in every turn's
// tool list, so the elision contract is stated in the fewest bytes that still state it. The full
// reasoning lives in ADR 287; the runtime notice carries the detail at the moment it matters.
const DESCRIPTION =
  'Check unread addressed to you or the team, marking them read. Call at task start, ' +
  'task end, and after heads-down work. Past `limit` nothing is marked read; the reply ' +
  'says how many remain.';

/**
 * How far back the room fold reads (ADR 378). Matches the CLI's room view deliberately: a huddle is
 * a bounded burst, so the recent window holds it, and the two surfaces must agree on where history
 * stops or the same room is two different rooms. A huddle older than this is history and belongs to
 * the artifact its close named.
 */
const HUDDLE_WINDOW = 1000;

/**
 * How many of the oldest unread one call may render as one-line digest entries (lane 01M2GT874Y).
 *
 * ADR 287 holds the cursor over anything a call did not render. Held ENTIRELY, that rule was
 * self-sustaining: a seat past its `limit` elided on every check, advanced never, and so stayed
 * past its limit — delta's cursor sat unmoved for 9.9 days across 22 checks, stanley's for 101
 * minutes on the hub alone. The escape hatch (a bigger `limit`) was real and named in the notice,
 * and no seat ever took it. So the drain is made ordinary instead: the oldest unread, contiguous
 * from the cursor, are rendered compactly and the watermark walks over them. A row rendered as a
 * digest line was seen — the reader has its id, sender, act and the start of its body — which is
 * exactly what ADR 287's rule protects. The cap keeps one reply inside what a harness will actually
 * hand the model (the tool-result ceiling is ~70k chars; 50 full rows plus this many digest lines
 * stays well under), and it bounds the drain to a handful of ordinary checks rather than one giant
 * one: 1300 behind clears in six.
 */
const DIGEST_ROWS = 250;

/** What one `team_inbox_check` should display, and how far the read cursor may move (ADR 287). */
export interface InboxCheckPlan {
  /** The messages to render — pinned waiting acts plus the newest fill, so relevance is unchanged. */
  shown: Envelope[];
  /**
   * The oldest unread, contiguous from the cursor and not in `shown`, rendered as one line each so
   * the cursor can walk over them (lane 01M2GT874Y). Empty when nothing was cut, and empty when the
   * fetch itself was bounded — a tail slice is not contiguous with the cursor, so digesting it would
   * step over what the fetch never returned.
   */
  digested: Envelope[];
  /** Unread this call rendered in neither form. Non-zero means the cursor stops short of them. */
  elided: number;
  /**
   * Message id to advance the read cursor to, or `null` to leave the cursor exactly where it is.
   * Always the end of the contiguous rendered prefix: never a row past one this call did not render.
   */
  advanceTo: string | null;
  /** `limit` that would show everything this call knows about (shown + digested + elided). */
  drainLimit: number;
}

/**
 * Decide what to show and whether the read cursor may advance.
 *
 * **The cursor never advances past an unread this call did not render.** That is not a new rule:
 * the CLI has held it since the bounded-window change and states it at `cli/src/commands/inbox.ts:20`.
 * This surface simply never had it, and this surface is the one every agent seat uses.
 *
 * What went wrong without it: the caller kept the newest `limit` of the unread set and then marked
 * the NEWEST message read. The cursor is a single `last_read_ts` watermark (`store/cursors.ts`), so
 * one call moved it past every older unread the slice had just discarded. Those messages were never
 * displayed and were never unread again. They are not destroyed — `unread_only: false` still
 * returns them — but a seat cannot go looking for a message whose existence it has no reason to
 * suspect, and `unread_only` defaults to true. Measured 2026-08-19: in its busiest 4-hour window
 * every seat on this team could see 163-186 messages against a default limit of 50.
 *
 * Newest-first is deliberately preserved — a seat that checks once a turn must not be handed the
 * stalest 50 and told the urgent ask is behind them. So the trade is made in the other direction:
 * when the view cannot be complete, the cursor holds and the reader is told the count. The failure
 * mode becomes seeing something twice, which costs a moment, instead of never seeing it, which
 * costs the work. The caller names `limit` as the way out, so a backlog still drains in one call.
 */
/**
 * Waiting acts the newest-N slice must not bury. Matches the CLI banner's `isActionNeeded`, minus
 * directed `message` — those stay newest-N so a mailbox of DMs does not explode the bound.
 */
function isPinnedNeed(env: Envelope): boolean {
  if (env.act === 'resolve') return false;
  if (env.act === 'request_help' || env.act === 'ask') return true;
  return env.to?.kind === 'member' && env.act !== 'message';
}

export function planInboxCheck(
  ordered: Envelope[],
  limit: number,
  /**
   * Unread the FETCH itself could not carry, as counted by the daemon. `ordered` stopped being proof
   * of how much is waiting once `GET /inbox` grew a default bound — a complete-looking slice can sit
   * on top of thousands the request never returned, and deriving elision from the slice alone would
   * advance the watermark past every one of them. Same rule as below, one layer further out.
   */
  unreachable = 0,
  /**
   * Ids this seat no longer owes (`answered` ∪ `discharged` from GET /inbox). They stay in the
   * unread pile until a drain that actually renders them (ADR 287) — they must not be pinned into
   * every bounded check, or a closed acceptance occupies the view forever while the cursor holds.
   */
  closed: readonly string[] = [],
): InboxCheckPlan {
  const closedSet = new Set(closed);
  const pinned = ordered.filter((e) => isPinnedNeed(e) && !closedSet.has(e.id));
  const rest = ordered.filter((e) => !isPinnedNeed(e) || closedSet.has(e.id));
  // Newest fill of the non-pinned tail, union the waiting acts. If the server already pinned, this
  // keeps the handoff when a second slice would otherwise drop it as the oldest of 51.
  const newest = rest.slice(Math.max(0, rest.length - limit));
  const byId = new Map<string, Envelope>();
  for (const e of newest) byId.set(e.id, e);
  for (const e of pinned) byId.set(e.id, e);
  // Receipt order — the order the cursor walks — so `advanceTo` is the furthest row actually shown.
  const shown = [...byId.values()].sort(
    (a, b) => envelopePosition(a) - envelopePosition(b) || a.id.localeCompare(b.id),
  );
  // The cursor may only walk a CONTIGUOUS prefix of the unread — the watermark is a single
  // position, so passing row k marks everything before k read whether or not it was rendered. With
  // a newest-N fill the rendered rows sit at the far end, so the prefix the cursor could walk was
  // empty and the cursor never moved (the treadmill). Render the prefix instead: the oldest rows not
  // already shown, in digest form, up to the cap. A row that IS shown (a pinned need) counts as
  // rendered and the walk continues through it. Only when the fetch was complete: a bounded fetch's
  // `ordered` begins somewhere after the cursor, not at it.
  const shownIds = new Set(shown.map((e) => e.id));
  const digested: Envelope[] = [];
  let prefixEnd = -1;
  if (unreachable === 0) {
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i]!;
      if (!shownIds.has(e.id)) {
        if (digested.length >= DIGEST_ROWS) break;
        digested.push(e);
      }
      prefixEnd = i;
    }
  }
  const elided = ordered.length - shown.length - digested.length + unreachable;
  return {
    shown,
    digested,
    elided,
    drainLimit: ordered.length + unreachable,
    // `null` on an empty inbox and on a bounded fetch — there is no contiguous rendered prefix to
    // advance over, and inventing one is exactly how a watermark passes something nobody read.
    advanceTo: prefixEnd < 0 ? null : ordered[prefixEnd]!.id,
  };
}

/** One line per digested row: enough to recognise it and to go and fetch it, nothing more. */
export function formatDigestLine(env: Envelope): string {
  const to =
    env.to.kind === 'member'
      ? `→ ${env.to.name}`
      : env.to.kind === 'team'
        ? '→ @team'
        : '→ @broadcast';
  const body = env.body.replace(/\s+/g, ' ').trim();
  const head = body.length > 96 ? `${body.slice(0, 95)}…` : body;
  return `  · ${env.from} [${env.act}] ${to}: ${head} (id=${env.id})`;
}

export function registerInboxCheck(server: McpServer, client: MusterdClient): void {
  server.registerTool(
    'team_inbox_check',
    {
      description: DESCRIPTION,
      inputSchema: {
        unread_only: z.boolean().default(true),
        limit: z.number().default(50),
      },
    },
    async (args) => {
      if (!client.holdsSeat) {
        return textResult(notReadyMessage(client, 'check your inbox'));
      }
      try {
        // Combine buffered live deliveries with the authoritative inbox fetch, dedup by id.
        const buffered = client.drainBuffer();
        const fetched = await client.fetchInbox(args.unread_only ?? true, args.limit ?? 50);
        const byId = new Map<string, Envelope>();
        for (const e of [...buffered, ...fetched.messages]) byId.set(e.id, e);
        const ordered = [...byId.values()].sort(
          (a, b) => envelopePosition(a) - envelopePosition(b) || a.id.localeCompare(b.id),
        );
        const closed = [
          ...(fetched.answered ?? []),
          ...(fetched.discharged ?? []).map((d) => d.id),
        ];
        const plan = planInboxCheck(
          ordered,
          args.limit ?? 50,
          fetched.unread_remaining ?? 0,
          closed,
        );
        const messages = plan.shown;

        if (messages.length === 0 && plan.elided === 0) {
          // ADR 287 stopped the cursor consuming what a call never rendered. A message it DID
          // render is the other case: the cursor passes it legitimately, and the only way back is
          // `unread_only: false` — a flag whose existence nothing advertised, so a seat could not
          // go looking for what it had no reason to think was reachable. An empty inbox is exactly
          // when a seat is hunting for something it lost, so the route is named here and only
          // here: the tool description is read every turn by every seat and is budgeted
          // (`pnpm context:check`), while this line costs bytes only when there is nothing else to
          // say. Omitted for a caller already reading everything — it would be advice to repeat
          // the call they just made.
          const recall =
            (args.unread_only ?? true)
              ? '\nlooking for one you already read? unread_only: false returns it'
              : '';
          // ADR 135: inbox-check is every agent's minute-0 call (the SessionStart hook routes here),
          // so a stale adapter learns about itself immediately — even on an empty inbox.
          return textResult(
            'no new messages — nothing waiting on you; check again at your next task boundary' +
              recall +
              (await syncWedgeWarningFor(client)) +
              (await buildSkewWarning(client)),
          );
        }
        // ADR 378: a turn carries no huddle meta of its own, so a threaded act is the ONLY hint that
        // this slice might be a room speaking. Pay for the timeline read exactly then — an inbox
        // with nothing threaded in it costs no extra request. A failed fetch degrades to the bare
        // messages this surface has always shown: a room is a nicety, an inbox is not.
        let context: RoomContext = { topics: new Map(), rooms: [] };
        if (messages.some((m) => m.thread)) {
          const timeline = await client
            .fetchMessages(HUDDLE_WINDOW)
            .then((r) => r.messages)
            .catch(() => [] as Envelope[]);
          context = roomsFor(messages, timeline, client.member ?? '');
        }

        // Link any sender trace context (meta.otel) to our trace as causality (ADR 011 receiver).
        linkReceived(messages);
        // Advance the cursor only over what this call actually rendered (ADR 287). On an elision
        // `advanceTo` is null and the watermark stays put, so the unread behind the limit are still
        // unread on the next call rather than consumed by a look that never showed them.
        if (plan.advanceTo !== null) {
          await client.markRead(plan.advanceTo).catch(() => undefined);
        }

        // ADR 254: the stand-down trace. An eligible-set act someone else already answered is no
        // longer this seat's to answer — but it still appears in the inbox, so saying nothing would
        // be the silent retirement the design rejected: the reader may be mid-draft, and would
        // neither know to stop nor get the chance to disagree with what landed. Rendered per act
        // rather than as a summary line so it sits with the question it retires.
        // Doorbell clause 7 widened this from "someone else answered" to three shapes, and only
        // one of them has a seat to name: (ii) the lane closed with nobody answering at all, and
        // (iv) this seat was already shown an act that has no answering move. Rendering "answered
        // by" for those would invent an answerer; rendering nothing would be the silent retirement
        // above, one shape further out. So the trace carries the REASON.
        const standDown = new Map((fetched.discharged ?? []).map((d) => [d.id, d] as const));
        const reasonOf = (d: { by?: string; reason?: string }) =>
          d.reason === 'lane_closed'
            ? 'the lane closed'
            : d.reason === 'read'
              ? 'you have already been shown this'
              : d.by
                ? `answered by ${d.by}`
                : 'answered';
        const line = (m: Envelope) => {
          const stand = standDown.get(m.id);
          // A turn says which room it is in, on its own line. Without this the reader has an opaque
          // `thread` and no reason to look further — the room block below is what it looks at.
          const topic = m.thread ? context.topics.get(m.thread) : undefined;
          return (
            formatMessage(m) +
            (topic ? `\n  ↳ in huddle ${topic}` : '') +
            (stand ? `\n  ↳ ${reasonOf(stand)} — you no longer owe this` : '')
          );
        };

        // Say it, and say it FIRST. An elision the reader is not told about is the same defect as
        // the silent cursor advance, one layer up: the view looks complete, so nothing prompts the
        // second call. Leading the output rather than trailing it because a seat that stops reading
        // after the last message is exactly the seat this line exists for. Since lane 01M2GT874Y
        // the line also says what the cursor DID pass — the digest below — so the reader knows the
        // remainder is one more ordinary check away, not a magic number away.
        const notice =
          plan.elided > 0
            ? `⚠ ${plan.elided} older unread not shown (limit ${args.limit ?? 50}). ` +
              (plan.digested.length > 0
                ? `The ${plan.digested.length} oldest are digested below and marked read; the rest ` +
                  `are still waiting — check again to keep draining, or pass limit: ` +
                  `${plan.drainLimit} to see all ${plan.drainLimit} now.\n\n`
                : `Nothing was marked read — they are still waiting. Call again with limit: ` +
                  `${plan.drainLimit} to see all ${plan.drainLimit}.\n\n`)
            : plan.digested.length > 0
              ? `ℹ ${plan.digested.length} older unread digested below and marked read.\n\n`
              : '';
        // The digest, after the full rows: the oldest unread this call walked the cursor over, one
        // line each. It reads as "what you missed while away", oldest first, and every id in it is
        // fetchable with `unread_only: false` if a line turns out to matter.
        const digest =
          plan.digested.length > 0
            ? `\n\n— ${plan.digested.length} older unread, now read (oldest first) —\n` +
              plan.digested.map(formatDigestLine).join('\n')
            : '';
        // The rooms, after the messages: the lines above say a turn arrived, these say what room it
        // arrived from and what has been said in it. Bounded by the slice — only rooms this call is
        // actually delivering from are described.
        const rooms =
          context.rooms.length > 0
            ? '\n\n' +
              context.rooms.map((h) => renderRoom(h, client.member ?? '')).join('\n\n') +
              '\n'
            : '';
        const text =
          notice +
          messages.map(line).join('\n') +
          digest +
          rooms +
          (await syncWedgeWarningFor(client)) +
          (await buildSkewWarning(client));
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            // Structured readers get the elision as data, not only as prose in `text`.
            elided_unread: plan.elided,
            // The rows the cursor walked over in digest form — ids only; the lines are in `text`.
            ...(plan.digested.length > 0
              ? { digested_unread: plan.digested.map((m) => m.id) }
              : {}),
            messages: messages.map((m) => ({
              id: m.id,
              from: m.from,
              act: m.act,
              body: m.body,
              ts: m.ts,
              thread: m.thread ?? null,
              meta: m.meta ?? null,
              // The topic on the message itself, so a structured reader can tell a turn from a
              // loose DM without joining against `huddles` by hand.
              ...(m.thread && context.topics.has(m.thread)
                ? { huddle_topic: context.topics.get(m.thread) }
                : {}),
              ...(standDown.has(m.id)
                ? {
                    // `discharged_by` stays the seat and ONLY the seat, so a structured reader that
                    // keyed on it never starts seeing a sentence in that field; the new shapes say
                    // why in `discharged_reason` instead.
                    ...(standDown.get(m.id)!.by ? { discharged_by: standDown.get(m.id)!.by } : {}),
                    discharged_reason: standDown.get(m.id)!.reason ?? 'answered',
                  }
                : {}),
            })),
            ...(context.rooms.length > 0 ? { huddles: context.rooms.map(roomStructured) } : {}),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
