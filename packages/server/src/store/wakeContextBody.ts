import type { WakeContextContext, WakeContextFetch, WakeContextOpenItem } from '@musterd/protocol';
import { WAKE_CONTEXT_BUDGET as B } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getLane } from './lanes.js';
import { getMemberById } from './members.js';
import { getMemory } from './memory.js';
import type { MemberRow, MessageRow } from './rows.js';

/**
 * ADR 430 — the v2 `context` block: what a seat woken cold is handed so it has what a resume would
 * have given it. Derived at read time from canonical rows and fitted to the budget in the spec's
 * fill order (memory → thread → lane → open). Every act body is attributed to its sender and thread;
 * the ledger carries titles only. Nothing here is stored — the packet is a projection, not a second
 * home for Team facts (ADR 209).
 */
export interface DeriveTarget {
  /** The waking thread's root id — the act itself when it started the thread. */
  threadId?: string;
  laneId?: string;
}

export interface DerivedContext {
  context: WakeContextContext;
  /** UTF-8 bytes of `JSON.stringify(context)` — what `budget.used_bytes` reports. */
  used_bytes: number;
  /** v2 meaning of `fetch`: only what was truncated or omitted. */
  fetch: WakeContextFetch[];
  stats: {
    thread_acts: number;
    omitted: number;
    bytes: Record<'memory' | 'thread' | 'lane' | 'open', number>;
  };
}

export function truncateChars(s: string, max: number): { text: string; truncated: boolean } {
  return s.length <= max
    ? { text: s, truncated: false }
    : { text: s.slice(0, max), truncated: true };
}

/** Cut on a UTF-8 byte budget without splitting a multi-byte sequence. */
export function truncateBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false };
  const buf = Buffer.from(s, 'utf8').subarray(0, max);
  let end = buf.length;
  // Continuation bytes are 10xxxxxx; walk back over them, then over the lead byte they belonged to.
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && (buf[end - 1]! & 0xc0) === 0xc0) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** The acts that ask something of their recipient — the ledger's directed half (ADR 429's list). */
const OPEN_ACTS = ['ask', 'request_help', 'handoff'] as const;
const TITLE_CHARS = 120;

