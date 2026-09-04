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

/** What one `team_inbox_check` should display, and how far the read cursor may move (ADR 287). */
export interface InboxCheckPlan {
  /** The messages to render — pinned waiting acts plus the newest fill, so relevance is unchanged. */
  shown: Envelope[];
  /** Unread this call could not show. Non-zero means the cursor must not move. */
  elided: number;
  /** Message id to advance the read cursor to, or `null` to leave the cursor exactly where it is. */
  advanceTo: string | null;
  /** `limit` that would show everything this call knows about (shown + elided). */
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
): InboxCheckPlan {
  const pinned = ordered.filter(isPinnedNeed);
  const rest = ordered.filter((e) => !isPinnedNeed(e));
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
  const elided = ordered.length - shown.length + unreachable;
  return {
    shown,
    elided,
    drainLimit: shown.length + elided,
    // `null` on an elision AND on an empty inbox — there is no id to advance to in either case, and
    // inventing one is exactly how a watermark passes something nobody read.
    advanceTo: elided > 0 || shown.length === 0 ? null : shown[shown.length - 1]!.id,
  };
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
        const plan = planInboxCheck(ordered, args.limit ?? 50, fetched.unread_remaining ?? 0);
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
        const dischargedBy = new Map((fetched.discharged ?? []).map((d) => [d.id, d.by]));
        const line = (m: Envelope) => {
          const by = dischargedBy.get(m.id);
          // A turn says which room it is in, on its own line. Without this the reader has an opaque
          // `thread` and no reason to look further — the room block below is what it looks at.
          const topic = m.thread ? context.topics.get(m.thread) : undefined;
          return (
            formatMessage(m) +
            (topic ? `\n  ↳ in huddle ${topic}` : '') +
            (by ? `\n  ↳ answered by ${by} — you no longer owe this` : '')
          );
        };

        // Say it, and say it FIRST. An elision the reader is not told about is the same defect as
        // the silent cursor advance, one layer up: the view looks complete, so nothing prompts the
        // second call. Leading the output rather than trailing it because a seat that stops reading
        // after the last message is exactly the seat this line exists for.
        const notice =
          plan.elided > 0
            ? `⚠ ${plan.elided} older unread not shown (limit ${args.limit ?? 50}). Nothing was ` +
              `marked read — they are still waiting. Call again with limit: ${plan.drainLimit} to ` +
              `see all ${plan.drainLimit}.\n\n`
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
          rooms +
          (await syncWedgeWarningFor(client)) +
          (await buildSkewWarning(client));
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            // Structured readers get the elision as data, not only as prose in `text`.
            elided_unread: plan.elided,
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
              ...(dischargedBy.has(m.id) ? { discharged_by: dischargedBy.get(m.id) } : {}),
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
