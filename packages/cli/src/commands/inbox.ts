import {
  envelopePosition,
  makeEnvelope,
  type DeferUntil,
  type Envelope,
  type MemberKind,
} from '@musterd/protocol';
import { resolveWorkspace } from '@musterd/protocol/project';
import { ulid } from 'ulid';
import { flagStr, type Parsed } from '../args.js';
import { watchClaim } from '../client.js';
import { wsBase, type Identity } from '../config.js';
import { CliError } from '../errors.js';
import { isActionNeeded, renderInbox, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { kindLookup, resolve, resolveRead } from './helpers.js';
import { waitingCommand } from './nudge.js';
import { attestSlotIfUnattested, refreshModelObservation } from './session.js';

/** Block-until-message exit code on timeout — mirrors coreutils `timeout(1)` so shell loops can tell
 *  "no message yet" from a real failure. Zero is reserved for "a directed act woke me". */
export const WAIT_TIMEOUT_EXIT = 124;
/** Default `--wait` bound (seconds): long enough to be a real event-wait, short enough that a dropped
 *  socket can't hang a `/loop` re-invoker forever (ADR 054). `--timeout 0` waits unbounded. */
const DEFAULT_WAIT_TIMEOUT_S = 300;
/** Default size of the bounded recent inbox view (ADR: elite inbox). `--limit 0` shows full history.
 *  All unread are always shown even when they exceed this — the read cursor never advances past an
 *  unread the view didn't render. */
const DEFAULT_INBOX_WINDOW = 15;

export async function inboxCommand(parsed: Parsed): Promise<number> {
  // --interrupt-check (ADR 088): the mid-loop interrupt line. A PostToolUse hook runs this at every
  // tool boundary, so it must be resolved *before* the acting `resolve()` below (which throws on an
  // ambient/unbound folder) and must be silent-or-one-line, best-effort, and never fail a tool call.
  if (parsed.flags['interrupt-check']) return interruptCheck(parsed);
  // --waiting (ADR 053): the read-only banner + the directed acts behind it, the approval-prompt
  // Notification hook target. Read-only, never moves the cursor, silent when nothing waits, exit 0
  // always — so it too must run before the acting `resolve()` below.
  if (parsed.flags['waiting']) return waitingCommand(parsed);

  // `musterd inbox defer <act_id> --until-lane <id> | --until-reply` (ADR 211 §6): the recipient's
  // "not now, raise it when ⟨cond⟩". The CLI takes the surface investment because ADR 145 §4 spends
  // surfaces before verbs — agents reach the same primitive through
  // `team_send {act:'wait', meta:{defer_ref, until}}`, so no new MCP tool is minted for it.
  if (parsed.positionals[0] === 'defer') return deferAct(parsed);

  const { config, team, identity, http } = resolve(parsed.flags);
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);
  // --all = the whole-team firehose (ADR 061): every envelope, not just my inbox.
  const all = Boolean(parsed.flags['all']);
  // --from/--act narrow the listing to one sender / one act type (ADR 067) — the papercut where a
  // directed act drowns in the journal. A lens, not a mutation: when a filter is active the read
  // cursor is left untouched (treated as a peek) so a narrowed view can't silently mark the rest read.
  const filter = { from: flagStr(parsed.flags, 'from'), act: flagStr(parsed.flags, 'act') };
  const filtering = Boolean(filter.from || filter.act);

  // --wait (ADR 054): block on the watch socket until the next directed act for this seat arrives,
  // then print it and exit 0 — the efficient, no-poll form of the wake-on-message pattern. Pairs with
  // a harness re-invoker (`/loop`): `musterd inbox --wait && <do the work>`.
  if (parsed.flags['wait']) {
    return waitInbox(parsed, http, config.server, team, identity, kindOf);
  }

  if (parsed.flags['watch']) {
    return watchInbox(parsed, http, config.server, team, identity, kindOf, all);
  }

  if (all) {
    const res = await http.messages(team, { limit: 200 });
    const messages = res.messages.filter((m) => matchesFilter(m, filter));
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(messages) + '\n');
      return 0;
    }
    process.stdout.write(
      `${theme.accent('firehose')} — ${team} (${messages.length} message${messages.length === 1 ? '' : 's'})\n`,
    );
    if (messages.length === 0) {
      process.stdout.write(theme.meta('no communication yet') + '\n');
      return 0;
    }
    for (const m of messages) process.stdout.write(renderMessageRow(m, kindOf) + '\n');
    process.stdout.write(
      theme.meta('musterd inbox --watch --all to follow the firehose live') + '\n',
    );
    return 0;
  }

  // --deferred (ADR 211 §5): the detail behind the footer count. A lens, like --from/--act: it never
  // advances the read cursor, so inspecting what you postponed cannot consume it.
  if (parsed.flags['deferred']) {
    const res = await http.inbox(team);
    const deferred = res.deferred ?? [];
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(deferred) + '\n');
      return 0;
    }
    process.stdout.write(
      `${theme.accent('deferred')} — ${team} ${theme.meta(`· ${deferred.length} postponed`)}\n`,
    );
    if (deferred.length === 0) {
      process.stdout.write(theme.meta('nothing deferred') + '\n');
      return 0;
    }
    for (const d of deferred) {
      const cond = 'reply' in d.until ? 'a reply on its thread' : `lane ${d.until.lane} moves`;
      const mark = d.raised ? theme.ok('● raised') : theme.meta('○ waiting');
      process.stdout.write(`  ${mark}  ${theme.accent(d.target)} ${theme.meta(`until ${cond}`)}\n`);
    }
    return 0;
  }

  const unread = Boolean(parsed.flags['unread']);
  // Window size (ADR: elite inbox): a bounded recent view by default so the inbox never floods the
  // terminal; `--limit <N>` resizes it, `--limit 0` shows the full history. `--all` is the separate
  // firehose scope (handled above), not this count.
  const limitStr = flagStr(parsed.flags, 'limit');
  const window = limitStr !== undefined ? Number(limitStr) : DEFAULT_INBOX_WINDOW;
  if (!Number.isInteger(window) || window < 0) {
    process.stderr.write(`${theme.err('✗')} --limit must be a non-negative integer\n`);
    return 2;
  }

  // The default is "recent window + ALL unread". The unread half is load-bearing for correctness: we
  // advance the read cursor past what we display, so a bounded view that hid an unread would silently
  // mark it read. Guarantee: if the oldest row in a bounded window is itself unread, there may be more
  // unread older than the window — refetch every unread and show those instead, so nothing is elided
  // and then consumed.
  // The daemon bounds a read that named no `limit` (it was the last unbounded one on the request
  // path), so "all unread are always shown" is only still true if we walk the pages. The bound is a
  // PREFIX, so paging forward on the last row's ts reaches every message in order and never steps
  // over one — the property the cursor rule above depends on.
  // Paging must REPEAT THE FIRST REQUEST, narrowed by `since` — never a fixed shape of its own. A
  // drain that always paged `{unread: true}` silently truncated every read that wasn't unread-only:
  // a full-history read (`--limit 0`, and any `--from`/`--act` lens) got the oldest-200 prefix plus
  // the unread tail, and everything between was dropped with nothing to say so. The prefix is what
  // makes walking safe; asking for a different slice on page two is what makes it lossy.
  const drain = async (
    opts: { unread?: boolean; limit?: number },
    first: Awaited<ReturnType<typeof http.inbox>>,
  ) => {
    const out = [...first.messages];
    let page = first;
    while (page.truncated && page.messages.length > 0) {
      page = await http.inbox(team, {
        ...opts,
        // Page in the order the daemon serves: receipt position, not the sender's ts.
        since: envelopePosition(page.messages[page.messages.length - 1]!),
      });
      out.push(...page.messages);
    }
    return out;
  };

  const bounded = window > 0 && !unread && !filtering;
  const query = unread ? { unread: true } : bounded ? { limit: window } : {};
  const res = await http.inbox(team, query);
  const cursorTs = res.cursor.last_read_ts;
  const total = res.total ?? res.messages.length;
  let rows = await drain(query, res);
  if (bounded && rows.length > 0 && envelopePosition(rows[0]!) > cursorTs) {
    rows = await drain({ unread: true }, await http.inbox(team, { unread: true }));
  }
  const messages = rows.filter((m) => matchesFilter(m, filter));

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(messages) + '\n');
    return 0;
  }

  const unreadCount = countUnread(messages, cursorTs, identity.name);
  const shown = messages.length;
  const ofTotal = !filtering && total > shown ? theme.meta(` · ${shown} of ${total}`) : '';
  process.stdout.write(
    `${theme.accent('inbox')} — ${team} ${theme.meta(`· ${unreadCount} unread`)}${ofTotal}\n`,
  );
  if (messages.length === 0) {
    process.stdout.write(theme.meta("inbox empty — nobody's mustered anything yet") + '\n');
    return 0;
  }
  // ADR 254: the stand-down trace, so an eligible-set act someone else already answered says so
  // instead of sitting there looking owed. Absent on an older daemon ⇒ an empty map ⇒ prior render.
  const discharged = new Map((res.discharged ?? []).map((d) => [d.id, d.by]));
  process.stdout.write('\n' + renderInbox(messages, kindOf, { cursorTs, discharged }) + '\n');

  // Advance the read cursor to the NEWEST UNREAD we actually displayed — never past an unshown unread
  // (the bounded-inbox invariant), and never at all when peeking or filtering (a lens must not consume).
  if (!parsed.flags['peek'] && !filtering) {
    const newestUnread = [...messages].reverse().find((m) => envelopePosition(m) > cursorTs);
    if (newestUnread) await http.markRead(team, newestUnread.id).catch(() => undefined);
  }
  // ADR 211 §5: ADR 117 requires the default view to include every unread, and a deferred act is
  // still unread. It is demoted to an honest footer line rather than hidden — the count is never
  // silently reduced, and a raised deferral says so, because that is the one a reader should act on.
  const deferred = res.deferred ?? [];
  if (deferred.length > 0) {
    const raised = deferred.filter((d) => d.raised).length;
    const line =
      raised > 0 ? `${deferred.length} deferred, ${raised} raised` : `${deferred.length} deferred`;
    process.stdout.write('\n' + theme.meta(`${line} — musterd inbox --deferred for detail`) + '\n');
  }

  const more = !filtering && total > shown ? 'musterd inbox --limit 0 for all history · ' : '';
  process.stdout.write('\n' + theme.meta(`${more}musterd inbox --watch to follow live`) + '\n');
  return 0;
}

