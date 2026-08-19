import type { McpServer } from '@modelcontextprotocol/server';
import type { Envelope } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { linkReceived } from '../otel.js';
import {
  buildSkewWarning,
  errorResult,
  formatMessage,
  notReadyMessage,
  textResult,
} from './format.js';

// Length is gated (`pnpm context:check`, standing-context budgets): this string is in every turn's
// tool list, so the elision contract is stated in the fewest bytes that still state it. The full
// reasoning lives in ADR 287; the runtime notice carries the detail at the moment it matters.
const DESCRIPTION =
  'Check unread addressed to you or the team, marking them read. Call at task start, ' +
  'task end, and after heads-down work. Past `limit` nothing is marked read; the reply ' +
  'says how many remain.';

/** What one `team_inbox_check` should display, and how far the read cursor may move (ADR 287). */
export interface InboxCheckPlan {
  /** The messages to render — the newest `limit`, so relevance is unchanged. */
  shown: Envelope[];
  /** Unread this call could not show. Non-zero means the cursor must not move. */
  elided: number;
  /** Message id to advance the read cursor to, or `null` to leave the cursor exactly where it is. */
  advanceTo: string | null;
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
export function planInboxCheck(ordered: Envelope[], limit: number): InboxCheckPlan {
  // Keep the NEWEST `limit` (an inbox is read most-recent-first), not the OLDEST N that a bare
  // `.sort().slice(0, limit)` would keep once the inbox exceeds the cap.
  const shown = ordered.slice(Math.max(0, ordered.length - limit));
  const elided = ordered.length - shown.length;
  return {
    shown,
    elided,
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
        const fetched = await client.fetchInbox(args.unread_only ?? true);
        const byId = new Map<string, Envelope>();
        for (const e of [...buffered, ...fetched.messages]) byId.set(e.id, e);
        const ordered = [...byId.values()].sort((a, b) => a.ts - b.ts);
        const plan = planInboxCheck(ordered, args.limit ?? 50);
        const messages = plan.shown;

        if (messages.length === 0) {
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
              (await buildSkewWarning(client)),
          );
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
          return formatMessage(m) + (by ? `\n  ↳ answered by ${by} — you no longer owe this` : '');
        };

        // Say it, and say it FIRST. An elision the reader is not told about is the same defect as
        // the silent cursor advance, one layer up: the view looks complete, so nothing prompts the
        // second call. Leading the output rather than trailing it because a seat that stops reading
        // after the last message is exactly the seat this line exists for.
        const notice =
          plan.elided > 0
            ? `⚠ ${plan.elided} older unread not shown (limit ${args.limit ?? 50}). Nothing was ` +
              `marked read — they are still waiting. Call again with limit: ${ordered.length} to ` +
              `see all ${ordered.length}.\n\n`
            : '';
        const text = notice + messages.map(line).join('\n') + (await buildSkewWarning(client));
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
              ...(dischargedBy.has(m.id) ? { discharged_by: dischargedBy.get(m.id) } : {}),
            })),
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