export function deriveContext(
  db: Database,
  team: { id: string; slug: string },
  recipient: MemberRow,
  target: DeriveTarget,
): DerivedContext {
  const fetch: WakeContextFetch[] = [];
  const bytes = { memory: 0, thread: 0, lane: 0, open: 0 };
  const context: WakeContextContext = { open: [] };
  const names = new Map<string, string>();
  const nameOf = (memberId: string): string => {
    const hit = names.get(memberId);
    if (hit !== undefined) return hit;
    const name = getMemberById(db, memberId)?.name ?? memberId;
    names.set(memberId, name);
    return name;
  };

  // 1. memory — the seat's own note, whole when it fits (≤ 3,072 bytes)
  const memory = getMemory(db, recipient.id);
  if (memory) {
    const cut = truncateBytes(memory.body, B.memory);
    context.memory = { body: cut.text, truncated: cut.truncated };
    if (cut.truncated) fetch.push('seat_memory');
    bytes.memory = bytesOf(context.memory);
  }

  // 2. thread — the last 8 acts of the waking thread, oldest first (≤ 6,144 bytes)
  if (target.threadId !== undefined) {
    const rows = db
      .prepare<
        [string, string, string],
        MessageRow
      >(`SELECT * FROM messages WHERE team_id = ? AND (id = ? OR thread_id = ?) ORDER BY ts DESC`)
      .all(team.id, target.threadId, target.threadId);
    let acts = rows
      .slice(0, B.thread_acts)
      .reverse()
      .map((r) => {
        const cut = truncateChars(r.body, B.act_body_chars);
        return {
          id: r.id,
          from: nameOf(r.from_member),
          act: r.act,
          ts: r.ts,
          body: cut.text,
          truncated: cut.truncated,
        };
      });
    let omitted = rows.length - acts.length;
    // Drop the OLDEST first — the newest act is why the seat is awake.
    while (acts.length > 1 && bytesOf({ acts, omitted }) > B.thread) {
      acts = acts.slice(1);
      omitted++;
    }
    context.thread = { acts, omitted };
    if (omitted > 0) fetch.push('inbox_thread');
    bytes.thread = bytesOf(context.thread);
  }

  // 3. lane — its detail and the seat's own last word on it (≤ 1,536 bytes)
  if (target.laneId !== undefined) {
    const lane = getLane(db, team.id, target.laneId, team.slug);
    if (lane) {
      const detail = truncateChars(lane.detail ?? '', B.lane_detail_chars);
      const last = db
        .prepare<[string, string, string], MessageRow>(
          `SELECT * FROM messages WHERE team_id = ? AND from_member = ? AND act = 'status_update'
             AND instr(body, ?) > 0 ORDER BY ts DESC LIMIT 1`,
        )
        .get(team.id, recipient.id, lane.id);
      const status = last ? truncateChars(last.body, B.act_body_chars) : undefined;
      context.lane = {
        detail: detail.text,
        truncated: detail.truncated,
        ...(last && status
          ? { last_status_update: { ts: last.ts, body: status.text, truncated: status.truncated } }
          : {}),
      };
      if (bytesOf(context.lane) > B.lane) {
        delete context.lane.last_status_update;
        context.lane.detail = truncateChars(
          context.lane.detail,
          Math.floor(B.lane_detail_chars / 2),
        ).text;
        context.lane.truncated = true;
      }
      if (context.lane.truncated) fetch.push('lane_detail');
      bytes.lane = bytesOf(context.lane);
    }
  }

  // 4. open ledger — what else is waiting on this seat, oldest first (≤ 12 items, ≤ 2,048 bytes)
  const now = Date.now();
  const directed = db
    .prepare<[string, string, ...string[]], MessageRow>(
      `SELECT m.* FROM messages m
        WHERE m.team_id = ? AND m.to_kind = 'member' AND m.to_member = ?
          AND m.act IN (${OPEN_ACTS.map(() => '?').join(',')})
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.from_member = m.to_member
               AND (r.thread_id = m.id OR (m.thread_id IS NOT NULL AND r.thread_id = m.thread_id))
          )
        ORDER BY m.ts ASC`,
    )
    .all(team.id, recipient.id, ...OPEN_ACTS);
  const items: WakeContextOpenItem[] = directed.map((r) => {
    const meta = JSON.parse(r.meta ?? '{}') as { lane_review?: unknown; lane_handoff?: unknown };
    const kind: WakeContextOpenItem['kind'] = meta.lane_review
      ? 'review'
      : meta.lane_handoff || r.act === 'handoff'
        ? 'handoff'
        : (r.act as 'ask' | 'request_help');
    return {
      kind,
      id: r.id,
      from: nameOf(r.from_member),
      title: truncateChars(r.body.split('\n')[0] ?? '', TITLE_CHARS).text,
      age_ms: Math.max(0, now - r.ts),
    };
  });
  const lanes = db
    .prepare<[string, string], { id: string; title: string; created_at: number }>(
      `SELECT id, title, created_at FROM lanes
        WHERE team_id = ? AND owner_seat = ? AND state IN ('claimed','active','blocked')
        ORDER BY created_at ASC`,
    )
    .all(team.id, recipient.name);
  for (const l of lanes)
    items.push({
      kind: 'lane',
      id: l.id,
      title: truncateChars(l.title, TITLE_CHARS).text,
      age_ms: Math.max(0, now - l.created_at),
    });
  const total = items.length;
  let open = items.slice(0, B.open_items);
  while (open.length > 0 && bytesOf(open) > B.open) open = open.slice(0, -1);
  context.open = open;
  if (open.length < total) fetch.push('open_items');
  bytes.open = bytesOf(context.open);

  // 5. the whole-block cap — the fill order above makes the ledger the first casualty, the lane next
  let used = bytesOf(context);
  if (used > B.limit_bytes && context.open.length > 0) {
    context.open = [];
    if (!fetch.includes('open_items')) fetch.push('open_items');
    used = bytesOf(context);
  }
  if (used > B.limit_bytes && context.lane) {
    delete context.lane;
    if (!fetch.includes('lane_detail')) fetch.push('lane_detail');
    used = bytesOf(context);
  }

  return {
    context,
    used_bytes: used,
    fetch,
    stats: {
      thread_acts: context.thread?.acts.length ?? 0,
      omitted: context.thread?.omitted ?? 0,
      bytes,
    },
  };
}