/**
 * `musterd inbox defer <act_id> --until-lane <id> | --until-reply` (ADR 211 §6).
 *
 * Sends a deferring `wait` — the recipient's postponement. Exactly one condition: the two are
 * different questions ("blocked on that work" vs "waiting on that person"), and accepting both would
 * leave which one fires ambiguous. There is deliberately no duration form: ADR 179's doctrine is
 * that the daemon runs no clocks, so "later" is a state edge in this system.
 */
async function deferAct(parsed: Parsed): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    process.stderr.write(
      `${theme.err('✗')} musterd inbox defer <act_id> --until-lane <lane_id> | --until-reply\n`,
    );
    return 2;
  }
  const lane = flagStr(parsed.flags, 'until-lane');
  const reply = parsed.flags['until-reply'] === true;
  if ((lane === undefined) === !reply) {
    process.stderr.write(
      `${theme.err('✗')} name exactly one condition: --until-lane <lane_id> or --until-reply\n`,
    );
    return 2;
  }

  const { team, identity, http } = resolve(parsed.flags);
  const until: DeferUntil = reply ? { reply: true } : { lane: lane! };
  let envelope;
  try {
    envelope = makeEnvelope({
      id: ulid(),
      team,
      from: identity.name,
      to: { kind: 'team' },
      act: 'wait',
      body: 'deferred',
      meta: { defer_ref: target, until },
    });
  } catch (err) {
    throw new CliError(`invalid deferral: ${(err as Error).message}`, 3);
  }
  await http.send(team, envelope);
  process.stdout.write(
    `${theme.ok('✓')} deferred ${theme.accent(target)} until ${reply ? 'a reply on its thread' : `lane ${lane} moves`}\n`,
  );
  return 0;
}

