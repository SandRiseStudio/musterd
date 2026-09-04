import type { Act } from './acts.wire.js';
import { eligibleOf } from './envelope.js';
import type { Envelope } from './envelope.js';

/**
 * The huddle lens (ADR 378): fold an envelope timeline into the huddles it contains.
 *
 * A huddle is a thread, so there is nothing to fetch and nothing stored — the same rows the inbox
 * already holds are the transcript. This is what makes the "room" a VIEW rather than a second
 * message system: the log stays the transport, and a room is a way of looking at part of it.
 *
 * It shipped CLI-local, on the reasoning that a fold over envelopes is a rendering concern. That
 * was half right and the half that was wrong is the half that matters: what the CLI DRAWS is its
 * own (colour, `ago()`, the summary line), but WHAT A HUDDLE IS — which rows belong to it, who is
 * in it, whether it is closed — is a reading of the wire, and every surface must answer it the same
 * way or the same room is two different rooms. The MCP surface is the second reader (an agent is
 * told a turn belongs to a room), so the fold moves here beside `HuddleMetaSchema`, which is the
 * thing it folds. Still pure, still stores nothing, still fetches nothing.
 */
export interface HuddleTurn {
  id: string;
  from: string;
  act: Act;
  body: string;
  ts: number;
}

export interface HuddleView {
  /** The opening act's id — the huddle id, and the thread every turn names. */
  id: string;
  topic: string;
  room: string;
  anchor: string;
  opener: string;
  openedAt: number;
  body: string;
  /** Declared, never enforced: readers display it, the participants own it (ADR 378 §4). */
  budget?: { turns?: number; until?: number };
  turns: HuddleTurn[];
  /** Named at the root (an eligible set, or a directed `to`), plus the opener. */
  named: string[];
  /** Everyone who has actually spoken, opener first. */
  spoke: string[];
  /** Set once a `resolve` closes the thread; its `meta.anchor_ref` is where the artifact landed. */
  closed?: { at: number; by: string; anchorRef: string | undefined };
  /** Is `me` a participant — named at the root, the opener, or someone who has taken a turn. */
  mine: boolean;
}

interface RawHuddle {
  topic?: { kind?: string; id?: string };
  room?: string;
  anchor?: string;
  budget?: { turns?: number; until?: number };
}

function huddleMeta(env: Envelope): RawHuddle | undefined {
  const raw = (env.meta as { huddle?: unknown } | null | undefined)?.['huddle'];
  return raw && typeof raw === 'object' ? (raw as RawHuddle) : undefined;
}

/** Every huddle in this timeline, newest first. `me` decides only the `mine` flag. */
export function deriveHuddles(messages: Envelope[], me: string): HuddleView[] {
  const views: HuddleView[] = [];
  for (const root of messages) {
    const huddle = huddleMeta(root);
    if (!huddle?.topic?.kind || !huddle.topic.id) continue;

    const thread = messages
      .filter((m) => m.thread === root.id)
      .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts - b.ts));
    const closer = thread.find((m) => m.act === 'resolve');
    const turns = thread.filter((m) => m.act !== 'resolve');

    const named = eligibleOf(root.meta as Record<string, unknown> | null | undefined) ?? [];
    const directed = root.to.kind === 'member' ? [root.to.name] : [];
    const namedAll = [...new Set([root.from, ...named, ...directed])];
    const spoke = [...new Set([root.from, ...turns.map((t) => t.from)])];

    views.push({
      id: root.id,
      topic: `${huddle.topic.kind}:${huddle.topic.id}`,
      room: huddle.room ?? '',
      anchor: huddle.anchor ?? '',
      opener: root.from,
      openedAt: root.ts,
      body: root.body,
      ...(huddle.budget ? { budget: huddle.budget } : {}),
      turns: turns.map((t) => ({ id: t.id, from: t.from, act: t.act, body: t.body, ts: t.ts })),
      named: namedAll,
      spoke,
      ...(closer
        ? {
            closed: {
              at: closer.ts,
              by: closer.from,
              anchorRef: (closer.meta as { anchor_ref?: string } | null | undefined)?.[
                'anchor_ref'
              ],
            },
          }
        : {}),
      mine: namedAll.includes(me) || spoke.includes(me),
    });
  }
  return views.sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * Thread id → topic label, for every huddle in the timeline. What the inbox needs to stop rendering
 * a turn as a loose message from a teammate: a turn carries no huddle meta of its own (ADR 378 §2),
 * so the only way to know it belongs to a room is to have seen the root.
 */
export function huddleTopics(messages: Envelope[]): Map<string, string> {
  const topics = new Map<string, string>();
  for (const env of messages) {
    const huddle = huddleMeta(env);
    if (huddle?.topic?.kind && huddle.topic.id) {
      topics.set(env.id, `${huddle.topic.kind}:${huddle.topic.id}`);
    }
  }
  return topics;
}
