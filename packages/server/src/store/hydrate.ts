import type { Envelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { getMemberById } from './members.js';
import { rowToEnvelope } from './messages.js';
import type { MessageRow } from './rows.js';

/**
 * Turn message rows into Envelopes, asking each DISTINCT member for its name once.
 *
 * Every call site used to do this inline, one `getMemberById` per row per party — thousands of
 * statements to learn tens of names (measured: 800 statements for 31 names on revive). The rows in a
 * window come from a team with tens of members, so the per-row shape was always asking the same few
 * questions over and over.
 *
 * It is worth a named helper rather than a local memo because of WHERE these hydrations run. The
 * daemon is single-threaded over synchronous better-sqlite3, so time any handler holds is time
 * `/health` waits — and the guardian reports `daemon_down` when `/health` misses its timeout. Four of
 * those alarms were false for exactly this reason. `/inbox/interrupt-check` is the sharpest case: a
 * PostToolUse hook calls it at every tool boundary of every live agent, and it is documented sub-50ms.
 *
 * The memo lives for one call. Membership cannot change underneath a single derivation — these all
 * read a window that was already fetched — so there is no cache to invalidate and no staleness to
 * reason about. A missing member row yields `'?'` for a sender and `null` for a recipient, which is
 * what the per-row hydration did.
 */
export function rowsToEnvelopes(db: Database, teamSlug: string, rows: MessageRow[]): Envelope[] {
  const names = new Map<string, string | undefined>();
  const nameOf = (id: string): string | undefined => {
    if (!names.has(id)) names.set(id, getMemberById(db, id)?.name);
    return names.get(id);
  };
  return rows.map((r) =>
    rowToEnvelope(
      r,
      teamSlug,
      nameOf(r.from_member) ?? '?',
      r.to_member ? (nameOf(r.to_member) ?? null) : null,
    ),
  );
}