/**
 * `musterd inbox --interrupt-check` (ADR 088) — the mid-loop interrupt line. A one-shot probe wired as
 * a PostToolUse hook: at every tool boundary it asks the daemon whether an interrupt-class (urgent,
 * directed) act is waiting, and prints **one daemon-composed line** if so, nothing otherwise. The
 * scarce, injection-safe extension of the ADR 046 per-command nudge from "musterd commands only" to
 * "every tool call the agent makes."
 *
 * Read-only and best-effort by construction, exactly like {@link nudgeCommand}: it never advances the
 * read cursor (reading is the agent's explicit follow-up `musterd inbox`), any failure is swallowed and
 * exits 0 (a probe on every tool call must never disrupt the loop), it needs an explicit bound seat
 * (an ambient folder has no inbox to interrupt), and it honours `MUSTERD_NO_NUDGE=1`. The daemon owns
 * the predicate, the capability gate, the composed line, and the audit/telemetry — the CLI just prints.
 */
async function interruptCheck(parsed: Parsed): Promise<number> {
  // The tool boundary is also the first moment the running model is *knowable* — the transcript now
  // carries an assistant turn, which it did not when SessionStart observed (ADR 158 follow-up). Runs
  // before the env/identity gates below: the observation is local and is owed even to a seat whose
  // daemon is unreachable or whose nudges are muted. Self-guarded, silent, never throws.
  refreshModelObservation();
  // …and the first moment a slot SessionStart never announced can still be announced (lane
  // 01M159BHJK). Sits beside the observation for the same reason and under the same contract: both
  // are local truths the seat OWES the daemon, both are silent and self-guarded, and both are due
  // even to a seat whose nudges are muted — so this runs before the MUSTERD_NO_NUDGE gate below.
  // One push per session, not per tool call: the slot's `attested_at` stamp is what bounds it.
  await attestSlotIfUnattested();
  if (process.env['MUSTERD_NO_NUDGE'] === '1') return 0;
  try {
    // The interrupt probe is hook-installed and rides every tool call — it takes the default (no
    // reclaim) for the same reason `gate check` does.
    const { http, team, identity, explicit } = resolveRead(parsed.flags);
    if (!explicit || !identity) return 0;
    const res = await http.interruptCheck(team);
    if (res.raised && res.line) process.stdout.write(res.line + '\n');
  } catch {
    // Best-effort: the interrupt probe must never fail the tool call it rides on.
  }
  return 0;
}

