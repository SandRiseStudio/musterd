import { deriveHuddles, type Envelope, type HuddleView } from '@musterd/protocol';

/**
 * The room, as an agent reads it (ADR 378 increment 3).
 *
 * The huddle was built for the surface HUMANS use, and the participants are agents — that asymmetry
 * is the whole gap. On this surface a turn arrived as a bare message with an opaque `thread`: no
 * topic, no idea who else was in the room, no way back to what had already been said, and nothing
 * saying how to answer. Exactly the flat list the CLI's room view stopped being.
 *
 * WHY THIS IS A FIELD AND NOT A `team_huddle` TOOL. ADR 144 makes the tool list a budget, not a
 * catalogue, and a tool earns its place by being SELECTABLE: an agent must be able to want it
 * before it knows the answer. Reading a huddle is never that. A huddle reaches an agent exactly one
 * way — a turn lands in its inbox — so the read belongs at the arrival, where the reader already
 * is, not behind a name it would have to think to call. The measured cost points the same way: a
 * tool costs its name, description and schema in EVERY seat's tool list on EVERY turn forever
 * (`pnpm context:check`; muted headroom was 383 B when this was written), while this costs bytes
 * only in the calls that actually carry a turn.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: browse a room you have no unread in. `musterd huddle list`
 * does that for a human, and it has no counterpart here. If a seat is ever seen wanting the room it
 * is NOT being spoken to in, that is the evidence for a tool — and this note is the record that the
 * absence was chosen rather than missed.
 */

/** Turns shown per room. A huddle is a bounded burst; the tail is what a re-reader needs. */
export const ROOM_TURNS = 6;
/** Per-turn body bound — enough to know what was said, not the whole essay. */
const TURN_BODY = 240;

export interface RoomContext {
  /** Thread id → topic label, for marking a turn's own line in the inbox. */
  topics: Map<string, string>;
  /** The rooms the shown messages belong to, newest first. */
  rooms: HuddleView[];
}

function clip(body: string, max = TURN_BODY): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The rooms `shown` touches, folded out of `timeline`.
 *
 * `shown` decides WHICH rooms are relevant (the ones this call is delivering a turn or an opening
 * from); `timeline` supplies the rows — the root that names the topic, and the turns already read.
 * A huddle whose root is outside the window is not a room this call can describe honestly, so it is
 * left as the bare message it always was rather than half-labelled.
 */
export function roomsFor(shown: Envelope[], timeline: Envelope[], me: string): RoomContext {
  // The timeline is authoritative for the fold, but a live-buffered turn can be newer than the
  // window the daemon returned — union so a just-delivered turn is never missing from its own room.
  const byId = new Map<string, Envelope>();
  for (const e of [...timeline, ...shown]) byId.set(e.id, e);
  const all = deriveHuddles([...byId.values()], me);

  const relevant = new Set<string>();
  for (const m of shown) {
    if (m.thread) relevant.add(m.thread);
    relevant.add(m.id);
  }
  const rooms = all.filter((h) => relevant.has(h.id) || h.turns.some((t) => relevant.has(t.id)));
  const topics = new Map<string, string>();
  for (const h of rooms) topics.set(h.id, h.topic);
  return { topics, rooms };
}

/**
 * One room as prose: what it is for, who is in it, what has been said, and the exact call that
 * answers in it. The answer line is the point — a reader that cannot act on what it just read is
 * back where it started.
 */
export function renderRoom(h: HuddleView, me: string): string {
  const out: string[] = [];
  const state = h.closed ? 'closed' : 'open';
  const spent = h.turns.length;
  const budget = h.budget?.turns ? `${spent}/${h.budget.turns} turns` : `${spent} turns`;
  out.push(`huddle ${h.topic} — ${state} · ${budget} · id ${h.id}`);
  out.push(`  for: ${clip(h.body, 200)}`);
  const silent = h.named.filter((n) => !h.spoke.includes(n));
  out.push(
    `  in it: ${h.spoke.join(', ')}` +
      (silent.length > 0 ? ` (yet to speak: ${silent.join(', ')})` : ''),
  );
  if (h.anchor) out.push(`  anchor: ${h.anchor}${h.room ? ` · room: ${h.room}` : ''}`);

  const tail = h.turns.slice(-ROOM_TURNS);
  const dropped = h.turns.length - tail.length;
  if (dropped > 0) out.push(`  … ${dropped} earlier turn${dropped === 1 ? '' : 's'} not shown`);
  out.push(`  ${h.opener}: ${clip(h.body)}`);
  for (const t of tail) out.push(`  ${t.from} [${t.act}]: ${clip(t.body)}`);

  if (h.closed) {
    const ref = h.closed.anchorRef;
    out.push(
      `  closed by ${h.closed.by} — ${ref && ref !== 'none' ? `landed at ${ref}` : 'nothing landed'}`,
    );
  } else {
    // Named for `me` because a turn is a send like any other: the thread is what makes it a turn,
    // and it is the one field a reader would not guess from the message it just received.
    out.push(`  answer in it: team_send {thread: "${h.id}", body: "<your turn>"}`);
    if (!h.spoke.includes(me) && h.named.includes(me))
      out.push(`  you are named here and have not spoken`);
  }
  return out.join('\n');
}

/** The structured shape a programmatic reader gets per room — the prose above, as data. */
export function roomStructured(h: HuddleView): Record<string, unknown> {
  return {
    id: h.id,
    topic: h.topic,
    room: h.room,
    anchor: h.anchor,
    opener: h.opener,
    opened_at: h.openedAt,
    body: h.body,
    in_it: h.spoke,
    yet_to_speak: h.named.filter((n) => !h.spoke.includes(n)),
    turn_count: h.turns.length,
    turns: h.turns.slice(-ROOM_TURNS).map((t) => ({
      id: t.id,
      from: t.from,
      act: t.act,
      body: t.body,
      ts: t.ts,
    })),
    ...(h.budget ? { budget: h.budget } : {}),
    closed: h.closed
      ? { at: h.closed.at, by: h.closed.by, anchor_ref: h.closed.anchorRef ?? null }
      : null,
  };
}
