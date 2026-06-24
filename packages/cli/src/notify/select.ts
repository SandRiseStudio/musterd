import type { Availability, Envelope } from '@musterd/protocol';
import { openActionNeeded } from '../render/rows.js';
import type { NotifyItem } from './os.js';

/** An envelope carrying the `urgent` breakthrough flag (SPEC A.6a; ADR 044). */
export function isUrgent(env: Envelope): boolean {
  return env.meta?.['urgent'] === true;
}

/**
 * The messages for `me` to notify this run, after recipient-side **tiering** (SPEC A.6a; ADR 044).
 * {@link openActionNeeded} (ADR 024/025) is the **Loud** set (directed acts, still-open); availability
 * then gates it:
 *   - `available` — pass Loud (directed). (the ADR 035 baseline)
 *   - `dnd`       — hold quiet, pass Loud (directed) + `urgent`.
 *   - `away`      — hold everything except an `urgent` breakthrough.
 * `urgent` pierces every tier. Two dedup layers as before: {@link openActionNeeded} is correct across
 * runs (an item is a candidate only while unread-and-unresolved, so reading the inbox drops it) and
 * `seen` is non-nagging within a run (ADR 035 §2). Pure.
 */
export function pendingToNotify(
  messages: Envelope[],
  me: string,
  seen: Set<string>,
  availability?: Availability | null,
): Envelope[] {
  const status = availability?.status ?? 'available';
  // away holds the Loud set too; available/dnd pass it. (dnd "holds quiet" — quiet was never a
  // candidate here, since notify only ever considers the Loud/directed set + urgent.)
  const loud = status === 'away' ? [] : openActionNeeded(messages, me);
  const urgent = messages.filter(isUrgent); // breakthrough at every tier
  const byId = new Map<string, Envelope>();
  for (const env of [...loud, ...urgent]) byId.set(env.id, env);
  return [...byId.values()].filter((env) => !seen.has(env.id));
}

/** Friendly verb for the notification title, by act. Matches the A.6a Loud set. */
function verb(env: Envelope): string {
  switch (env.act) {
    case 'request_help':
      return 'needs help';
    case 'handoff':
      return 'handed off to you';
    case 'accept':
      return 'accepted your request';
    case 'decline':
      return 'declined your request';
    default:
      return 'messaged you';
  }
}

/** Render an envelope into an OS notification (title carries who+what, body carries the message). */
export function toNotifyItem(env: Envelope): NotifyItem {
  return {
    id: env.id,
    title: `musterd · ${env.from} ${verb(env)}`,
    body: env.body || `(${env.act})`,
  };
}

/** The side effects a single poll needs, injected so the loop is testable without a daemon/desktop. */
export interface NotifyDeps {
  /** Whose inbox this is. */
  me: string;
  /** The current unread messages (one inbox read off the durable cursor). */
  inbox: () => Promise<Envelope[]>;
  /** Is the human reachable in-stream right now (a live `inbox --watch`/app presence)? */
  isReachable: () => Promise<boolean>;
  /** The recipient's self-declared availability, for tiering (null = implicit-available; ADR 044). */
  availability: () => Promise<Availability | null>;
  /** Fire one OS notification. */
  notify: (n: NotifyItem) => void;
}

/**
 * One poll: read the unread inbox, pick the not-yet-seen open action-needed items, and — unless the
 * human is actively watching (the bell/banner already reached them, ADR 024 piece A) — fire an OS
 * notification for each. Every candidate is marked `seen` regardless of whether it fired, so a
 * watch-suppressed item is treated as already-reached and the next poll doesn't re-check it (ADR 035).
 * Returns what it fired (for tests / a future verbose mode).
 */
export async function pollOnce(deps: NotifyDeps, seen: Set<string>): Promise<NotifyItem[]> {
  const availability = await deps.availability();
  const pending = pendingToNotify(await deps.inbox(), deps.me, seen, availability);
  if (pending.length === 0) return [];
  // One reachability read for the whole batch — the posture is the human's, not per-message.
  const reachable = await deps.isReachable();
  const fired: NotifyItem[] = [];
  for (const env of pending) {
    seen.add(env.id);
    if (reachable) continue;
    const item = toNotifyItem(env);
    deps.notify(item);
    fired.push(item);
  }
  return fired;
}