function countUnread(messages: Envelope[], cursorTs: number, _self: string): number {
  return messages.filter((m) => envelopePosition(m) > cursorTs).length;
}

/** `inbox --from <name>` / `--act <act>` narrowing (ADR 067): keep only matching senders/act types. */
function matchesFilter(
  env: Envelope,
  filter: { from?: string | undefined; act?: string | undefined },
): boolean {
  if (filter.from && env.from !== filter.from) return false;
  if (filter.act && env.act !== filter.act) return false;
  return true;
}

async function watchInbox(
  parsed: Parsed,
  http: ReturnType<typeof resolve>['http'],
  server: string,
  team: string,
  identity: Identity,
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
    const session = watchClaim({
      wsUrl: wsBase(server) + '/ws',
      team,
      // v0.3 (ADR 075): a watch IS a claim — attach by claiming our own seat with the Bearer key.
      key: identity.key,
      target: { seat: identity.name },
      ...(identity.grant !== undefined ? { grant: identity.grant } : {}),
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

/**
 * Does `env` wake a `--wait`? A **directed act for this seat** by default (broadcast journal traffic
 * shouldn't wake a waiting agent — ADR 054), never the seat's own send, optionally narrowed by
 * `--from`/`--act`. The same directed-to-me notion `isActionNeeded` uses, minus request_help-to-team.
 */
function wakesWait(
  env: Envelope,
  me: string,
  filter: { from?: string | undefined; act?: string | undefined },
): boolean {
  if (env.from === me) return false; // never wake on my own echo
  if (!(env.to.kind === 'member' && env.to.name === me)) return false;
  if (filter.from && env.from !== filter.from) return false;
  if (filter.act && env.act !== filter.act) return false;
  return true;
}

/**
 * `musterd inbox --wait` (ADR 054): a blocking one-shot consumer of the watch socket. Rides the same
 * push `--watch` uses, but exits on the **first directed act** for this seat instead of streaming —
 * exit 0 on a message, {@link WAIT_TIMEOUT_EXIT} on timeout. It first drains the durable inbox so a
 * message that landed *just before* the wait started (the startup race) isn't missed.
 */
async function waitInbox(
  parsed: Parsed,
  http: ReturnType<typeof resolve>['http'],
  server: string,
  team: string,
  identity: Identity,
  kindOf: (name: string) => MemberKind,
): Promise<number> {
  const json = Boolean(parsed.flags['json']);
  const peek = Boolean(parsed.flags['peek']);
  const filter = { from: flagStr(parsed.flags, 'from'), act: flagStr(parsed.flags, 'act') };
  const timeoutRaw = flagStr(parsed.flags, 'timeout');
  const timeoutS = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_WAIT_TIMEOUT_S;
  if (Number.isNaN(timeoutS) || timeoutS < 0) {
    process.stderr.write(`${theme.err('✗')} --timeout must be a non-negative number of seconds\n`);
    return 2;
  }

  // Emit a matched act and consume it (advance the read cursor unless --peek), then exit 0.
  const deliver = async (env: Envelope): Promise<number> => {
    process.stdout.write((json ? JSON.stringify(env) : renderMessageRow(env, kindOf)) + '\n');
    if (!peek) await http.markRead(team, env.id).catch(() => undefined);
    return 0;
  };

  // The earliest unread act that should wake this wait, if any.
  const findPending = async (): Promise<Envelope | undefined> => {
    const pending = await http.inbox(team, { unread: true }).catch(() => undefined);
    if (!pending) return undefined;
    return pending.messages.find(
      (m) =>
        envelopePosition(m) > pending.cursor.last_read_ts && wakesWait(m, identity.name, filter),
    );
  };

  // Startup-race guard: a directed act may have landed between the last check and this wait. Drain the
  // durable inbox first and wake immediately on the earliest unread match, before opening the socket.
  const startupHit = await findPending();
  if (startupHit) return deliver(startupHit);

  return new Promise<number>((resolveP) => {
    let done = false;
    const finish = (code: number, after?: () => Promise<void>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      session.close();
      const tail = after ? after() : Promise.resolve();
      void tail.then(() => resolveP(code));
    };

    const timer =
      timeoutS > 0
        ? setTimeout(() => {
            process.stderr.write(theme.meta(`no directed act within ${timeoutS}s`) + '\n');
            finish(WAIT_TIMEOUT_EXIT);
          }, timeoutS * 1000)
        : undefined;

    const session = watchClaim({
      wsUrl: wsBase(server) + '/ws',
      team,
      // v0.3 (ADR 075): attach by claiming our own seat with the Bearer key.
      key: identity.key,
      target: { seat: identity.name },
      ...(identity.grant !== undefined ? { grant: identity.grant } : {}),
      surface: identity.surface || 'cli',
      // A waiting agent is genuinely here and reachable — a resident session, like `--watch`.
      provenance: 'session',
      workspace: resolveWorkspace(),
      scope: 'team',
      // Close the startup gap. The drain above ran BEFORE this socket existed, so an act that landed
      // between the two was caught by neither — the drain had already run and no subscription yet
      // existed to push it. The act was never lost (it stays durably unread, and the next `--wait`
      // finds it), but this wait would sit until its deadline and exit as if nothing had arrived,
      // which reads as a broken interrupt line. watchClaim subscribes before invoking this, so
      // anything newer than this second drain arrives on the socket instead. `finish` is idempotent,
      // so an act caught by both paths still wakes exactly once.
      onOccupied: () => {
        void findPending().then((env) => {
          if (env && !done) finish(0, async () => void (await deliver(env)));
        });
      },
      onDeliver: (env) => {
        if (done || !wakesWait(env, identity.name, filter)) return;
        finish(0, async () => {
          await deliver(env);
        });
      },
      onError: (msg) => {
        // A dropped/refused socket shouldn't hang the wait — surface it and let an outer loop re-enter.
        process.stderr.write(`${theme.err('✗')} ${msg}\n`);
        finish(WAIT_TIMEOUT_EXIT);
      },
    });

    process.on('SIGINT', () => finish(WAIT_TIMEOUT_EXIT));
  });
}
