import { withTraceContext } from '@musterd/mcp';
import {
  deriveHuddles,
  type Act,
  type HuddleMeta,
  type HuddleView,
  HUDDLE_TOPIC_KINDS,
  huddleBoardName,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { flagStr, type Parsed } from '../args.js';
import { readBindingAt } from '../config.js';
import { CliError } from '../errors.js';
import { renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { bindThread } from '../session/continuity.js';
import { findWorkspaceDir, kindLookup, resolve, sendOrEcho } from './helpers.js';
import { parseRecipients } from './send.js';

/**
 * `musterd huddle` — a huddle is a thread (ADR 378).
 *
 *   open   sends the root act with `meta.huddle` (topic, room, anchor, budget); the envelope id is
 *          the huddle id and the room is a whiteboard board named after it (ADR 330 shape).
 *   say    a turn: an ordinary act with `thread` = the huddle id.
 *   close  the `resolve`, naming where the anchor landed in `meta.anchor_ref`.
 *
 * The daemon learns nothing here — every command writes ordinary envelopes. The whiteboard room
 * is laid out best-effort over the service's localhost HTTP port when the service is already up;
 * it is never spawned from here and a huddle opens fine without it (the room URL is
 * deterministic, and the first `whiteboard_open` creates the board).
 */
const USAGE =
  'usage:\n' +
  '  musterd huddle list [--all]\n' +
  '  musterd huddle show <huddle-id>\n' +
  '  musterd huddle open --topic <goal|lane|design>:<id> --anchor <path|pr|lane> [--to a,b|@team] [--turns N] [--until <ms|ISO>] [--room <url>] "<why we are huddling>"\n' +
  '  musterd huddle say <huddle-id> [--act message|challenge|steer|insight] [--to <seat>] "<turn>"\n' +
  '  musterd huddle close <huddle-id> --anchor-ref <ref|none> "<what landed, or why nothing did>"';

const TURN_ACTS: ReadonlySet<Act> = new Set(['message', 'challenge', 'steer', 'insight', 'wait']);

export const DEFAULT_WHITEBOARD_PORT = 4851;
const ROOM_PROBE_MS = 500;

function whiteboardBase(): string {
  const port = Number(process.env['WHITEBOARD_PORT'] ?? DEFAULT_WHITEBOARD_PORT);
  return `http://127.0.0.1:${port}`;
}

export function parseTopic(raw: string | undefined): HuddleMeta['topic'] {
  if (!raw)
    throw new CliError(`--topic is required (${HUDDLE_TOPIC_KINDS.join('|')}:<id>)\n${USAGE}`, 2);
  const i = raw.indexOf(':');
  const kind = i < 0 ? raw : raw.slice(0, i);
  const id = i < 0 ? '' : raw.slice(i + 1);
  if (!(HUDDLE_TOPIC_KINDS as readonly string[]).includes(kind) || id.length === 0)
    throw new CliError(`--topic must be <${HUDDLE_TOPIC_KINDS.join('|')}>:<id>, got "${raw}"`, 2);
  return { kind: kind as HuddleMeta['topic']['kind'], id };
}

export function parseUntil(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new CliError(`--until must be epoch ms or an ISO date, got "${raw}"`, 2);
  return n;
}

/**
 * Lay the room out as a huddle: an "Anchor" cluster holding the anchor ref, a "Turns" cluster the
 * turns land in. Best-effort and bounded: a service that is not up is not an error and is not
 * spawned — the huddle is the thread, the board is a surface (ADR 378 §7).
 */
export async function layoutRoom(
  board: string,
  actor: string,
  opts: { anchor: string; topic: string; body: string },
): Promise<boolean> {
  const base = whiteboardBase();
  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(ROOM_PROBE_MS) });
    if (!health.ok) return false;
    const h = (await health.json()) as { service?: string };
    if (h.service !== 'agent-whiteboard') return false;
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ROOM_PROBE_MS * 4),
      });
    const opened = await post(`/api/boards/${board}/open`, {});
    if (!opened.ok) return false;
    const { created } = (await opened.json()) as { created: boolean };
    if (!created) return true; // laid out by an earlier open
    const res = await post(`/api/boards/${board}/add`, {
      actor: `seat:${actor}`,
      items: [
        { kind: 'cluster', title: 'Anchor', x: 100, y: 100 },
        {
          kind: 'note',
          text: opts.anchor.slice(0, 90),
          detail: `anchor — ${opts.anchor}`,
          x: 120,
          y: 160,
        },
        { kind: 'label', text: `huddle · ${opts.topic}`, x: 100, y: 40 },
        { kind: 'cluster', title: 'Turns', x: 600, y: 100 },
        { kind: 'note', text: opts.body.slice(0, 90), detail: opts.body, x: 620, y: 160 },
      ],
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Mirror a turn onto the board's Turns cluster, best-effort (same bounds as `layoutRoom`). */
export async function mirrorTurn(board: string, actor: string, body: string): Promise<boolean> {
  const base = whiteboardBase();
  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(ROOM_PROBE_MS) });
    if (!health.ok) return false;
    const res = await fetch(`${base}/api/boards/${board}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: `seat:${actor}`,
        items: [
          { kind: 'note', text: `${actor}: ${body}`.slice(0, 90), detail: body, x: 620, y: 260 },
        ],
      }),
      signal: AbortSignal.timeout(ROOM_PROBE_MS * 4),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * How far back a room view reads. A huddle is a bounded burst, so the recent window holds it; a
 * huddle older than this is history and belongs to whatever reads history (the wiki page it landed
 * on). Named rather than inlined so the bound is arguable instead of accidental.
 */
const TIMELINE_WINDOW = 1000;

function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Turns taken against turns declared — DISPLAY only; nobody enforces a budget (ADR 378 §4). */
function budgetLabel(h: HuddleView): string {
  const spent = h.turns.length;
  const declared = h.budget?.turns;
  const turns = declared ? `${spent}/${declared} turns` : `${spent} turn${spent === 1 ? '' : 's'}`;
  if (!h.budget?.until) return turns;
  const left = h.budget.until - Date.now();
  return `${turns} · ${left > 0 ? `${ago(Date.now() - left)} left`.replace(' ago', '') : 'past its time'}`;
}

function huddleSummary(h: HuddleView): string {
  const state = h.closed ? theme.meta('closed') : theme.ok('open');
  const last = h.turns.at(-1);
  return (
    `  ${theme.accent(h.id)}  ${h.topic}  ${state} ${theme.meta(`· ${budgetLabel(h)} · ` + (last ? `last ${ago(last.ts)}` : `opened ${ago(h.openedAt)}`))}\n` +
    `    ${theme.meta(`opened by ${h.opener} · in it: ${h.spoke.join(', ')}`)}`
  );
}

/** The room: who is in it, what has been said, what it is for, and how to answer. */
function renderHuddle(h: HuddleView, kindOf: (name: string) => 'agent' | 'human'): string {
  const out: string[] = [];
  const state = h.closed ? theme.meta('closed') : theme.ok('open');
  out.push(`${theme.accent(`huddle ${h.topic}`)} ${state} ${theme.meta(`· ${budgetLabel(h)}`)}`);
  out.push(`  ${theme.meta('id     ')} ${h.id}`);
  if (h.room) out.push(`  ${theme.meta('room   ')} ${h.room}`);
  if (h.anchor) out.push(`  ${theme.meta('anchor ')} ${h.anchor}`);
  // Named but silent is the useful distinction: it is who still owes the room a turn.
  const silent = h.named.filter((n) => !h.spoke.includes(n));
  out.push(
    `  ${theme.meta('in it  ')} ${h.spoke.map((n) => theme.memberName(n, kindOf(n))).join(', ')}` +
      (silent.length > 0 ? theme.meta(`  (yet to speak: ${silent.join(', ')})`) : ''),
  );
  out.push('');
  out.push(`  ${theme.memberName(h.opener, kindOf(h.opener))} ${theme.meta(ago(h.openedAt))}`);
  for (const line of wrapTurn(h.body)) out.push(line);
  for (const t of h.turns) {
    out.push('');
    out.push(
      `  ${theme.memberName(t.from, kindOf(t.from))} ${theme.actBadge(t.act)} ${theme.meta(ago(t.ts))}`,
    );
    for (const line of wrapTurn(t.body)) out.push(line);
  }
  out.push('');
  if (h.closed) {
    const ref = h.closed.anchorRef;
    out.push(
      theme.meta(
        `  closed by ${h.closed.by} ${ago(h.closed.at)} — ` +
          (ref && ref !== 'none' ? `landed at ${ref}` : 'nothing landed'),
      ),
    );
  } else {
    out.push(theme.meta(`  answer with: musterd huddle say ${h.id} "<turn>"`));
  }
  return out.join('\n');
}

function wrapTurn(body: string): string[] {
  return body
    .split('\n')
    .flatMap((line) => (line.length > 92 ? (line.match(/.{1,92}(\s|$)/g) ?? [line]) : [line]))
    .map((line) => `    ${line.trimEnd()}`);
}

export async function huddleCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub !== 'open' && sub !== 'say' && sub !== 'close' && sub !== 'show' && sub !== 'list')
    throw new CliError(USAGE, 2);
  const { team, identity, http } = resolve(parsed.flags);
  // Echo rows coloured by kind; the roster is best-effort for colour only.
  let kindOf = (_: string) => 'agent' as const;
  try {
    const roster = await http.roster(team);
    kindOf = kindLookup(roster.members) as typeof kindOf;
  } catch {
    // colour only
  }
  const json = parsed.flags['json'] === true;

  // The room as a VIEW over the log, not a second message system: a huddle is a thread, so the
  // transcript is rows the timeline already holds (ADR 378). Nothing is fetched per-huddle and
  // nothing is stored.
  if (sub === 'list' || sub === 'show') {
    const { messages } = await http.messages(team, { limit: TIMELINE_WINDOW });
    const huddles = deriveHuddles(messages, identity.name);

    if (sub === 'list') {
      const all = parsed.flags['all'] === true;
      const mine = huddles.filter((h) => (all || h.mine) && (all || !h.closed));
      if (json) {
        process.stdout.write(JSON.stringify({ huddles: mine }) + '\n');
        return 0;
      }
      if (mine.length === 0) {
        process.stdout.write(
          theme.meta(
            all
              ? 'no huddles in the recent timeline'
              : "no open huddles you are in — `musterd huddle list --all` shows everyone's, closed included",
          ) + '\n',
        );
        return 0;
      }
      process.stdout.write(
        `${theme.accent('huddles')} ${theme.meta(`· ${mine.length} ${all ? 'in the window' : 'you are in'}`)}\n\n`,
      );
      for (const h of mine) process.stdout.write(huddleSummary(h) + '\n');
      return 0;
    }

    const wanted = parsed.positionals[1];
    if (!wanted) throw new CliError(`name the huddle id\n${USAGE}`, 2);
    const view = huddles.find((h) => h.id === wanted || h.id.startsWith(wanted));
    if (!view) {
      throw new CliError(
        `no huddle ${wanted} in the recent timeline — \`musterd huddle list --all\` shows what is there`,
        4,
      );
    }
    if (json) {
      process.stdout.write(JSON.stringify(view) + '\n');
      return 0;
    }
    process.stdout.write(renderHuddle(view, kindOf) + '\n');
    return 0;
  }

  if (sub === 'open') {
    const body = parsed.positionals.slice(1).join(' ').trim();
    if (!body) throw new CliError(`say why you are huddling\n${USAGE}`, 2);
    const topic = parseTopic(flagStr(parsed.flags, 'topic'));
    const anchor = flagStr(parsed.flags, 'anchor');
    if (!anchor)
      throw new CliError(`--anchor is required (where the output will land)\n${USAGE}`, 2);
    const { to, eligible } = parseRecipients(flagStr(parsed.flags, 'to') ?? '@team');
    const id = ulid();
    const board = huddleBoardName(id);
    const room = flagStr(parsed.flags, 'room') ?? `${whiteboardBase()}/b/${board}`;
    const turnsRaw = flagStr(parsed.flags, 'turns');
    const turns = turnsRaw === undefined ? undefined : Number(turnsRaw);
    if (turns !== undefined && (!Number.isInteger(turns) || turns <= 0))
      throw new CliError(`--turns must be a positive integer, got "${turnsRaw}"`, 2);
    const until = parseUntil(flagStr(parsed.flags, 'until'));
    const budget =
      turns !== undefined || until !== undefined
        ? { ...(turns !== undefined ? { turns } : {}), ...(until !== undefined ? { until } : {}) }
        : undefined;
    const huddle: HuddleMeta = { topic, room, anchor, ...(budget ? { budget } : {}) };

    let envelope;
    try {
      envelope = makeEnvelope({
        id,
        team,
        from: identity.name,
        to,
        act: 'message',
        body,
        thread: null,
        meta: withTraceContext({ huddle, ...(eligible ? { eligible } : {}) }),
      });
    } catch (err) {
      throw new CliError(`invalid huddle: ${(err as Error).message}`, 3);
    }
    await sendOrEcho(() => http.send(team, envelope), envelope);
    bindOwnThread(team, identity.name, envelope.id);
    const laidOut = await layoutRoom(board, identity.name, {
      anchor,
      topic: `${topic.kind}:${topic.id}`,
      body,
    });

    if (json) {
      process.stdout.write(
        JSON.stringify({ ...envelope, huddle_id: id, room, room_laid_out: laidOut }) + '\n',
      );
      return 0;
    }
    process.stdout.write(renderMessageRow(envelope, kindOf) + '\n');
    process.stdout.write(`${theme.ok('✓')} huddle open — id ${id}\n`);
    process.stdout.write(
      `  room   ${room}${laidOut ? '' : theme.dim('  (whiteboard service not up; the board is created on first open)')}\n`,
    );
    process.stdout.write(`  anchor ${anchor}\n`);
    process.stdout.write(
      theme.dim(
        `  turns: musterd huddle say ${id} "<turn>"   close: musterd huddle close ${id} --anchor-ref <ref|none> "<what landed>"`,
      ) + '\n',
    );
    return 0;
  }

  const huddleId = parsed.positionals[1];
  if (!huddleId) throw new CliError(`name the huddle id\n${USAGE}`, 2);
  const body = parsed.positionals.slice(2).join(' ').trim();
  if (!body)
    throw new CliError(
      sub === 'say' ? `say something\n${USAGE}` : `say what landed, or why nothing did\n${USAGE}`,
      2,
    );
  const board = huddleBoardName(huddleId);

  if (sub === 'say') {
    const actRaw = flagStr(parsed.flags, 'act') ?? 'message';
    if (!TURN_ACTS.has(actRaw as Act))
      throw new CliError(`--act must be one of ${[...TURN_ACTS].join(', ')} for a turn`, 2);
    const act = actRaw as Act;
    const { to } = parseRecipients(flagStr(parsed.flags, 'to') ?? '@team');
    let envelope;
    try {
      envelope = makeEnvelope({
        id: ulid(),
        team,
        from: identity.name,
        to,
        act,
        body,
        thread: huddleId,
        meta: withTraceContext({}),
      });
    } catch (err) {
      throw new CliError(`invalid turn: ${(err as Error).message}`, 3);
    }
    await sendOrEcho(() => http.send(team, envelope), envelope);
    bindOwnThread(team, identity.name, huddleId);
    const mirrored = await mirrorTurn(board, identity.name, body);
    if (json) {
      process.stdout.write(JSON.stringify({ ...envelope, room_mirrored: mirrored }) + '\n');
      return 0;
    }
    process.stdout.write(renderMessageRow(envelope, kindOf) + '\n');
    process.stdout.write(`${theme.ok('✓')} turn in huddle ${huddleId}\n`);
    return 0;
  }

  // close
  const anchorRef = flagStr(parsed.flags, 'anchor-ref');
  if (!anchorRef)
    throw new CliError(`--anchor-ref is required: where the output landed, or "none"\n${USAGE}`, 2);
  let envelope;
  try {
    envelope = makeEnvelope({
      id: ulid(),
      team,
      from: identity.name,
      to: { kind: 'team' },
      act: 'resolve',
      body,
      thread: huddleId,
      meta: withTraceContext({ anchor_ref: anchorRef }),
    });
  } catch (err) {
    throw new CliError(`invalid close: ${(err as Error).message}`, 3);
  }
  await sendOrEcho(() => http.send(team, envelope), envelope);
  if (json) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return 0;
  }
  process.stdout.write(renderMessageRow(envelope, kindOf) + '\n');
  process.stdout.write(`${theme.ok('✓')} huddle ${huddleId} closed — anchor ${anchorRef}\n`);
  return 0;
}

/** ADR 210: a threaded send binds this session to the thread; best-effort, never fails the send. */
function bindOwnThread(team: string, seat: string, thread_id: string): void {
  try {
    const dir = findWorkspaceDir();
    const binding = dir ? readBindingAt(dir) : null;
    if (dir && binding?.session)
      bindThread(dir, { team, seat, thread_id, capture: binding.session, now: Date.now() });
  } catch {
    // the registry is an optimization
  }
}
