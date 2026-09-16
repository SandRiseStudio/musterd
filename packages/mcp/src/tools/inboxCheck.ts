import type { McpServer } from '@modelcontextprotocol/server';
import { envelopePosition, type Envelope } from '@musterd/protocol';
import { z } from 'zod';
import type { MusterdClient } from '../client.js';
import { linkReceived } from '../otel.js';
import {
  buildSkewOf,
  buildSkewWarning,
  provisioningDriftLine,
  driftUnreadableOf,
  provisioningDriftOf,
  formatMessage,
  syncWedgeOfClient,
  syncWedgeWarningFor,
  type ToolWarning,
  errorResult,
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
  'says how many remain. `ids` reads named acts back in full, clipped bodies included.';

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
 * exactly what ADR 287's rule protects.
 *
 * This is a ROW cap. It is not what keeps the reply inside the harness ceiling — `RESULT_BUDGET`
 * is (lane 01M2JZYTAH). It stays because it also bounds the drain to a handful of ordinary checks
 * rather than one giant one: 1300 behind clears in six.
 */
const DIGEST_ROWS = 250;

/**
 * The size contract, in characters, for everything one reply renders (lane 01M2JZYTAH).
 *
 * WHY THIS EXISTS AT ALL. Every other bound in this file is a ROW count, and rows are not what the
 * harness refuses. On 2026-09-15 miley started a session, ran one ordinary `team_inbox_check`, and
 * got no inbox: the harness rejected the whole result ("exceeds maximum allowed tokens") and wrote
 * it to a file, so the seat's first act of orientation returned a path. Measured on that payload —
 * 90 rows, 93,222 chars of BODY alone, 114,079 chars of structured content, median body 592, max
 * 4,593. No single monster act; the aggregate. Ten more such files sit in two seats' project dirs,
 * 63KB to 130KB, going back three weeks: this had been failing quietly on every seat for weeks,
 * and each time the seat either recovered by hand or oriented on a view it could not see.
 *
 * The header of this file used to assert the very thing it never enforced — "the tool-result
 * ceiling is ~70k chars; 50 full rows plus this many digest lines stays well under". It was false
 * at today's body sizes, and nothing measured it. A budget that is only a comment is not a budget.
 *
 * WHY THIS NUMBER. The real ceiling is token-based and differs by harness, so this is deliberately
 * conservative rather than tuned to the edge: ~30k chars is roughly 8k tokens, a quarter of the
 * smallest ceiling seen refusing a reply. Budget the SAFE side — the cost of being under is one
 * more ordinary check, and the cost of being over is the whole inbox, which is what was happening.
 * (falsify: `pnpm --filter @musterd/mcp exec vitest run src/tools/inboxCheck.budget.test.ts` —
 * the worst-case cases build 1500 unread at 5k bodies and assert the rendered reply fits.)
 */
export const RESULT_BUDGET = 30_000;

/**
 * How much of the budget the full rows may take before the digest gets the rest.
 *
 * Without this split a backlog of large acts spends the entire budget on `shown` and digests
 * nothing — which is the lane 01M2GT874Y treadmill returning by another door, this time for seats
 * whose teammates write long. The drain must always get room to walk the cursor.
 */
const SHOWN_BUDGET = Math.round(RESULT_BUDGET * 0.7);

/**
 * The most body one act may spend of a shared reply.
 *
 * Median body on this team is ~592 chars, so this leaves the ordinary act untouched and clips only
 * the long-form ones — the reviews and incident reports that are worth writing and are not worth
 * twenty other acts going unseen. A capped row is still a RENDERED row for ADR 287: it carries the
 * sender, act, id and the first ~1.2k of the body, strictly more than the digest line the rule
 * already treats as seen.
 */
export const BODY_CAP = 1_200;

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
 * One act, clipped to `BODY_CAP` and told where the rest is.
 *
 * Truncation is only honest if the remainder is reachable, and before this lane it was not: nothing
 * in the MCP surface or over HTTP could fetch a message by id (`GET /inbox` takes unread_only,
 * limit and since — nothing else). So the clip names the call that returns the whole act, and that
 * call is the `ids` input added alongside it.
 */
export function capBody(env: Envelope): Envelope {
  if (env.body.length <= BODY_CAP) return env;
  const dropped = env.body.length - BODY_CAP;
  return {
    ...env,
    body:
      `${env.body.slice(0, BODY_CAP)}…\n  [+${dropped} chars clipped — ` +
      `team_inbox_check {ids: ["${env.id}"]} for the whole act]`,
  };
}

/** What one rendered row costs the reply, as the tool will actually render it. */
function rowCost(env: Envelope): number {
  return formatMessage(env).length + 1;
}

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
  /**
   * The OLDEST unread, contiguous from the cursor — the server's prefix read (`headLimit`), fetched
   * alongside the tail. Empty when the caller could not get one, which degrades to the behaviour
   * below and holds the cursor.
   *
   * WHY THIS PARAMETER EXISTS. Lane 01M2GT874Y made the drain ordinary and proved it — against
   * arrays this function was handed whole. The tool never had one: `registerInboxCheck` always
   * names a `limit`, and a named `limit` selects the newest TAIL on the server (`listInbox`,
   * server/src/store/messages.ts:278), while the oldest-first prefix is served only to a caller
   * that names none (server/src/transport/http.ts:5590). A tail does not begin at the cursor, so
   * `unreachable` was non-zero on every check past the limit, the digest below never ran, and the
   * treadmill lane 01M2GT874Y closed was still turning — at the DEFAULT of 50, not at some far
   * backlog. Measured 2026-09-16 on this seat: two checks, zero rows walked (lane 01M2NGB60Q).
   *
   * The prefix is what makes the walk legal. `unreachable` still forbids inventing a prefix out of
   * a tail; it no longer forbids walking one the caller actually holds.
   */
  head: readonly Envelope[] = [],
): InboxCheckPlan {
  const closedSet = new Set(closed);
  const pinned = ordered.filter((e) => isPinnedNeed(e) && !closedSet.has(e.id));
  const rest = ordered.filter((e) => !isPinnedNeed(e) || closedSet.has(e.id));
  // Newest fill of the non-pinned tail, union the waiting acts. If the server already pinned, this
  // keeps the handoff when a second slice would otherwise drop it as the oldest of 51.
  const newest = rest.slice(Math.max(0, rest.length - limit));

  // Rows are DERIVED FROM THE BUDGET, never the other way round (lane 01M2JZYTAH). `limit` and the
  // pinned union above are both row counts, and neither bounds what the harness actually refuses:
  // one call rendered 90 rows against a limit of 50, because the waiting-act set is unioned on top
  // and has no cap of its own. Spend in priority order — waiting acts first (an ask nobody sees is
  // the worst thing to drop), then newest-first — so what survives a tight budget is what a seat
  // most needs. Every body is clipped as it is costed, so `shown` carries the clipped rows and the
  // structured content shrinks with the text rather than doubling it.
  const priority = [...pinned, ...[...newest].reverse()];
  const byId = new Map<string, Envelope>();
  let spent = 0;
  for (const e of priority) {
    if (byId.has(e.id)) continue;
    const capped = capBody(e);
    const cost = rowCost(capped);
    if (spent + cost > SHOWN_BUDGET && byId.size > 0) continue;
    byId.set(e.id, capped);
    spent += cost;
  }
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
  //
  // The digest is costed too. A row the budget cannot carry is NOT walked over — that is ADR 287
  // exactly as it reads for `limit`, applied to the other kind of bound.
  //
  // WHICH rows the walk may cross: `head` when the caller fetched the prefix, because it begins at
  // the cursor by construction whatever the fetch left behind; otherwise `ordered`, and only when
  // the fetch was complete (`unreachable === 0`) — a bounded fetch's `ordered` begins somewhere
  // after the cursor, and digesting its oldest rows would step over everything cut.
  const shownIds = new Set(shown.map((e) => e.id));
  const digested: Envelope[] = [];
  let prefixEnd = -1;
  const walk = head.length > 0 ? head : unreachable === 0 ? ordered : [];
  for (let i = 0; i < walk.length; i++) {
    const e = walk[i]!;
    if (!shownIds.has(e.id)) {
      if (digested.length >= DIGEST_ROWS) break;
      const cost = formatDigestLine(e).length + 1;
      if (spent + cost > RESULT_BUDGET) break;
      digested.push(e);
      spent += cost;
    }
    prefixEnd = i;
  }
  // A digested row drawn from the prefix may not be in `ordered` at all — it is one of the rows the
  // tail fetch left behind, and so is already counted inside `unreachable`. Either way it is now
  // rendered, so subtracting it once from the total is right in both cases.
  const elided = ordered.length - shown.length - digested.length + unreachable;
  return {
    shown,
    digested,
    elided,
    drainLimit: ordered.length + unreachable,
    // `null` on an empty inbox and on a bounded fetch — there is no contiguous rendered prefix to
    // advance over, and inventing one is exactly how a watermark passes something nobody read.
    advanceTo: prefixEnd < 0 ? null : walk[prefixEnd]!.id,
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
        // The retrieval path for a body the byte budget clipped (lane 01M2JZYTAH). Named rows only:
        // no cursor floor, no bounds, and the cursor does not move — the caller is re-reading
        // something it was already shown.
        ids: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      if (!client.holdsSeat) {
        return textResult(notReadyMessage(client, 'check your inbox'));
      }
      try {
        // `ids` is a re-read, not a check: the whole point is to un-clip a body this surface
        // already rendered in part, so it renders those acts WHOLE, marks nothing read and moves
        // no cursor. A clip that cannot be un-clipped is a loss rather than a deferral, which is
        // why this exists at all.
        if (args.ids !== undefined) {
          const { found, missing } = await client.readMessages(args.ids);
          const notFound =
            missing.length > 0
              ? `\n\n⚠ not found: ${missing.join(', ')} — either not addressed to you, or this ` +
                `daemon predates \`ids\` (restart the daemon, or read it with unread_only: false)`
              : '';
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  (found.length > 0
                    ? found.map((m) => formatMessage(m)).join('\n')
                    : 'no such act in your inbox') + notFound,
              },
            ],
            structuredContent: {
              messages: found.map((m) => ({
                id: m.id,
                from: m.from,
                act: m.act,
                body: m.body,
                ts: m.ts,
                thread: m.thread ?? null,
                meta: m.meta ?? null,
              })),
              ...(missing.length > 0 ? { not_found: missing } : {}),
            },
          };
        }
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
        // The fetch above is a TAIL — `limit` is always named, and a named limit means newest-N on
        // the server. A tail does not begin at the cursor, so on its own it can never be walked: the
        // drain lane 01M2GT874Y built ran on nothing for a seat past its limit, which is every seat
        // with a real backlog (lane 01M2NGB60Q). So when rows were left behind, ask for the PREFIX
        // as well — the same read with no `limit`, which the daemon answers oldest-first from the
        // cursor — and let the digest walk that. One extra request, and only when actually behind.
        //
        // A failure degrades to the tail alone: the cursor holds, which is exactly the behaviour
        // this call had before. An inbox that fits in the tail never pays for the round trip.
        const head =
          (fetched.unread_remaining ?? 0) > 0
            ? await client
                .fetchInbox(args.unread_only ?? true)
                .then((r) => r.messages)
                .catch(() => [] as Envelope[])
            : [];
        const plan = planInboxCheck(
          ordered,
          args.limit ?? 50,
          fetched.unread_remaining ?? 0,
          closed,
          head,
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
              (await buildSkewWarning(client)) +
              // ADR 408 inc 4: the same reasoning as the skew line above. A drifted workspace that
              // only ever gets told about itself on a BUSY inbox is told least often on the seat
              // that has the least going on — and an empty inbox is exactly the moment a seat has
              // room to run the repair.
              provisioningDriftLine(client.workspaceDir),
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
        // Name the bound that actually cut, not the one the caller passed. A reader told "limit 50"
        // when the BYTE budget did the cutting will raise the limit and get the same reply — the
        // advice has to match the mechanism or it sends them in a circle.
        const byBudget = plan.shown.length < Math.min(ordered.length, args.limit ?? 50);
        const notice =
          plan.elided > 0
            ? `⚠ ${plan.elided} older unread not shown (${byBudget ? `reply size — a bigger limit will not help; use ids: [...] to read named acts` : `limit ${args.limit ?? 50}`}). ` +
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
        // Built once and rendered twice: the prose keeps its exact wording for text-rendering
        // clients, and the same facts go into `structuredContent` for the ones that drop text.
        // Before lane 01M2NRYJEQ only the prose existed, so on this path — the non-empty one, the
        // only one a busy seat ever takes — a structuredContent-rendering harness was shown no
        // warning at all, and a session running stale tools looked identical to a fresh one.
        // The third member (ADR 408 inc 4) rides the SAME array rather than a key of its own: one
        // discriminator, one place a client looks. `provisioningDriftOf` only READS the cache the
        // CLI left in `.musterd/drift.json` — it never inspects the workspace on this seam, which a
        // busy seat takes many times a minute.
        // The fourth (lane 01M2NYV805) is the one that fires when the THIRD cannot speak:
        // `provisioningDriftOf` returns null for an absent, unparseable or clean cache alike, so a
        // seat whose record is missing reads exactly like a seat with nothing wrong. Only one of the
        // two can be non-null — an unreadable record yields no drift counts — so they never both
        // render.
        const warnings = [
          await syncWedgeOfClient(client),
          await buildSkewOf(client),
          provisioningDriftOf(client.workspaceDir),
          driftUnreadableOf(client.workspaceDir),
        ].filter((w): w is ToolWarning => w !== null);
        const text =
          notice +
          messages.map(line).join('\n') +
          digest +
          rooms +
          warnings.map((w) => `\n${w.text}`).join('');
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            ...(warnings.length > 0 ? { warnings } : {}),
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
